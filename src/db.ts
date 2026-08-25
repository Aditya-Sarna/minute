import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir } from "./limits.js";

let db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (!db) db = openDb();
  return db;
}

export function openDb(file?: string): DatabaseSync {
  const path = file ?? resolve(dataDir(), "minute.sqlite");
  mkdirSync(resolve(path, ".."), { recursive: true });
  const opened = new DatabaseSync(path);
  opened.exec("PRAGMA journal_mode = WAL");
  opened.exec("PRAGMA busy_timeout = 5000");
  opened.exec("PRAGMA foreign_keys = ON");
  opened.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      surface TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      pr_number INTEGER,
      playground_id TEXT,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(surface, thread_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_pr ON runs(pr_number);

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      run_id TEXT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_pick ON jobs(status, available_at);

    CREATE TABLE IF NOT EXISTS access_overlay (
      surface TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (surface, user_id)
    );

    CREATE TABLE IF NOT EXISTS rate_events (
      key TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rate ON rate_events(key, ts);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL
    );
  `);
  db = opened;
  return opened;
}

export function closeDb() {
  db?.close();
  db = undefined;
}

export function resetDbForTests(file: string) {
  closeDb();
  return openDb(file);
}
