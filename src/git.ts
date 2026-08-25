import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { dataDir } from "./limits.js";
import type { Playground } from "./types.js";

export function workspaceDir(runId: string): string {
  return resolve(dataDir(), "workspaces", runId);
}

function token(): string {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error("GITHUB_TOKEN is not set");
  return t;
}

function git(dir?: string): SimpleGit {
  return simpleGit(dir, {
    config: [`http.extraHeader=Authorization: Bearer ${token()}`],
  }).env({ GIT_TERMINAL_PROMPT: "0" });
}

function repoUrl(playground: Playground): string {
  const { owner, repo } = playground.github;
  return `https://github.com/${owner}/${repo}.git`;
}

async function configureIdentity(dir: string) {
  const repo = git(dir);
  await repo.addConfig("user.name", "Minute");
  await repo.addConfig("user.email", "minute[bot]@users.noreply.github.com");
}

export async function ensureWorkspace(opts: {
  runId: string;
  playground: Playground;
  branch: string;
  createBranch: boolean;
}): Promise<string> {
  const dir = workspaceDir(opts.runId);
  if (existsSync(join(dir, ".git"))) {
    const repo = git(dir);
    try {
      await repo.revparse(["--abbrev-ref", "HEAD"]);
      return dir;
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await git().clone(repoUrl(opts.playground), dir, [
    "--branch",
    opts.playground.github.defaultBranch,
    "--single-branch",
    "--depth",
    "1",
  ]);
  await configureIdentity(dir);
  const repo = git(dir);

  if (opts.createBranch) {
    await repo.checkoutLocalBranch(opts.branch);
    return dir;
  }

  await repo.fetch(["origin", opts.branch, "--depth", "1"]);
  await repo.checkout(["-B", opts.branch, `origin/${opts.branch}`]);
  return dir;
}

export async function commitAll(dir: string, message: string) {
  const repo = git(dir);
  await repo.add(["-A", "."]);
  const status = await repo.status();
  if (status.files.length === 0) {
    throw new Error("No files changed — the agent didn't edit anything.");
  }
  await repo.commit(message);
}

export async function pushBranch(dir: string, branch: string) {
  await git(dir).push("origin", branch, ["--set-upstream"]);
}
