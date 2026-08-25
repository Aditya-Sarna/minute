import { enqueue, startWorker, type Job } from "./queue.js";
import { getRun } from "./store.js";
import { startRun, iterateRun, handoffRun, cancelRun, exitFromGithub, mergedFromGithub } from "./protocol.js";
import { log } from "./logger.js";
import type { ChatAdapter } from "./surfaces/types.js";
import type { Attachment, Run } from "./types.js";

export type AdapterLookup = (run: Run) => Promise<ChatAdapter | null>;

export function enqueueStart(runId: string, attachments: Attachment[] = []) {
  return enqueue("start", runId, { attachments });
}

export function enqueueIterate(runId: string, text: string, attachments: Attachment[] = []) {
  return enqueue("iterate", runId, { text, attachments });
}

export function enqueueHandoff(runId: string) {
  return enqueue("handoff", runId, {});
}

export function enqueueCancel(runId: string, reason?: string) {
  return enqueue("cancel", runId, { reason });
}

export function enqueueGithub(runId: string, kind: "merged" | "closed" | "changes_requested") {
  return enqueue("github", runId, { kind });
}

export function startJobs(lookup: AdapterLookup) {
  startWorker(async (job: Job) => {
    const run = getRun(job.runId);
    if (!run) {
      log.warn({ job }, "job missing run");
      return;
    }
    const chat = await lookup(run);
    if (!chat) throw new Error(`no chat adapter for ${run.surface}`);
    const payload = job.payload as {
      attachments?: Attachment[];
      text?: string;
      reason?: string;
      kind?: "merged" | "closed" | "changes_requested";
    };

    if (job.type === "start") {
      await startRun({ run, attachments: payload.attachments, chat });
      return;
    }
    if (job.type === "iterate") {
      await iterateRun({ run, text: payload.text || "", attachments: payload.attachments, chat });
      return;
    }
    if (job.type === "handoff") {
      await handoffRun(run, chat);
      return;
    }
    if (job.type === "cancel") {
      await cancelRun(run, chat, payload.reason);
      return;
    }
    if (job.type === "github") {
      if (payload.kind === "merged") await mergedFromGithub(run, chat);
      else if (payload.kind === "closed" || payload.kind === "changes_requested") {
        await exitFromGithub(run, chat, payload.kind);
      }
    }
  });
}
