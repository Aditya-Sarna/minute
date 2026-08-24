import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { simpleGit } from "simple-git";
import type { Playground } from "./types.js";

export function workspaceDir(runId: string): string {
  return resolve(".data/workspaces", runId);
}

function cloneUrl(playground: Playground): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const { owner, repo } = playground.github;
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

export async function checkout(runId: string, playground: Playground, branch: string) {
  const dir = workspaceDir(runId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = simpleGit();
  await git.clone(cloneUrl(playground), dir, [
    "--branch",
    playground.github.defaultBranch,
    "--single-branch",
    "--depth",
    "50",
  ]);
  const repo = simpleGit(dir);
  await repo.addConfig("user.name", "Minute");
  await repo.addConfig("user.email", "minute[bot]@users.noreply.github.com");
  await repo.checkoutLocalBranch(branch);
  return dir;
}

export async function commitAll(dir: string, message: string) {
  const git = simpleGit(dir);
  await git.add(".");
  const status = await git.status();
  if (status.files.length === 0) {
    throw new Error("No files changed — the agent didn't edit anything.");
  }
  await git.commit(message);
}

export async function pushBranch(dir: string, branch: string) {
  const git = simpleGit(dir);
  await git.push("origin", branch, ["--set-upstream"]);
}

export async function changedFiles(dir: string): Promise<string[]> {
  const git = simpleGit(dir);
  const summary = await git.diffSummary(["--name-only", "HEAD"]);
  // After commit, compare to default via log? Use status against origin default after first commit:
  const diff = await git.diff(["--name-only", "HEAD~1"]);
  const names = diff
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length) return names;
  return summary.files.map((f) => ("file" in f ? f.file : String(f)));
}
