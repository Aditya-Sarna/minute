import { loadConfig, playgroundForChannel, repoLabel } from "./config.js";
import { classifyRequest } from "./classify.js";
import { applySmallestChange } from "./agent.js";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { checkout, commitAll, pushBranch } from "./git.js";
import { commentProof, openPr, prBody, updatePrBody } from "./github.js";
import { captureAfter, captureBefore } from "./preview.js";
import { getRun, newRunId, saveRun } from "./store.js";
import { log } from "./logger.js";
import type { ChatAdapter } from "./surfaces/types.js";
import type { Attachment, Playground, Proof, Run, Surface } from "./types.js";
import { llmConfigured } from "./llm.js";

function techMentions(surface: Surface, adapter: ChatAdapter): string {
  const cfg = loadConfig();
  const ids = surface === "slack" ? cfg.tech.slackUserIds : cfg.tech.discordUserIds;
  if (!ids.length) return "tech";
  return ids.map((id) => adapter.mention(id)).join(" ");
}

function titleFor(summary: string): string {
  const t = summary.replace(/\s+/g, " ").trim().slice(0, 72);
  return `minute: ${t}`;
}

export async function startRun(opts: {
  surface: Surface;
  channelId: string;
  threadId: string;
  parentMessageId: string;
  requesterId: string;
  requesterName: string;
  text: string;
  attachments?: Attachment[];
  chat: ChatAdapter;
}): Promise<Run> {
  const playground = playgroundForChannel(opts.surface, opts.channelId);
  if (!playground) {
    await opts.chat.postRefuse(
      "This channel isn’t a Minute playground. An admin maps a channel → repo in minute.config.yaml.",
    );
    throw new Error("no playground");
  }
  if (!llmConfigured()) {
    await opts.chat.postRefuse("Minute isn’t configured — missing ANTHROPIC_API_KEY or OPENAI_API_KEY.");
    throw new Error("no llm");
  }
  if (!process.env.GITHUB_TOKEN) {
    await opts.chat.postRefuse("Minute isn’t configured — missing GITHUB_TOKEN.");
    throw new Error("no github");
  }

  const run: Run = {
    id: newRunId(),
    surface: opts.surface,
    channelId: opts.channelId,
    threadId: opts.threadId,
    parentMessageId: opts.parentMessageId,
    requesterId: opts.requesterId,
    requesterName: opts.requesterName,
    playgroundId: playground.id,
    request: opts.text,
    status: "classifying",
    branch: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  run.branch = run.id;
  saveRun(run);

  await opts.chat.postStatus(
    `Working · ${repoLabel(playground)} · simple change only. Reply here to tweak once you see the photo.`,
  );

  try {
    const gate = await classifyRequest(opts.text, playground);
    if (!gate.ok) {
      run.status = "refused";
      run.exitReason = gate.reason;
      saveRun(run);
      await opts.chat.postRefuse(gate.reason);
      return run;
    }

    run.status = "working";
    saveRun(run);
    await executeChange(run, playground, opts.chat, {
      request: opts.text,
      route: gate.route,
      attachments: opts.attachments,
    });
    return getRun(run.id) ?? run;
  } catch (err) {
    log.error({ err, runId: run.id }, "startRun failed");
    run.status = "exited";
    run.exitReason = err instanceof Error ? err.message : String(err);
    saveRun(run);
    await opts.chat.postRefuse(
      `Couldn’t finish this Minute: ${run.exitReason}. If you still need it, ping tech — that’s outside Minute.`,
    );
    return run;
  }
}

export async function iterateRun(opts: {
  run: Run;
  text: string;
  attachments?: Attachment[];
  chat: ChatAdapter;
}): Promise<void> {
  if (opts.run.status !== "proof") {
    return;
  }
  const playground = playgroundById(opts.run.playgroundId);
  if (!playground) return;

  opts.run.status = "working";
  opts.run.request = `${opts.run.request}\n\nTweak: ${opts.text}`;
  saveRun(opts.run);
  await opts.chat.postStatus("Updating the same change…");

  try {
    await executeChange(opts.run, playground, opts.chat, {
      request: opts.text,
      prior: opts.run.request,
      attachments: opts.attachments,
      iterate: true,
    });
  } catch (err) {
    log.error({ err, runId: opts.run.id }, "iterate failed");
    await opts.chat.postStatus(
      `Couldn’t apply that tweak: ${err instanceof Error ? err.message : String(err)}. Try a simpler reply, or cancel.`,
    );
    opts.run.status = "proof";
    saveRun(opts.run);
  }
}

export async function handoffRun(run: Run, chat: ChatAdapter): Promise<void> {
  if (run.status !== "proof") {
    await chat.postStatus("Nothing to hand off yet.");
    return;
  }
  const playground = playgroundById(run.playgroundId);
  if (!playground || !run.prNumber) {
    await chat.postStatus("No PR yet.");
    return;
  }

  run.status = "handed_off";
  saveRun(run);

  const proof: Proof = {
    caption: "Visual sign-off",
    route: playground.preview.defaultRoute,
    filesChanged: [],
    afterPath: run.lastProofPath,
  };
  await updatePrBody(
    playground,
    run.prNumber,
    prBody({
      playground,
      run,
      summary: "Stakeholder signed off visually.",
      proof,
      signedOff: true,
    }),
  );
  if (run.lastProofPath) {
    const raw = `https://github.com/${playground.github.owner}/${playground.github.repo}/blob/${run.branch}/.minute/${run.id}-after.png?raw=true`;
    await commentProof(
      playground,
      run.prNumber,
      proof,
      `**Visual sign-off by ${run.requesterName}.** Review on technical grounds.\n\n![after](${raw})`,
    );
  }

  await chat.postHandoff(run, techMentions(run.surface, chat));
}

export async function cancelRun(run: Run, chat: ChatAdapter, reason?: string): Promise<void> {
  if (run.status === "exited" || run.status === "refused") return;
  run.status = "exited";
  run.exitReason = reason || "Cancelled.";
  saveRun(run);
  await chat.postExit(run.exitReason);
}

export async function exitFromGithub(
  run: Run,
  chat: ChatAdapter,
  kind: "changes_requested" | "closed",
): Promise<void> {
  if (run.status !== "handed_off") return;
  const reason =
    kind === "closed"
      ? "PR was closed without merge. Minute is done — talk to each other if you still need this."
      : "Tech disapproved (changes requested). Minute is done. Talk it through and improve the PR by hand if it isn’t architecturally feasible.";
  run.status = "exited";
  run.exitReason = reason;
  saveRun(run);
  await chat.postExit(reason);
}

export async function mergedFromGithub(run: Run, chat: ChatAdapter): Promise<void> {
  if (run.status !== "handed_off") return;
  run.status = "exited";
  run.exitReason = "Merged.";
  saveRun(run);
  await chat.postStatus("Merged. Minute is done.");
}

function playgroundById(id: string): Playground | undefined {
  return loadConfig().playgrounds.find((p) => p.id === id);
}

async function executeChange(
  run: Run,
  playground: Playground,
  chat: ChatAdapter,
  opts: {
    request: string;
    prior?: string;
    route?: string;
    attachments?: Attachment[];
    iterate?: boolean;
  },
) {
  const dir = run.workspaceDir || (await checkout(run.id, playground, run.branch));
  run.workspaceDir = dir;
  saveRun(run);

  const route = opts.route || playground.preview.defaultRoute || "/";
  const before = opts.iterate ? undefined : await captureBefore(run.id, playground, route);

  const result = await applySmallestChange({
    root: dir,
    playground,
    request: opts.request,
    prior: opts.prior,
    attachments: opts.attachments,
  });

  const after = await captureAfter({
    runId: run.id,
    playground,
    workspaceDir: dir,
    route: result.routeHint || route,
  });

  if (after.path) {
    const destDir = join(dir, ".minute");
    mkdirSync(destDir, { recursive: true });
    copyFileSync(after.path, join(destDir, `${run.id}-after.png`));
    if (before) copyFileSync(before, join(destDir, `${run.id}-before.png`));
  }

  await commitAll(dir, `minute: ${result.summary}`);
  await pushBranch(dir, run.branch);

  const proof: Proof = {
    beforePath: before,
    afterPath: after.path,
    caption: result.summary,
    route: result.routeHint || route,
    filesChanged: result.files.filter((f) => !f.startsWith(".minute/")),
    skippedReason: after.skippedReason,
  };
  run.lastProofPath = after.path;
  saveRun(run);

  const body = prBody({
    playground,
    run,
    summary: result.summary,
    proof,
    signedOff: false,
  });

  if (!run.prNumber) {
    const pr = await openPr({
      playground,
      run,
      title: titleFor(result.summary),
      body,
    });
    run.prNumber = pr.number;
    run.prUrl = pr.url;
  } else {
    await updatePrBody(playground, run.prNumber, body);
  }

  run.status = "proof";
  saveRun(run);
  await chat.postProof(proof, run);
}
