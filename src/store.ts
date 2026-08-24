import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Run, Surface } from "./types.js";

const FILE = resolve(".data/runs.json");

type Db = { runs: Run[] };

function empty(): Db {
  return { runs: [] };
}

function read(): Db {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Db;
  } catch {
    return empty();
  }
}

function write(db: Db) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(db, null, 2));
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  return `minute-${stamp}-${randomBytes(3).toString("hex")}`;
}

export function saveRun(run: Run): Run {
  const db = read();
  const i = db.runs.findIndex((r) => r.id === run.id);
  run.updatedAt = new Date().toISOString();
  if (i >= 0) db.runs[i] = run;
  else db.runs.push(run);
  write(db);
  return run;
}

export function getRun(id: string): Run | undefined {
  return read().runs.find((r) => r.id === id);
}

export function runByThread(surface: Surface, threadId: string): Run | undefined {
  return read()
    .runs.filter((r) => r.surface === surface && r.threadId === threadId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function activeRuns(): Run[] {
  return read().runs.filter((r) => r.status === "handed_off" && r.prNumber);
}

export function listRuns(): Run[] {
  return read().runs;
}
