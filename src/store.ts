import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import type { Run, RunStatus, Surface } from "./types.js";

const BUSY: RunStatus[] = ["classifying", "working"];

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  return `minute-${stamp}-${randomBytes(3).toString("hex")}`;
}

export function saveRun(run: Run): Run {
  run.updatedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO runs (id, status, surface, thread_id, pr_number, playground_id, data, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         thread_id = excluded.thread_id,
         pr_number = excluded.pr_number,
         playground_id = excluded.playground_id,
         data = excluded.data,
         updated_at = excluded.updated_at`,
    )
    .run(
      run.id,
      run.status,
      run.surface,
      run.threadId,
      run.prNumber ?? null,
      run.playgroundId,
      JSON.stringify(run),
      run.updatedAt,
    );
  return run;
}

function parse(row: { data: string } | undefined): Run | undefined {
  if (!row) return undefined;
  return JSON.parse(row.data) as Run;
}

export function getRun(id: string): Run | undefined {
  const row = getDb().prepare("SELECT data FROM runs WHERE id = ?").get(id) as { data: string } | undefined;
  return parse(row);
}

export function runByThread(surface: Surface, threadId: string): Run | undefined {
  const row = getDb()
    .prepare(
      "SELECT data FROM runs WHERE surface = ? AND thread_id = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(surface, threadId) as { data: string } | undefined;
  return parse(row);
}

export function busyRunInThread(surface: Surface, threadId: string): Run | undefined {
  const run = runByThread(surface, threadId);
  if (run && BUSY.includes(run.status)) return run;
  return undefined;
}

export function claimRun(id: string, from: RunStatus, to: RunStatus): Run | undefined {
  const run = getRun(id);
  if (!run || run.status !== from) return undefined;
  run.status = to;
  run.updatedAt = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE runs SET status = ?, data = ?, updated_at = ?
       WHERE id = ? AND status = ?`,
    )
    .run(to, JSON.stringify(run), run.updatedAt, id, from);
  if (!result.changes) return undefined;
  return getRun(id);
}

export function handedOffRuns(): Run[] {
  const rows = getDb().prepare("SELECT data FROM runs WHERE status = 'handed_off'").all() as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as Run);
}

export function runByPrNumber(prNumber: number): Run | undefined {
  const row = getDb()
    .prepare("SELECT data FROM runs WHERE pr_number = ? ORDER BY updated_at DESC LIMIT 1")
    .get(prNumber) as { data: string } | undefined;
  return parse(row);
}

export function seenWebhook(id: string): boolean {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM webhook_deliveries WHERE id = ?").get(id);
  if (existing) return true;
  db.prepare("INSERT INTO webhook_deliveries (id, received_at) VALUES (?, ?)").run(
    id,
    new Date().toISOString(),
  );
  return false;
}
