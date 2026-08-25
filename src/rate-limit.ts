import { getDb } from "./db.js";
import { LIMITS } from "./limits.js";

const HOUR = 60 * 60 * 1000;

export function takeToken(key: string, maxPerHour: number): boolean {
  const db = getDb();
  const now = Date.now();
  const cutoff = now - HOUR;
  db.prepare("DELETE FROM rate_events WHERE ts < ?").run(cutoff);
  const row = db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE key = ? AND ts >= ?").get(
    key,
    cutoff,
  ) as { n: number };
  if (row.n >= maxPerHour) return false;
  db.prepare("INSERT INTO rate_events (key, ts) VALUES (?, ?)").run(key, now);
  return true;
}

export function takeStartToken(surface: string, userId: string): boolean {
  return takeToken(`start:${surface}:${userId}`, LIMITS.jobsPerUserHour);
}

export function takeIterateToken(surface: string, userId: string): boolean {
  return takeToken(`iterate:${surface}:${userId}`, LIMITS.iteratesPerUserHour);
}

export function rateLimitedMessage(): string {
  return "Minute is rate-limited for you this hour. Try again later, or ping tech.";
}
