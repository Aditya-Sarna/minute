import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isAllowedPath, isSafeRepoPath, normalizeRepoPath } from "../src/paths.js";
import { applyPatchOps } from "../src/patch.js";
import { clampRequest, LIMITS } from "../src/limits.js";
import { resetDbForTests, closeDb } from "../src/db.js";
import { saveRun, getRun, claimRun, newRunId } from "../src/store.js";
import { takeToken } from "../src/rate-limit.js";
import type { Run } from "../src/types.js";

test("path allowlist blocks traversal", () => {
  const allow = ["src/", "app/"];
  assert.equal(isAllowedPath("src/page.tsx", allow), true);
  assert.equal(isAllowedPath("app/x.ts", allow), true);
  assert.equal(isAllowedPath("../etc/passwd", allow), false);
  assert.equal(isAllowedPath("src/../../secrets", allow), false);
  assert.equal(isAllowedPath(".git/config", allow), false);
  assert.equal(isAllowedPath("infra/main.tf", allow), false);
  assert.equal(isSafeRepoPath("/abs"), false);
  assert.equal(normalizeRepoPath("./src/a.ts"), "src/a.ts");
});

test("patch replace is unique", () => {
  const dir = mkdtempSync(join(tmpdir(), "minute-"));
  writeFileSync(join(dir, "a.css"), "color: red;\ncolor: red;\n");
  assert.throws(() =>
    applyPatchOps(dir, ["a.css"], [
      { kind: "replace", path: "a.css", search: "color: red;", replace: "color: green;" },
    ]),
  );
  writeFileSync(join(dir, "b.css"), "color: red;\n");
  applyPatchOps(dir, ["b.css"], [
    { kind: "replace", path: "b.css", search: "color: red;", replace: "color: green;" },
  ]);
  assert.equal(readFileSync(join(dir, "b.css"), "utf8"), "color: green;\n");
});

test("patch create stays in playground", () => {
  const dir = mkdtempSync(join(tmpdir(), "minute-"));
  mkdirSync(join(dir, "src"));
  assert.throws(() =>
    applyPatchOps(dir, ["src/"], [{ kind: "create", path: "secrets.env", content: "x" }]),
  );
  applyPatchOps(dir, ["src/"], [{ kind: "create", path: "src/notes.tsx", content: "export default 1" }]);
  assert.equal(readFileSync(join(dir, "src/notes.tsx"), "utf8"), "export default 1");
});

test("clampRequest strips and caps", () => {
  assert.equal(clampRequest("  hi\0  "), "hi");
  assert.equal(clampRequest("x".repeat(LIMITS.requestChars + 50)).length, LIMITS.requestChars);
});

test("sqlite run claim", () => {
  const file = join(mkdtempSync(join(tmpdir(), "minute-db-")), "t.sqlite");
  resetDbForTests(file);
  const run: Run = {
    id: newRunId(),
    surface: "slack",
    channelId: "C1",
    threadId: "T1",
    parentMessageId: "T1",
    requesterId: "U1",
    requesterName: "priya",
    playgroundId: "website",
    request: "green",
    status: "proof",
    branch: "b",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveRun(run);
  assert.equal(getRun(run.id)?.status, "proof");
  assert.ok(claimRun(run.id, "proof", "working"));
  assert.equal(getRun(run.id)?.status, "working");
  assert.equal(claimRun(run.id, "proof", "working"), undefined);
  closeDb();
});

test("rate limit", () => {
  const file = join(mkdtempSync(join(tmpdir(), "minute-db-")), "r.sqlite");
  resetDbForTests(file);
  assert.equal(takeToken("u1", 2), true);
  assert.equal(takeToken("u1", 2), true);
  assert.equal(takeToken("u1", 2), false);
  closeDb();
});
