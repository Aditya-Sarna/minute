import { loadConfig } from "./config.js";
import { handedOffRuns, getRun } from "./store.js";
import { enqueueGithub } from "./jobs.js";
import { getPr, listReviews } from "./github.js";
import { log } from "./logger.js";

const seen = new Set<string>();

export function startGithubWatch() {
  const tick = async () => {
    for (const run of handedOffRuns()) {
      const playground = loadConfig().playgrounds.find((p) => p.id === run.playgroundId);
      if (!playground || !run.prNumber) continue;
      try {
        const pr = await getPr(playground, run.prNumber);
        const key = (s: string) => `${run.id}:${s}`;
        const live = getRun(run.id) ?? run;
        if (live.status !== "handed_off") continue;

        if (pr.data.merged) {
          if (seen.has(key("merged"))) continue;
          seen.add(key("merged"));
          enqueueGithub(live.id, "merged");
          continue;
        }
        if (pr.data.state === "closed") {
          if (seen.has(key("closed"))) continue;
          seen.add(key("closed"));
          enqueueGithub(live.id, "closed");
          continue;
        }
        const reviews = await listReviews(playground, run.prNumber);
        if (reviews.some((r) => r.state === "CHANGES_REQUESTED")) {
          if (seen.has(key("changes"))) continue;
          seen.add(key("changes"));
          enqueueGithub(live.id, "changes_requested");
        }
      } catch (err) {
        log.warn({ err, runId: run.id }, "github watch");
      }
    }
  };

  setInterval(() => void tick(), 30_000);
  void tick();
}
