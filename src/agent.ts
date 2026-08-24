import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { completeJson } from "./llm.js";
import type { Attachment, Playground } from "./types.js";

const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".data",
  ".minute",
]);

function listedUnder(root: string, allow: string[], cap = 120): string[] {
  const out: string[] = [];
  const roots =
    allow.length > 0
      ? allow.map((p) => resolve(root, p)).filter((p) => {
          try {
            return statSync(p).isDirectory() || statSync(p).isFile();
          } catch {
            return false;
          }
        })
      : [root];

  const walk = (dir: string) => {
    if (out.length >= cap) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP.has(name) || name.startsWith(".git")) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else out.push(relative(root, full).replaceAll("\\", "/"));
      if (out.length >= cap) return;
    }
  };

  for (const r of roots) {
    try {
      if (statSync(r).isFile()) {
        out.push(relative(root, r).replaceAll("\\", "/"));
        continue;
      }
    } catch {
      continue;
    }
    walk(r);
  }
  return out;
}

function allowedPath(file: string, allow: string[]): boolean {
  if (allow.length === 0) return !file.startsWith(".") && !file.includes("..");
  const norm = file.replaceAll("\\", "/");
  return allow.some((p) => norm === p.replace(/\/$/, "") || norm.startsWith(p));
}

function readCapped(root: string, file: string, cap = 80_000): string {
  const text = readFileSync(join(root, file), "utf8");
  if (text.length <= cap) return text;
  return text.slice(0, cap) + "\n\n/* truncated */";
}

export async function applySmallestChange(opts: {
  root: string;
  playground: Playground;
  request: string;
  prior?: string;
  attachments?: Attachment[];
}): Promise<{ files: string[]; summary: string; routeHint?: string }> {
  const inventory = listedUnder(opts.root, opts.playground.allow.paths);
  if (inventory.length === 0) {
    throw new Error("Playground paths don't exist in this repo. Check minute.config.yaml allow.paths.");
  }

  const pick = await completeJson<{ files: string[]; placeAttachmentAs?: string }>(
    `Pick the fewest files to read/edit for this simple request. Stay inside the inventory.

Request: ${opts.request}
${opts.prior ? `Earlier ask: ${opts.prior}` : ""}
${opts.attachments?.length ? `Uploaded files: ${opts.attachments.map((a) => a.name).join(", ")}` : ""}

Inventory:
${inventory.join("\n")}

Return { "files": ["path", ...], "placeAttachmentAs": "optional dest path for an uploaded asset" }
Max 8 files.`,
    { maxTokens: 1500 },
  );

  const chosen = (pick.files || []).filter((f) => inventory.includes(f)).slice(0, 8);
  if (chosen.length === 0) {
    throw new Error("Couldn't match this request to a file in the playground.");
  }

  const blobs = chosen.map((f) => `--- ${f}\n${readCapped(opts.root, f)}`).join("\n\n");

  const edit = await completeJson<{
    summary: string;
    route?: string;
    edits: { path: string; content: string }[];
  }>(`You are Minute. Make the SMALLEST change that satisfies a non-technical stakeholder.
Do not refactor. Do not touch auth, payments, infra, or files outside the playground.
Return full file contents for each edited file (not a patch).

Request: ${opts.request}
${opts.prior ? `Previous request in this thread: ${opts.prior}` : ""}

Files:
${blobs}

Return:
{
  "summary": "one line, human, no jargon",
  "route": "path like / or /notes",
  "edits": [{ "path": "relative/path", "content": "full new file" }]
}`);

  const written: string[] = [];
  for (const e of edit.edits || []) {
    if (!e?.path || typeof e.content !== "string") continue;
    if (!allowedPath(e.path, opts.playground.allow.paths)) continue;
    const dest = join(opts.root, e.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, e.content);
    written.push(e.path);
  }

  if (opts.attachments?.length && pick.placeAttachmentAs && allowedPath(pick.placeAttachmentAs, opts.playground.allow.paths)) {
    const src = opts.attachments[0].localPath;
    if (src) {
      const dest = join(opts.root, pick.placeAttachmentAs);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      written.push(pick.placeAttachmentAs);
    }
  }

  if (written.length === 0) {
    throw new Error("The agent produced no allowed edits.");
  }

  return { files: [...new Set(written)], summary: edit.summary || opts.request, routeHint: edit.route };
}
