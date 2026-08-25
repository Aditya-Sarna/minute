import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { completeJson } from "./llm.js";
import { applyPatchOps, type PatchOp } from "./patch.js";
import { isAllowedPath } from "./paths.js";
import { LIMITS } from "./limits.js";
import type { Attachment, Playground } from "./types.js";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".data", ".minute"]);
const STOP = new Set([
  "the", "and", "for", "make", "with", "this", "that", "from", "into", "page", "please",
]);

function listedUnder(root: string, allow: string[], cap = 200): string[] {
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
      if (SKIP.has(name)) continue;
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

function keywords(request: string): string[] {
  return request
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 12);
}

function scoreFiles(root: string, files: string[], terms: string[]): string[] {
  if (terms.length === 0) return files.slice(0, 40);
  const ranked = files.map((file) => {
    let score = 0;
    const lower = file.toLowerCase();
    for (const t of terms) if (lower.includes(t)) score += 5;
    try {
      const text = readFileSync(join(root, file), "utf8").slice(0, 20_000).toLowerCase();
      for (const t of terms) {
        const hits = text.split(t).length - 1;
        score += Math.min(hits, 8);
      }
    } catch {
      // binary
    }
    return { file, score };
  });
  return ranked
    .sort((a, b) => b.score - a.score)
    .filter((r) => r.score > 0)
    .concat(ranked.filter((r) => r.score === 0))
    .slice(0, 40)
    .map((r) => r.file);
}

function readCapped(root: string, file: string, cap = 24_000): string {
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

  const ranked = scoreFiles(opts.root, inventory, keywords(opts.request));
  const pick = await completeJson<{ files: string[]; placeAttachmentAs?: string }>(
    `Pick the fewest files to edit for this simple request. Stay inside the inventory.
Prefer search/replace of existing files. Create a file only if the ask needs a new page/asset.

Request: ${opts.request}
${opts.prior ? `Earlier ask: ${opts.prior}` : ""}
${opts.attachments?.length ? `Uploaded files: ${opts.attachments.map((a) => a.name).join(", ")}` : ""}

Inventory (ranked):
${ranked.join("\n")}

Return { "files": ["path"], "placeAttachmentAs": "optional dest for upload" }
Max ${LIMITS.maxEditFiles} files.`,
    { maxTokens: 800 },
  );

  const chosen = (pick.files || []).filter((f) => inventory.includes(f)).slice(0, LIMITS.maxEditFiles);
  if (chosen.length === 0 && !pick.placeAttachmentAs) {
    throw new Error("Couldn't match this request to a file in the playground.");
  }

  const blobs = chosen.map((f) => `--- ${f}\n${readCapped(opts.root, f)}`).join("\n\n");

  const edit = await completeJson<{
    summary: string;
    route?: string;
    ops: Array<{
      kind: "replace" | "create";
      path: string;
      search?: string;
      replace?: string;
      content?: string;
    }>;
  }>(`You are Minute. Smallest possible change for a non-technical stakeholder.
Use replace with a unique search string when editing existing files.
Use create only for new files. Do not refactor. Do not touch auth, payments, infra.

Request: ${opts.request}
${opts.prior ? `Previous request: ${opts.prior}` : ""}

Files:
${blobs}

Return:
{
  "summary": "one line, human",
  "route": "/path",
  "ops": [
    { "kind": "replace", "path": "a.tsx", "search": "exact old", "replace": "new" },
    { "kind": "create", "path": "b.tsx", "content": "full file" }
  ]
}`);

  const ops: PatchOp[] = [];
  for (const op of edit.ops || []) {
    if (op.kind === "replace" && op.search != null && op.replace != null) {
      ops.push({ kind: "replace", path: op.path, search: op.search, replace: op.replace });
    } else if (op.kind === "create" && typeof op.content === "string") {
      ops.push({ kind: "create", path: op.path, content: op.content });
    }
  }

  const written = ops.length ? applyPatchOps(opts.root, opts.playground.allow.paths, ops) : [];

  if (
    opts.attachments?.[0]?.localPath &&
    pick.placeAttachmentAs &&
    isAllowedPath(pick.placeAttachmentAs, opts.playground.allow.paths)
  ) {
    const dest = join(opts.root, pick.placeAttachmentAs);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(opts.attachments[0].localPath, dest);
    written.push(pick.placeAttachmentAs);
  }

  if (written.length === 0) {
    throw new Error("The agent produced no allowed edits.");
  }

  return {
    files: [...new Set(written)],
    summary: edit.summary || opts.request,
    routeHint: edit.route,
  };
}
