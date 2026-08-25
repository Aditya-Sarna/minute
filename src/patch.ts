import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isAllowedPath } from "./paths.js";
import { LIMITS } from "./limits.js";

export type PatchOp =
  | { kind: "replace"; path: string; search: string; replace: string }
  | { kind: "create"; path: string; content: string };

export function applyPatchOps(
  root: string,
  allow: string[],
  ops: PatchOp[],
): string[] {
  if (ops.length === 0) throw new Error("No edits.");
  if (ops.length > LIMITS.maxEditFiles) {
    throw new Error(`Too many files (max ${LIMITS.maxEditFiles}).`);
  }
  const written: string[] = [];
  for (const op of ops) {
    if (!isAllowedPath(op.path, allow)) {
      throw new Error(`Blocked path: ${op.path}`);
    }
    const dest = join(root, op.path);
    if (op.kind === "create") {
      if (Buffer.byteLength(op.content) > LIMITS.maxFileBytes) {
        throw new Error(`File too large: ${op.path}`);
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, op.content);
      written.push(op.path);
      continue;
    }
    if (!existsSync(dest)) throw new Error(`Missing file: ${op.path}`);
    const current = readFileSync(dest, "utf8");
    const matches = current.split(op.search).length - 1;
    if (matches === 0) throw new Error(`Search not found in ${op.path}`);
    if (matches > 1) throw new Error(`Search not unique in ${op.path} (${matches} hits)`);
    const next = current.replace(op.search, op.replace);
    if (Buffer.byteLength(next) > LIMITS.maxFileBytes) {
      throw new Error(`File too large after edit: ${op.path}`);
    }
    writeFileSync(dest, next);
    written.push(op.path);
  }
  return [...new Set(written)];
}
