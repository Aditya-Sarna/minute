import { Octokit } from "@octokit/rest";
import type { Playground, Proof, Run } from "./types.js";
import { repoLabel } from "./config.js";

function octokit() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return new Octokit({ auth: token });
}

export async function openPr(opts: {
  playground: Playground;
  run: Run;
  title: string;
  body: string;
}): Promise<{ number: number; url: string }> {
  const gh = octokit();
  const { owner, repo, defaultBranch } = opts.playground.github;
  const pr = await gh.pulls.create({
    owner,
    repo,
    title: opts.title,
    head: opts.run.branch,
    base: defaultBranch,
    body: opts.body,
  });
  return { number: pr.data.number, url: pr.data.html_url };
}

export async function updatePrBody(playground: Playground, prNumber: number, body: string) {
  const gh = octokit();
  await gh.pulls.update({
    owner: playground.github.owner,
    repo: playground.github.repo,
    pull_number: prNumber,
    body,
  });
}

export function prBody(opts: {
  playground: Playground;
  run: Run;
  summary: string;
  proof: Proof;
  signedOff: boolean;
}): string {
  const photo = opts.proof.afterPath
    ? `![Stakeholder photo](https://github.com/${opts.playground.github.owner}/${opts.playground.github.repo}/blob/${opts.run.branch}/.minute/${opts.run.id}-after.png?raw=true)`
    : "No live photo — preview URL/command was not configured.";
  return [
    `## Minute`,
    ``,
    `Stakeholder **${opts.run.requesterName}** asked, in chat:`,
    ``,
    `> ${opts.run.request}`,
    ``,
    opts.summary,
    ``,
    `Playground: \`${opts.playground.id}\` · ${repoLabel(opts.playground)}`,
    `Route: \`${opts.proof.route}\``,
    `Files: ${opts.proof.filesChanged.map((f) => `\`${f}\``).join(", ") || "—"}`,
    ``,
    opts.signedOff
      ? `**Visual sign-off:** yes. Tech: review on technical grounds only (approve / disapprove). Intent is the photo + the ask, not a briefing.`
      : `**Visual sign-off:** not yet. Stakeholder is still iterating in chat.`,
    ``,
    photo,
    ``,
    `This PR is a starting point. Messy is fine. If it is not architecturally feasible, disapprove and take it offline — Minute stops.`,
  ].join("\n");
}

export async function commentProof(
  playground: Playground,
  prNumber: number,
  _proof: Proof,
  caption: string,
) {
  const gh = octokit();
  const { owner, repo } = playground.github;
  await gh.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: caption,
  });
}

export async function getPr(playground: Playground, prNumber: number) {
  const gh = octokit();
  return gh.pulls.get({
    owner: playground.github.owner,
    repo: playground.github.repo,
    pull_number: prNumber,
  });
}

export async function listReviews(playground: Playground, prNumber: number) {
  const gh = octokit();
  const { data } = await gh.pulls.listReviews({
    owner: playground.github.owner,
    repo: playground.github.repo,
    pull_number: prNumber,
  });
  return data;
}
