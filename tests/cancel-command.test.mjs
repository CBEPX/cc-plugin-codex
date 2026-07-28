import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";

import { getProcessIdentity } from "../scripts/lib/process.mjs";
import {
  readJobFile,
  resolveJobFile,
  writeJobFile,
} from "../scripts/lib/state.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION = path.join(ROOT, "scripts", "claude-companion.mjs");
const SWAP_PRELOAD = pathToFileURL(
  path.join(ROOT, "tests", "fixtures", "swap-job-after-read.mjs")
).href;
const cleanup = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()();
});

function runCancelSnapshotRace(id, stalePid) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cancel-race-"));
  cleanup.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const init = spawnSync("git", ["init", "-q"], { cwd, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);

  const createdAt = new Date().toISOString();
  const snapshot = {
    id,
    status: "running",
    pid: stalePid,
    pidIdentity: stalePid == null ? null : "stale-snapshot-identity",
    createdAt,
    updatedAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const authoritative = {
    ...snapshot,
    pid: process.pid,
    pidIdentity: getProcessIdentity(process.pid),
    updatedAt: createdAt,
  };
  writeJobFile(cwd, id, snapshot);
  const cancelRecord = path.join(cwd, "cancel-attempt.json");

  const result = spawnSync(
    process.execPath,
    ["--import", SWAP_PRELOAD, COMPANION, "cancel", id, "--cwd", cwd],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CC_TEST_SWAP_JOB_FILE: resolveJobFile(cwd, id),
        CC_TEST_SWAP_JOB_JSON: `${JSON.stringify(authoritative, null, 2)}\n`,
        CC_TEST_SWAP_JOB_AFTER_READ: "1",
        CC_TEST_CANCEL_PID: String(process.pid),
        CC_TEST_CANCEL_RECORD_FILE: cancelRecord,
      },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(String(process.pid)));
  if (stalePid != null) {
    assert.doesNotMatch(result.stdout, new RegExp(String(stalePid)));
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(cancelRecord, "utf8")), {
    pid: process.pid,
  });
  const stored = readJobFile(cwd, id);
  assert.equal(stored.status, "cancel_failed");
  assert.equal(stored.pid, process.pid);
  assert.equal(stored.pgid, process.pid);
}

test("cancel uses the in-lock PID when the list snapshot is stale", () => {
  runCancelSnapshotRace("cancel-stale-pid-race", 987_654_321);
});

test("cancel does not silently succeed when the list snapshot has no PID", () => {
  runCancelSnapshotRace("cancel-missing-pid-race", null);
});
