import { loadConfig } from "./config.js";
import { activeRuns, getRun } from "./store.js";
import { exitFromGithub, mergedFromGithub } from "./protocol.js";
import { getPr, listReviews } from "./github.js";
import { log } from "./logger.js";
import type { ChatAdapter } from "./surfaces/types.js";
import type { Run } from "./types.js";

export type AdapterLookup = (run: Run) => Promise<ChatAdapter | null>;

const seen = new Set<string>();

export function startGithubWatch(lookup: AdapterLookup) {
  const tick = async () => {
    for (const run of activeRuns()) {
      const playground = loadConfig().playgrounds.find((p) => p.id === run.playgroundId);
      if (!playground || !run.prNumber) continue;
      try {
        const pr = await getPr(playground, run.prNumber);
        const key = (s: string) => `${run.id}:${s}`;

        if (pr.data.merged) {
          if (seen.has(key("merged"))) continue;
          seen.add(key("merged"));
          const chat = await lookup(getRun(run.id) ?? run);
          if (chat) await mergedFromGithub(getRun(run.id) ?? run, chat);
          continue;
        }
        if (pr.data.state === "closed") {
          if (seen.has(key("closed"))) continue;
          seen.add(key("closed"));
          const chat = await lookup(getRun(run.id) ?? run);
          if (chat) await exitFromGithub(getRun(run.id) ?? run, chat, "closed");
          continue;
        }
        const reviews = await listReviews(playground, run.prNumber);
        const rejected = reviews.find((r) => r.state === "CHANGES_REQUESTED");
        if (rejected) {
          if (seen.has(key("changes"))) continue;
          seen.add(key("changes"));
          const chat = await lookup(getRun(run.id) ?? run);
          if (chat) await exitFromGithub(getRun(run.id) ?? run, chat, "changes_requested");
        }
      } catch (err) {
        log.warn({ err, runId: run.id }, "github watch");
      }
    }
  };

  setInterval(() => void tick(), 20_000);
  void tick();
}
