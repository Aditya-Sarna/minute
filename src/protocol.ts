import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, playgroundForChannel, repoLabel } from "./config.js";
import { classifyRequest } from "./classify.js";
import { applySmallestChange } from "./agent.js";
import { ensureWorkspace, commitAll, pushBranch } from "./git.js";
import { commentProof, openPr, prBody, updatePrBody } from "./github.js";
import { captureAfter, captureBefore } from "./preview.js";
import { claimRun, getRun, newRunId, saveRun } from "./store.js";
import { log } from "./logger.js";
import { LIMITS } from "./limits.js";
import { llmConfigured } from "./llm.js";
import type { ChatAdapter } from "./surfaces/types.js";
import type { Attachment, Playground, Proof, Run, Surface } from "./types.js";

function techMentions(surface: Surface, adapter: ChatAdapter): string {
  const cfg = loadConfig();
  const ids = surface === "slack" ? cfg.tech.slackUserIds : cfg.tech.discordUserIds;
  if (!ids.length) return "tech";
  return ids.map((id) => adapter.mention(id)).join(" ");
}

function titleFor(summary: string): string {
  return `minute: ${summary.replace(/\s+/g, " ").trim().slice(0, 72)}`;
}

async function status(run: Run, chat: ChatAdapter, text: string) {
  run.statusMessageId = await chat.postOrUpdateStatus(text, run.statusMessageId);
  saveRun(run);
}

export function createRunDraft(opts: {
  surface: Surface;
  channelId: string;
  threadId: string;
  parentMessageId: string;
  requesterId: string;
  requesterName: string;
  playgroundId: string;
  text: string;
}): Run {
  const id = newRunId();
  const run: Run = {
    id,
    surface: opts.surface,
    channelId: opts.channelId,
    threadId: opts.threadId,
    parentMessageId: opts.parentMessageId,
    requesterId: opts.requesterId,
    requesterName: opts.requesterName,
    playgroundId: opts.playgroundId,
    request: opts.text,
    status: "classifying",
    branch: id,
    iterationCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return saveRun(run);
}

export async function startRun(opts: {
  run: Run;
  attachments?: Attachment[];
  chat: ChatAdapter;
}): Promise<Run> {
  const run = getRun(opts.run.id) ?? opts.run;
  const playground = playgroundForChannel(run.surface, run.channelId) ?? playgroundById(run.playgroundId);
  if (!playground) {
    await opts.chat.postRefuse(
      "This channel isn’t a Minute playground. An admin maps a channel → repo in minute.config.yaml.",
    );
    run.status = "refused";
    run.exitReason = "no playground";
    saveRun(run);
    return run;
  }
  if (!llmConfigured()) {
    await opts.chat.postRefuse("Minute isn’t configured — missing ANTHROPIC_API_KEY or OPENAI_API_KEY.");
    run.status = "refused";
    saveRun(run);
    return run;
  }
  if (!process.env.GITHUB_TOKEN) {
    await opts.chat.postRefuse("Minute isn’t configured — missing GITHUB_TOKEN.");
    run.status = "refused";
    saveRun(run);
    return run;
  }

  await status(run, opts.chat, `Working · ${repoLabel(playground)} · simple change only.`);

  try {
    const gate = await classifyRequest(run.request, playground);
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
      request: run.request,
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
  const current = getRun(opts.run.id) ?? opts.run;
  const claimed =
    current.status === "working" ? current : claimRun(opts.run.id, "proof", "working");
  if (!claimed || claimed.status !== "working") return;
  const playground = playgroundById(claimed.playgroundId);
  if (!playground) return;

  const nextCount = (claimed.iterationCount ?? 0) + 1;
  if (nextCount > LIMITS.iterations) {
    claimed.status = "proof";
    saveRun(claimed);
    await opts.chat.postRefuse(
      `That’s enough tweaks for this Minute. Tap Looks good, or ping tech — more than ${LIMITS.iterations} rounds isn’t simple.`,
    );
    return;
  }
  claimed.iterationCount = nextCount;
  claimed.request = `${claimed.request}\n\nTweak: ${opts.text}`;
  saveRun(claimed);
  await status(claimed, opts.chat, "Updating the same change…");

  try {
    await executeChange(claimed, playground, opts.chat, {
      request: opts.text,
      prior: claimed.request,
      attachments: opts.attachments,
      iterate: true,
    });
  } catch (err) {
    log.error({ err, runId: claimed.id }, "iterate failed");
    claimed.status = "proof";
    saveRun(claimed);
    await opts.chat.postRefuse(
      `Couldn’t apply that tweak: ${err instanceof Error ? err.message : String(err)}. Try a simpler reply, or cancel.`,
    );
  }
}

export async function handoffRun(run: Run, chat: ChatAdapter): Promise<void> {
  const claimed = claimRun(run.id, "proof", "handed_off");
  if (!claimed) {
    await chat.postOrUpdateStatus("Nothing to hand off yet.", run.statusMessageId);
    return;
  }
  const playground = playgroundById(claimed.playgroundId);
  if (!playground || !claimed.prNumber) {
    claimed.status = "proof";
    saveRun(claimed);
    await chat.postRefuse("No PR yet.");
    return;
  }

  const proof: Proof = {
    caption: "Visual sign-off",
    route: playground.preview.defaultRoute,
    filesChanged: [],
    afterPath: claimed.lastProofPath,
  };
  await updatePrBody(
    playground,
    claimed.prNumber,
    prBody({
      playground,
      run: claimed,
      summary: "Stakeholder signed off visually.",
      proof,
      signedOff: true,
    }),
  );
  if (claimed.lastProofPath) {
    const raw = `https://github.com/${playground.github.owner}/${playground.github.repo}/blob/${claimed.branch}/.minute/${claimed.id}-after.png?raw=true`;
    await commentProof(
      playground,
      claimed.prNumber,
      proof,
      `**Visual sign-off by ${claimed.requesterName}.** Review on technical grounds.\n\n![after](${raw})`,
    );
  }

  await status(claimed, chat, "Handed to tech.");
  await chat.postHandoff(claimed, techMentions(claimed.surface, chat));
}

export async function cancelRun(run: Run, chat: ChatAdapter, reason?: string): Promise<void> {
  const current = getRun(run.id) ?? run;
  if (current.status === "exited" || current.status === "refused") return;
  current.status = "exited";
  current.exitReason = reason || "Cancelled.";
  saveRun(current);
  await chat.postExit(current.exitReason);
}

export async function exitFromGithub(
  run: Run,
  chat: ChatAdapter,
  kind: "changes_requested" | "closed",
): Promise<void> {
  const current = getRun(run.id) ?? run;
  if (current.status !== "handed_off") return;
  const reason =
    kind === "closed"
      ? "PR was closed without merge. Minute is done — talk to each other if you still need this."
      : "Tech disapproved (changes requested). Minute is done. Talk it through and improve the PR by hand if it isn’t architecturally feasible.";
  current.status = "exited";
  current.exitReason = reason;
  saveRun(current);
  await chat.postExit(reason);
}

export async function mergedFromGithub(run: Run, chat: ChatAdapter): Promise<void> {
  const current = getRun(run.id) ?? run;
  if (current.status !== "handed_off") return;
  current.status = "exited";
  current.exitReason = "Merged.";
  saveRun(current);
  await chat.postOrUpdateStatus("Merged. Minute is done.", current.statusMessageId);
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
  const dir = await ensureWorkspace({
    runId: run.id,
    playground,
    branch: run.branch,
    createBranch: !opts.iterate,
  });
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
  await status(run, chat, "Preview ready. Photo is in the thread.");
  await chat.postProof(proof, run);
}
