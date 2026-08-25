import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import { dataDir } from "./limits.js";
import { log } from "./logger.js";
import type { Playground } from "./types.js";

function shotPath(runId: string, label: string): string {
  const p = resolve(dataDir(), "proof", runId, `${label}.png`);
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

function joinUrl(base: string, route: string): string {
  try {
    return new URL(route || "/", base).toString();
  } catch {
    return `${base.replace(/\/$/, "")}${route.startsWith("/") ? route : `/${route}`}`;
  }
}

function portFromUrl(url: string): string {
  try {
    return new URL(url).port || "3000";
  } catch {
    return "3000";
  }
}

async function waitForUrl(url: string, seconds: number) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status < 500) return;
    } catch {
      // still booting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Preview never came up at ${url}`);
}

async function screenshotUrl(url: string, dest: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: dest, fullPage: true });
  } finally {
    await browser.close();
  }
}

function lockfileHash(dir: string): string | undefined {
  for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
    const p = join(dir, name);
    if (existsSync(p)) {
      return createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
    }
  }
  return undefined;
}

export function installDeps(dir: string, playground: Playground): void {
  if (!playground.preview.install) return;
  if (!existsSync(join(dir, "package.json"))) return;
  const marker = join(dir, ".minute-installed");
  if (existsSync(marker)) return;

  const hash = lockfileHash(dir);
  const cache = hash ? resolve(dataDir(), "npm-cache", hash, "node_modules") : undefined;
  const destModules = join(dir, "node_modules");
  if (cache && existsSync(cache) && !existsSync(destModules)) {
    cpSync(cache, destModules, { recursive: true });
    mkdirSync(marker, { recursive: true });
    return;
  }

  const timeout = (playground.preview.installTimeoutSeconds || 240) * 1000;
  const hasLock = existsSync(join(dir, "package-lock.json"));
  const args = hasLock
    ? ["ci", "--no-audit", "--no-fund"]
    : ["install", "--no-audit", "--no-fund"];
  const result = spawnSync("npm", args, {
    cwd: dir,
    timeout,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "development", CI: "true" },
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "npm install failed").slice(-2000);
    throw new Error(`npm install failed: ${err}`);
  }
  if (cache && existsSync(destModules)) {
    mkdirSync(dirname(cache), { recursive: true });
    rmSync(cache, { recursive: true, force: true });
    cpSync(destModules, cache, { recursive: true });
  }
  mkdirSync(marker, { recursive: true });
}

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 2000).unref();
}

export async function captureBefore(
  runId: string,
  playground: Playground,
  route: string,
): Promise<string | undefined> {
  const base = playground.preview.baseUrl;
  if (!base) return undefined;
  const dest = shotPath(runId, "before");
  try {
    await screenshotUrl(joinUrl(base, route), dest);
    return dest;
  } catch (err) {
    log.warn({ err }, "before screenshot failed");
    return undefined;
  }
}

export async function captureAfter(opts: {
  runId: string;
  playground: Playground;
  workspaceDir: string;
  route: string;
}): Promise<{ path?: string; skippedReason?: string }> {
  const dest = shotPath(opts.runId, "after");
  const { command, url, waitSeconds } = opts.playground.preview;
  let child: ChildProcess | undefined;

  try {
    if (command) {
      installDeps(opts.workspaceDir, opts.playground);
      child = spawn(command, {
        cwd: opts.workspaceDir,
        shell: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PORT: portFromUrl(url), BROWSER: "none" },
      });
      child.stdout?.on("data", (b) => log.debug({ preview: String(b).slice(0, 300) }));
      child.stderr?.on("data", (b) => log.debug({ previewErr: String(b).slice(0, 300) }));
      await waitForUrl(joinUrl(url, opts.route), waitSeconds || 45);
      await screenshotUrl(joinUrl(url, opts.route), dest);
      return { path: dest };
    }

    if (opts.playground.preview.baseUrl) {
      await screenshotUrl(joinUrl(opts.playground.preview.baseUrl, opts.route), dest);
      return {
        path: dest,
        skippedReason:
          "Photo is the configured base URL (not this branch). Set preview.command to shoot the actual change.",
      };
    }

    return { skippedReason: "No preview.baseUrl or preview.command — tech still has the PR." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "after screenshot failed");
    return { skippedReason: `Couldn't take a photo: ${message}` };
  } finally {
    if (child) killTree(child);
  }
}
