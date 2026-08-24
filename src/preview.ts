import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
import { log } from "./logger.js";
import type { Playground } from "./types.js";

function shotPath(runId: string, label: string): string {
  const p = resolve(".data/proof", runId, `${label}.png`);
  mkdirSync(dirname(p), { recursive: true });
  return p;
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
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Preview never came up at ${url}`);
}

async function screenshotUrl(url: string, dest: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: dest, fullPage: true });
  } finally {
    await browser.close();
  }
}

export async function captureBefore(runId: string, playground: Playground, route: string): Promise<string | undefined> {
  const base = playground.preview.baseUrl;
  if (!base) return undefined;
  const url = joinUrl(base, route);
  const dest = shotPath(runId, "before");
  try {
    await screenshotUrl(url, dest);
    return dest;
  } catch (err) {
    log.warn({ err, url }, "before screenshot failed");
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
      child = spawn(command, {
        cwd: opts.workspaceDir,
        shell: true,
        detached: true,
        stdio: "pipe",
        env: { ...process.env, PORT: portFromUrl(url) },
      });
      child.stdout?.on("data", (b) => log.debug({ preview: String(b) }));
      child.stderr?.on("data", (b) => log.debug({ previewErr: String(b) }));
      await waitForUrl(joinUrl(url, opts.route), waitSeconds || 25);
      await screenshotUrl(joinUrl(url, opts.route), dest);
      return { path: dest };
    }

    if (opts.playground.preview.baseUrl) {
      // Honest: this is staging/prod, not the branch. Label it in caption upstream.
      await screenshotUrl(joinUrl(opts.playground.preview.baseUrl, opts.route), dest);
      return {
        path: dest,
        skippedReason: command
          ? undefined
          : "Photo is the configured base URL (not this branch). Set preview.command to shoot the actual change.",
      };
    }

    return { skippedReason: "No preview.baseUrl or preview.command — tech still has the PR." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "after screenshot failed");
    writeFileSync(dest.replace(/\.png$/, ".txt"), message);
    return { skippedReason: `Couldn't take a photo: ${message}` };
  } finally {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
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
