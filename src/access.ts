import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "./config.js";
import type { Surface } from "./types.js";

const FILE = resolve(".data/access.json");

type Overlay = {
  slackUserIds: string[];
  discordUserIds: string[];
};

function empty(): Overlay {
  return { slackUserIds: [], discordUserIds: [] };
}

function read(): Overlay {
  try {
    return { ...empty(), ...(JSON.parse(readFileSync(FILE, "utf8")) as Overlay) };
  } catch {
    return empty();
  }
}

function write(overlay: Overlay) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(overlay, null, 2));
}

export function isAdmin(surface: Surface, userId: string): boolean {
  const cfg = loadConfig();
  const ids =
    surface === "slack" ? cfg.admins.slackUserIds : cfg.admins.discordUserIds;
  return ids.includes(userId);
}

export function isRequester(surface: Surface, userId: string): boolean {
  if (isAdmin(surface, userId)) return true;
  const cfg = loadConfig();
  const overlay = read();
  if (surface === "slack") {
    return (
      cfg.requesters.slackUserIds.includes(userId) ||
      overlay.slackUserIds.includes(userId)
    );
  }
  return (
    cfg.requesters.discordUserIds.includes(userId) ||
    overlay.discordUserIds.includes(userId)
  );
}

export function grant(surface: Surface, userId: string): void {
  const overlay = read();
  const key = surface === "slack" ? "slackUserIds" : "discordUserIds";
  if (!overlay[key].includes(userId)) overlay[key].push(userId);
  write(overlay);
}

export function revoke(surface: Surface, userId: string): void {
  const overlay = read();
  const key = surface === "slack" ? "slackUserIds" : "discordUserIds";
  overlay[key] = overlay[key].filter((id) => id !== userId);
  write(overlay);
}

export function listGranted(surface: Surface): string[] {
  const cfg = loadConfig();
  const overlay = read();
  if (surface === "slack") {
    return [...new Set([...cfg.requesters.slackUserIds, ...overlay.slackUserIds])];
  }
  return [...new Set([...cfg.requesters.discordUserIds, ...overlay.discordUserIds])];
}

export function denyMessage(): string {
  return "You don’t have Minute access — ask an admin to `/minute-admin allow` you.";
}
