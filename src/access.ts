import { loadConfig } from "./config.js";
import { getDb } from "./db.js";
import type { Surface } from "./types.js";

export function isAdmin(surface: Surface, userId: string): boolean {
  const cfg = loadConfig();
  const ids = surface === "slack" ? cfg.admins.slackUserIds : cfg.admins.discordUserIds;
  return ids.includes(userId);
}

export function isRequester(surface: Surface, userId: string): boolean {
  if (isAdmin(surface, userId)) return true;
  const cfg = loadConfig();
  const granted = overlayIds(surface);
  if (surface === "slack") {
    return cfg.requesters.slackUserIds.includes(userId) || granted.includes(userId);
  }
  return cfg.requesters.discordUserIds.includes(userId) || granted.includes(userId);
}

export function grant(surface: Surface, userId: string): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO access_overlay (surface, user_id) VALUES (?, ?)")
    .run(surface, userId);
}

export function revoke(surface: Surface, userId: string): void {
  getDb().prepare("DELETE FROM access_overlay WHERE surface = ? AND user_id = ?").run(surface, userId);
}

function overlayIds(surface: Surface): string[] {
  const rows = getDb()
    .prepare("SELECT user_id FROM access_overlay WHERE surface = ?")
    .all(surface) as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

export function listGranted(surface: Surface): string[] {
  const cfg = loadConfig();
  const overlay = overlayIds(surface);
  const base = surface === "slack" ? cfg.requesters.slackUserIds : cfg.requesters.discordUserIds;
  return [...new Set([...base, ...overlay])];
}

export function denyMessage(): string {
  return "You don’t have Minute access — ask an admin to `/minute-admin allow` you.";
}
