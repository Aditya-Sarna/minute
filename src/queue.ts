import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { LIMITS } from "./limits.js";
import { log } from "./logger.js";

export type JobType = "start" | "iterate" | "handoff" | "cancel" | "github";

export type Job = {
  id: string;
  type: JobType;
  runId: string;
  payload: unknown;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
};

type Handler = (job: Job) => Promise<void>;

let stopping = false;
let inflight = 0;
let timer: ReturnType<typeof setInterval> | undefined;

export function enqueue(type: JobType, runId: string, payload: unknown = {}, delayMs = 0): string {
  const id = `job-${randomBytes(6).toString("hex")}`;
  getDb()
    .prepare(
      `INSERT INTO jobs (id, type, run_id, payload, status, attempts, available_at, created_at)
       VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)`,
    )
    .run(id, type, runId, JSON.stringify(payload), Date.now() + delayMs, new Date().toISOString());
  return id;
}

function pick(): Job | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, type, run_id, payload, status, attempts FROM jobs
       WHERE status = 'queued' AND available_at <= ?
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(Date.now()) as
    | {
        id: string;
        type: JobType;
        run_id: string;
        payload: string;
        status: string;
        attempts: number;
      }
    | undefined;
  if (!row) return undefined;
  const changed = db
    .prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ? AND status = 'queued'")
    .run(row.id);
  if (!changed.changes) return undefined;
  return {
    id: row.id,
    type: row.type,
    runId: row.run_id,
    payload: JSON.parse(row.payload),
    status: "running",
    attempts: row.attempts + 1,
  };
}

function finish(id: string, ok: boolean, error?: string) {
  if (ok) {
    getDb().prepare("UPDATE jobs SET status = 'done', error = NULL WHERE id = ?").run(id);
    return;
  }
  getDb().prepare("UPDATE jobs SET status = 'failed', error = ? WHERE id = ?").run(error ?? "failed", id);
}

export function startWorker(handler: Handler) {
  const tick = async () => {
    if (stopping) return;
    if (inflight >= LIMITS.maxConcurrentJobs) return;
    const job = pick();
    if (!job) return;
    inflight += 1;
    try {
      await Promise.race([
        handler(job),
        new Promise((_, reject) => setTimeout(() => reject(new Error("job timeout")), LIMITS.jobTimeoutMs)),
      ]);
      finish(job.id, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, jobId: job.id, type: job.type }, "job failed");
      if (job.attempts < 3 && !/timeout|refused|Blocked path|isn't a Minute/i.test(message)) {
        getDb()
          .prepare("UPDATE jobs SET status = 'queued', available_at = ?, error = ? WHERE id = ?")
          .run(Date.now() + 5_000 * job.attempts, message, job.id);
      } else {
        finish(job.id, false, message);
      }
    } finally {
      inflight -= 1;
    }
  };

  timer = setInterval(() => void tick(), 250);
  void tick();
}

export async function stopWorker(waitMs = 15_000) {
  stopping = true;
  if (timer) clearInterval(timer);
  const start = Date.now();
  while (inflight > 0 && Date.now() - start < waitMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function recoverStuckJobs() {
  getDb()
    .prepare("UPDATE jobs SET status = 'queued', available_at = ? WHERE status = 'running'")
    .run(Date.now());
}

export function inflightCount(): number {
  return inflight;
}
