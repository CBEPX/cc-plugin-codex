/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// State paths are workspace-hash based and resolveWorkspaceRoot() shells out to
// git, so most tests use a real git repo cwd. A dedicated subprocess test below
// covers the HOME/CODEX_HOME-specific migration path.

import {
  MAX_STOP_REVIEW_HISTORY_ENTRIES,
  resolveWorkspaceHash,
  resolveStateDir,
  resolveJobsDir,
  ensureStateDir,
  loadConfig,
  saveConfig,
  setConfig,
  getConfig,
  generateJobId,
  writeJobFile,
  readJobFile,
  listJobs,
  upsertJob,
  patchJob,
  transitionJob,
  casJobStatus,
  setCurrentSession,
  getCurrentSession,
  clearCurrentSession,
  markSessionCleanupPending,
  listPendingSessionCleanups,
  clearSessionCleanupPending,
  cleanupOldJobs,
  reapStaleJobs,
  appendStopReviewHistory,
  resolveJobLogFile,
  nowIso,
} from "../scripts/lib/state.mjs";
import { getProcessIdentity } from "../scripts/lib/process.mjs";

// We'll use the project root as a known git-repo cwd for workspace resolution.
const PROJECT_CWD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_MODULE_URL = new URL("../scripts/lib/state.mjs", import.meta.url).href;

function createTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-test-"));
  const result = spawnSync("git", ["init", "-q"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git init failed: ${result.stderr || result.stdout}`);
  }
  return dir;
}

function isLockBusyError(error) {
  const lockError =
    /** @type {NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException }} */ (
      error
    );
  return lockError.code === "ELOCKBUSY" && lockError.cause?.code === "EEXIST";
}

// ---------------------------------------------------------------------------
// resolveWorkspaceHash
// ---------------------------------------------------------------------------

describe("resolveWorkspaceHash", () => {
  it("returns a 12-character hex string", () => {
    const hash = resolveWorkspaceHash(PROJECT_CWD);
    assert.match(hash, /^[0-9a-f]{12}$/);
  });

  it("is deterministic for the same path", () => {
    const h1 = resolveWorkspaceHash(PROJECT_CWD);
    const h2 = resolveWorkspaceHash(PROJECT_CWD);
    assert.equal(h1, h2);
  });
});

// ---------------------------------------------------------------------------
// generateJobId
// ---------------------------------------------------------------------------

describe("generateJobId", () => {
  it("starts with the given prefix", () => {
    const id = generateJobId("review");
    assert.ok(id.startsWith("review-"), `Expected prefix 'review-', got '${id}'`);
  });

  it("defaults to 'job' prefix", () => {
    const id = generateJobId();
    assert.ok(id.startsWith("job-"));
  });

  it("is unique across calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateJobId()));
    assert.equal(ids.size, 20);
  });

  it("matches the expected format (prefix-base36ts-base36rand)", () => {
    const id = generateJobId("task");
    // prefix-<base36>-<base36>
    assert.match(id, /^task-[a-z0-9]+-[a-z0-9]+$/);
  });
});

// ---------------------------------------------------------------------------
// nowIso
// ---------------------------------------------------------------------------

describe("nowIso", () => {
  it("returns a valid ISO 8601 timestamp", () => {
    const ts = nowIso();
    const parsed = new Date(ts);
    assert.ok(!isNaN(parsed.getTime()));
    assert.ok(ts.endsWith("Z"));
  });
});

// ---------------------------------------------------------------------------
// Config round-trip (uses real state dir for current project)
// ---------------------------------------------------------------------------

describe("loadConfig / saveConfig", () => {
  // We use the real project cwd. saveConfig creates dirs under STATE_ROOT.
  // We clean up after.

  let stateDir;

  before(() => {
    stateDir = resolveStateDir(PROJECT_CWD);
  });

  afterEach(() => {
    // Remove config file if it was created by the test
    const configFile = path.join(stateDir, "config.json");
    try { fs.unlinkSync(configFile); } catch {}
  });

  it("loadConfig returns defaults when no file exists", () => {
    // Make sure no config file
    const configFile = path.join(stateDir, "config.json");
    try { fs.unlinkSync(configFile); } catch {}

    const cfg = loadConfig(PROJECT_CWD);
    assert.equal(cfg.version, 1);
    assert.equal(cfg.stopReviewGate, false);
  });

  it("saveConfig round-trips with loadConfig", () => {
    saveConfig(PROJECT_CWD, { stopReviewGate: true, customKey: "hello" });
    const cfg = loadConfig(PROJECT_CWD);
    assert.equal(cfg.version, 1);
    assert.equal(cfg.stopReviewGate, true);
    assert.equal(cfg.customKey, "hello");
  });

  it("setConfig updates a single key", () => {
    saveConfig(PROJECT_CWD, { stopReviewGate: false });
    setConfig(PROJECT_CWD, "stopReviewGate", true);
    const cfg = getConfig(PROJECT_CWD);
    assert.equal(cfg.stopReviewGate, true);
  });

  it("migrates legacy claude-code plugin state into the cc plugin namespace and prunes old armed markers", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-state-migrate-"));
    const codexHome = path.join(homeDir, ".codex");
    const repoDir = createTempGitRepo();

    try {
      const realWorkspace = fs.realpathSync.native(repoDir);
      const workspaceHash = createHash("sha256")
        .update(realWorkspace)
        .digest("hex")
        .slice(0, 12);
      const legacyStateDir = path.join(
        codexHome,
        "plugins",
        "data",
        "claude-code",
        "state",
        workspaceHash
      );
      const nextStateDir = path.join(
        codexHome,
        "plugins",
        "data",
        "cc",
        "state",
        workspaceHash
      );

      fs.mkdirSync(legacyStateDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacyStateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );
      fs.writeFileSync(path.join(legacyStateDir, "armed-old-session"), "", "utf8");

      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            const mod = await import(${JSON.stringify(STATE_MODULE_URL)});
            const cwd = ${JSON.stringify(repoDir)};
            console.log(JSON.stringify({
              stateDir: mod.resolveStateDir(cwd),
              config: mod.getConfig(cwd)
            }));
          `,
        ],
        {
          env: {
            ...process.env,
            HOME: homeDir,
            USERPROFILE: homeDir,
            CODEX_HOME: codexHome,
          },
          encoding: "utf8",
        }
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.stateDir, nextStateDir);
      assert.equal(payload.config.stopReviewGate, true);
      assert.equal(fs.existsSync(path.join(nextStateDir, "config.json")), true);
      assert.equal(fs.existsSync(path.join(legacyStateDir, "config.json")), false);
      assert.equal(fs.existsSync(path.join(nextStateDir, "armed-old-session")), false);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Stop review history retention
// ---------------------------------------------------------------------------

describe("appendStopReviewHistory", () => {
  it("retains only the newest configured number of history entries", () => {
    const repoDir = createTempGitRepo();
    const historyFile = path.join(resolveStateDir(repoDir), "stop-review-history.jsonl");

    try {
      for (let i = 0; i < MAX_STOP_REVIEW_HISTORY_ENTRIES + 25; i++) {
        appendStopReviewHistory(repoDir, {
          seq: i,
          verdict: i % 2 === 0 ? "allow" : "block",
        });
      }

      const lines = fs
        .readFileSync(historyFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      assert.equal(lines.length, MAX_STOP_REVIEW_HISTORY_ENTRIES);
      assert.equal(lines[0].seq, 25);
      assert.equal(lines.at(-1).seq, MAX_STOP_REVIEW_HISTORY_ENTRIES + 24);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Job CRUD
// ---------------------------------------------------------------------------

describe("writeJobFile / readJobFile / listJobs", () => {
  const jobId = "test-crud-job";

  afterEach(() => {
    // Clean up
    try {
      const jobFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json`);
      fs.unlinkSync(jobFile);
    } catch {}
  });

  it("writeJobFile creates a file and readJobFile reads it back", () => {
    const payload = { id: jobId, status: "running", title: "test" };
    writeJobFile(PROJECT_CWD, jobId, payload);
    const read = readJobFile(PROJECT_CWD, jobId);
    assert.equal(read.id, jobId);
    assert.equal(read.status, "running");
    assert.equal(read.title, "test");
    assert.ok(read.updatedAt); // writeJobFile adds updatedAt
  });

  it("readJobFile returns null for non-existent job", () => {
    assert.equal(readJobFile(PROJECT_CWD, "nonexistent-job-xyz"), null);
  });

  it("listJobs returns array containing written job", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "completed", createdAt: nowIso() });
    const jobs = listJobs(PROJECT_CWD);
    assert.ok(Array.isArray(jobs));
    const found = jobs.find((j) => j.id === jobId);
    assert.ok(found, "Expected to find the written job in listJobs");
  });

  it("normalizes missing context telemetry in legacy task results", () => {
    writeJobFile(PROJECT_CWD, jobId, {
      id: jobId,
      status: "completed",
      jobClass: "task",
      createdAt: nowIso(),
      result: { status: "completed", rawOutput: "done" },
    });

    assert.equal(readJobFile(PROJECT_CWD, jobId).result.contextWindow, null);
    assert.equal(
      listJobs(PROJECT_CWD).find((job) => job.id === jobId).result.contextWindow,
      null
    );

    writeJobFile(PROJECT_CWD, jobId, {
      id: jobId,
      status: "completed",
      kind: "task",
      createdAt: nowIso(),
      result: {},
    });
    assert.equal(readJobFile(PROJECT_CWD, jobId).result.contextWindow, null);
  });

  it("preserves task telemetry and normalizes legacy review results", () => {
    writeJobFile(PROJECT_CWD, jobId, {
      id: jobId,
      status: "completed",
      jobClass: "task",
      createdAt: nowIso(),
      result: { contextWindow: 1000000 },
    });
    assert.equal(readJobFile(PROJECT_CWD, jobId).result.contextWindow, 1000000);

    writeJobFile(PROJECT_CWD, jobId, {
      id: jobId,
      status: "completed",
      jobClass: "review",
      createdAt: nowIso(),
      result: { codex: {} },
    });
    assert.equal(readJobFile(PROJECT_CWD, jobId).result.codex.contextWindow, null);

    writeJobFile(PROJECT_CWD, jobId, {
      id: jobId,
      status: "completed",
      kind: "adversarial-review",
      createdAt: nowIso(),
      result: { codex: { contextWindow: 200000 } },
    });
    assert.equal(readJobFile(PROJECT_CWD, jobId).result.codex.contextWindow, 200000);

    writeJobFile(PROJECT_CWD, jobId, {
      id: jobId,
      status: "completed",
      kind: "review",
      createdAt: nowIso(),
      result: { codex: {} },
    });
    assert.equal(readJobFile(PROJECT_CWD, jobId).result.codex.contextWindow, null);
  });

  it("listJobs returns recent entries without error", () => {
    // Write 5 jobs, verify they all appear (we won't actually write 51)
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = `test-list-${i}`;
      ids.push(id);
      writeJobFile(PROJECT_CWD, id, { id, status: "completed", createdAt: new Date(Date.now() - i * 1000).toISOString() });
    }
    try {
      const jobs = listJobs(PROJECT_CWD);
      // Should include all 5
      for (const id of ids) {
        assert.ok(jobs.some((j) => j.id === id), `Expected ${id} in listJobs`);
      }
    } finally {
      for (const id of ids) {
        try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${id}.json`)); } catch {}
      }
    }
  });

  it("listJobs sorts newest first", () => {
    const ids = ["test-sort-a", "test-sort-b"];
    writeJobFile(PROJECT_CWD, ids[0], { id: ids[0], status: "completed", createdAt: "2020-01-01T00:00:00Z" });
    writeJobFile(PROJECT_CWD, ids[1], { id: ids[1], status: "completed", createdAt: "2025-01-01T00:00:00Z" });
    try {
      const jobs = listJobs(PROJECT_CWD);
      const idxA = jobs.findIndex((j) => j.id === ids[0]);
      const idxB = jobs.findIndex((j) => j.id === ids[1]);
      assert.ok(idxB < idxA, "Newer job should come first");
    } finally {
      for (const id of ids) {
        try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${id}.json`)); } catch {}
      }
    }
  });
});

// ---------------------------------------------------------------------------
// upsertJob
// ---------------------------------------------------------------------------

describe("upsertJob", () => {
  const jobId = "test-upsert-job";

  afterEach(() => {
    try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json`)); } catch {}
  });

  it("inserts a new job when it does not exist", () => {
    const job = upsertJob(PROJECT_CWD, { id: jobId, status: "running", title: "new" });
    assert.equal(job.id, jobId);
    assert.equal(job.status, "running");
    assert.ok(job.createdAt);
    assert.ok(job.updatedAt);
  });

  it("updates an existing job preserving original fields", () => {
    upsertJob(PROJECT_CWD, { id: jobId, status: "running", title: "orig", extra: "keep" });
    const updated = upsertJob(PROJECT_CWD, { id: jobId, status: "completed" });
    assert.equal(updated.status, "completed");
    assert.equal(updated.title, "orig");
    assert.equal(updated.extra, "keep");
  });
});

// ---------------------------------------------------------------------------
// patchJob
// ---------------------------------------------------------------------------

describe("patchJob", () => {
  const jobId = "test-patch-job";

  afterEach(() => {
    try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json`)); } catch {}
  });

  it("updates an existing job without changing unrelated fields", () => {
    writeJobFile(PROJECT_CWD, jobId, {
      id: jobId,
      status: "running",
      title: "orig",
      extra: "keep",
      createdAt: nowIso(),
    });
    const updated = patchJob(PROJECT_CWD, jobId, { status: "completed" });
    assert.equal(updated.status, "completed");
    assert.equal(updated.title, "orig");
    assert.equal(updated.extra, "keep");
  });

  it("returns null when the job does not exist", () => {
    assert.equal(patchJob(PROJECT_CWD, jobId, { status: "completed" }), null);
  });
});

// ---------------------------------------------------------------------------
// transitionJob
// ---------------------------------------------------------------------------

describe("transitionJob", () => {
  const jobId = "test-transition-job";

  afterEach(() => {
    try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json`)); } catch {}
  });

  it("transitions when the current status matches one of the expected statuses", () => {
    writeJobFile(PROJECT_CWD, jobId, {
      id: jobId,
      status: "queued",
      createdAt: nowIso(),
    });
    const result = transitionJob(
      PROJECT_CWD,
      jobId,
      ["running", "queued"],
      "cancelling",
      { phase: "cancelling" }
    );
    assert.equal(result.transitioned, true);
    assert.equal(result.previousStatus, "queued");
    assert.equal(result.job.status, "cancelling");
    assert.equal(result.job.phase, "cancelling");
  });

  it("returns the current job without transitioning when the status does not match", () => {
    writeJobFile(PROJECT_CWD, jobId, {
      id: jobId,
      status: "completed",
      createdAt: nowIso(),
    });
    const result = transitionJob(
      PROJECT_CWD,
      jobId,
      ["running", "queued"],
      "cancelling"
    );
    assert.equal(result.transitioned, false);
    assert.equal(result.previousStatus, "completed");
    assert.equal(result.job.status, "completed");
  });
});

// ---------------------------------------------------------------------------
// casJobStatus
// ---------------------------------------------------------------------------

describe("casJobStatus", () => {
  const jobId = "test-cas-job";

  afterEach(() => {
    try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json`)); } catch {}
    try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`)); } catch {}
  });

  it("succeeds when current status matches expected", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const ok = casJobStatus(PROJECT_CWD, jobId, "running", "completed", { summary: "done" });
    assert.equal(ok, true);
    const job = readJobFile(PROJECT_CWD, jobId);
    assert.equal(job.status, "completed");
    assert.equal(job.summary, "done");
  });

  it("fails when current status does not match expected", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "completed" });
    const ok = casJobStatus(PROJECT_CWD, jobId, "running", "cancelled");
    assert.equal(ok, false);
    const job = readJobFile(PROJECT_CWD, jobId);
    assert.equal(job.status, "completed"); // unchanged
  });

  it("cleans up lock file after operation", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    casJobStatus(PROJECT_CWD, jobId, "running", "completed");
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    assert.ok(!fs.existsSync(lockFile), "Lock file should be removed after CAS");
  });

  it("does not remove a lock whose ownership token changed", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    const originalReadFileSync = fs.readFileSync;
    Reflect.set(fs, "readFileSync", (filePath, ...args) => {
      if (String(filePath) === lockFile && fs.existsSync(lockFile)) {
        return JSON.stringify({ token: "replacement-owner" });
      }
      return originalReadFileSync(filePath, ...args);
    });
    syncBuiltinESMExports();

    try {
      assert.equal(
        casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
        true
      );
      assert.equal(fs.existsSync(lockFile), true);
    } finally {
      Reflect.set(fs, "readFileSync", originalReadFileSync);
      syncBuiltinESMExports();
    }
  });

  it("does not unlink stale lock contents that another owner replaced", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    const replacement = JSON.stringify({
      pid: process.pid,
      identity: null,
      timestamp: Date.now(),
      token: "replacement-owner",
    });
    fs.writeFileSync(lockFile, "{");
    const hardStaleTime = new Date(Date.now() - 121_000);
    fs.utimesSync(lockFile, hardStaleTime, hardStaleTime);

    const originalReadFileSync = fs.readFileSync;
    const originalWriteFileSync = fs.writeFileSync;
    let lockReads = 0;
    Reflect.set(fs, "readFileSync", (filePath, ...args) => {
      if (String(filePath) === lockFile && ++lockReads === 2) {
        originalWriteFileSync(lockFile, replacement);
        return replacement;
      }
      return originalReadFileSync(filePath, ...args);
    });
    syncBuiltinESMExports();

    try {
      assert.throws(
        () => casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
        isLockBusyError
      );
      assert.equal(fs.readFileSync(lockFile, "utf8"), replacement);
    } finally {
      Reflect.set(fs, "readFileSync", originalReadFileSync);
      syncBuiltinESMExports();
    }
  });

  it("retries a transient atomic-publication collision", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    const originalLinkSync = fs.linkSync;
    let lockLinks = 0;
    Reflect.set(fs, "linkSync", (existingPath, newPath) => {
      if (String(newPath) === lockFile && ++lockLinks === 1) {
        throw Object.assign(new Error("synthetic collision"), {
          code: "EEXIST",
        });
      }
      return originalLinkSync(existingPath, newPath);
    });
    syncBuiltinESMExports();

    try {
      assert.equal(
        casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
        true
      );
      assert.equal(lockLinks, 2);
    } finally {
      Reflect.set(fs, "linkSync", originalLinkSync);
      syncBuiltinESMExports();
    }
  });

  it("stops after the configured number of lock collisions", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        identity: null,
        timestamp: Date.now(),
      })
    );
    const originalLinkSync = fs.linkSync;
    let lockLinks = 0;
    Reflect.set(fs, "linkSync", (existingPath, newPath) => {
      if (String(newPath) === lockFile) {
        lockLinks += 1;
      }
      return originalLinkSync(existingPath, newPath);
    });
    syncBuiltinESMExports();

    try {
      assert.throws(
        () => casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
        isLockBusyError
      );
      assert.equal(lockLinks, 3);
    } finally {
      Reflect.set(fs, "linkSync", originalLinkSync);
      syncBuiltinESMExports();
    }
  });

  it("removes the staged lock when its ownership write fails", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    const originalWriteFileSync = fs.writeFileSync;
    Reflect.set(fs, "writeFileSync", (filePath, ...args) => {
      if (String(filePath).startsWith(`${lockFile}.publish.`)) {
        throw Object.assign(new Error("synthetic ownership write failure"), {
          code: "EIO",
        });
      }
      return originalWriteFileSync(filePath, ...args);
    });
    syncBuiltinESMExports();

    try {
      assert.throws(
        () => casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
        (error) => /** @type {NodeJS.ErrnoException} */ (error).code === "EIO"
      );
      assert.equal(fs.existsSync(lockFile), false);
      assert.equal(
        fs.readdirSync(resolveJobsDir(PROJECT_CWD)).some(
          (name) => name.startsWith(`${jobId}.json.lock.publish.`)
        ),
        false
      );
    } finally {
      Reflect.set(fs, "writeFileSync", originalWriteFileSync);
      syncBuiltinESMExports();
    }
  });

  it("captures owner identity and stages a populated lock before atomic publication", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const originalReadFileSync = fs.readFileSync;
const originalLinkSync = fs.linkSync;
const originalWriteFileSync = fs.writeFileSync;
const originalSpawnSync = childProcess.spawnSync;
let identityResolved = false;
let linkSawIdentity = false;
let linkSawPopulatedSource = false;
let ownershipWriteTarget = null;

Reflect.set(fs, "readFileSync", (target, ...args) => {
  if (String(target) === \`/proc/\${process.pid}/stat\`) {
    identityResolved = true;
  }
  return originalReadFileSync(target, ...args);
});
Reflect.set(childProcess, "spawnSync", (command, ...args) => {
  if (command === "ps" || command === "powershell.exe") {
    identityResolved = true;
  }
  return originalSpawnSync(command, ...args);
});
Reflect.set(fs, "linkSync", (existingPath, newPath) => {
  if (String(newPath).endsWith(".json.lock")) {
    linkSawIdentity = identityResolved;
    linkSawPopulatedSource =
      originalReadFileSync(existingPath, "utf8").includes('"token"');
  }
  return originalLinkSync(existingPath, newPath);
});
Reflect.set(fs, "writeFileSync", (target, data, ...args) => {
  if (String(data).includes('"token"')) {
    ownershipWriteTarget = typeof target;
  }
  return originalWriteFileSync(target, data, ...args);
});
syncBuiltinESMExports();

const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-lock-publication-"));
process.env.CODEX_HOME = stateHome;
try {
  const state = await import(${JSON.stringify(STATE_MODULE_URL)} + "?lock-publication=" + Date.now());
  state.writeJobFile(process.env.TEST_PROJECT_CWD, "lock-publication-job", {
    id: "lock-publication-job",
    status: "running"
  });
  const transitioned = state.casJobStatus(
    process.env.TEST_PROJECT_CWD,
    "lock-publication-job",
    "running",
    "completed"
  );
  process.stdout.write(JSON.stringify({
    transitioned,
    linkSawIdentity,
    linkSawPopulatedSource,
    ownershipWriteTarget
  }));
} finally {
  fs.rmSync(stateHome, { recursive: true, force: true });
}
`,
      ],
      {
        cwd: PROJECT_CWD,
        env: {
          ...process.env,
          TEST_PROJECT_CWD: PROJECT_CWD,
        },
        encoding: "utf8",
      }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      transitioned: true,
      linkSawIdentity: true,
      linkSawPopulatedSource: true,
      ownershipWriteTarget: "string",
    });
  });

  it("can publish a deadline lock without resolving the lock-owner identity", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const originalLinkSync = fs.linkSync;
    let publishedIdentity = "not-observed";
    Reflect.set(fs, "linkSync", (source, destination) => {
      if (String(destination).endsWith(".json.lock")) {
        publishedIdentity = JSON.parse(fs.readFileSync(source, "utf8")).identity;
      }
      return originalLinkSync(source, destination);
    });
    syncBuiltinESMExports();

    try {
      const result = transitionJob(
        PROJECT_CWD,
        jobId,
        ["running"],
        "completed",
        {},
        { skipLockOwnerIdentity: true }
      );
      assert.equal(result.transitioned, true);
      assert.equal(publishedIdentity, null);
    } finally {
      Reflect.set(fs, "linkSync", originalLinkSync);
      syncBuiltinESMExports();
    }
  });

  it("keeps a live owner's lock when its identity is unavailable", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        identity: null,
        timestamp: Date.now(),
      })
    );

    assert.throws(
      () => casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
      isLockBusyError
    );
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(readJobFile(PROJECT_CWD, jobId).status, "running");
  });

  it("recovers a lock whose owner process is dead", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 99_999_999,
        identity: "dead-owner",
        timestamp: Date.now(),
      })
    );

    assert.equal(
      casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
      true
    );
    assert.equal(readJobFile(PROJECT_CWD, jobId).status, "completed");
  });

  it("recovers a live recycled-PID lock with a mismatched identity", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        identity: "not-this-process",
        timestamp: Date.now() - 31_000,
      })
    );

    assert.equal(
      casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
      true
    );
    assert.equal(readJobFile(PROJECT_CWD, jobId).status, "completed");
  });

  it("keeps a live lock whose stored identity still matches", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        identity: getProcessIdentity(process.pid),
        timestamp: Date.now(),
      })
    );

    assert.throws(
      () => casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
      isLockBusyError
    );
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(readJobFile(PROJECT_CWD, jobId).status, "running");
  });

  it("keeps a fresh malformed lock fail-closed", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    fs.writeFileSync(lockFile, "{");

    assert.throws(
      () => casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
      isLockBusyError
    );
    assert.equal(fs.existsSync(lockFile), true);
  });

  it("keeps a malformed lock throughout the Windows identity timeout window", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    fs.writeFileSync(lockFile, "");
    const stillPublishing = new Date(Date.now() - 11_000);
    fs.utimesSync(lockFile, stillPublishing, stillPublishing);

    assert.throws(
      () => casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
      isLockBusyError
    );
    assert.equal(fs.existsSync(lockFile), true);
  });

  it("recovers a malformed lock after the stale grace period", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    fs.writeFileSync(lockFile, "{");
    const staleTime = new Date(Date.now() - 16_000);
    fs.utimesSync(lockFile, staleTime, staleTime);

    assert.equal(
      casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
      true
    );
    assert.equal(readJobFile(PROJECT_CWD, jobId).status, "completed");
  });

  it("recovers a stale lock with an invalid owner PID", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 0,
        identity: null,
        timestamp: Date.now(),
      })
    );
    const staleTime = new Date(Date.now() - 16_000);
    fs.utimesSync(lockFile, staleTime, staleTime);

    assert.equal(
      casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
      true
    );
    assert.equal(readJobFile(PROJECT_CWD, jobId).status, "completed");
  });

  it("keeps a fresh lock with an invalid owner PID fail-closed", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 0,
        identity: null,
        timestamp: Date.now(),
      })
    );

    assert.throws(
      () => casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
      isLockBusyError
    );
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(readJobFile(PROJECT_CWD, jobId).status, "running");
  });

  it("keeps an old live-owner lock without a verifiable identity", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        identity: null,
        timestamp: Date.now() - 31_000,
      })
    );

    assert.throws(
      () => casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
      isLockBusyError
    );
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(readJobFile(PROJECT_CWD, jobId).status, "running");
  });

  it("keeps an old live-owner lock with a non-string identity", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        identity: 42,
        timestamp: Date.now() - 31_000,
      })
    );

    assert.throws(
      () => casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
      isLockBusyError
    );
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(readJobFile(PROJECT_CWD, jobId).status, "running");
  });

  it("recovers an unverifiable live-PID lock after the hard age cap", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        identity: null,
        timestamp: Date.now() - 121_000,
      })
    );
    const hardStaleTime = new Date(Date.now() - 121_000);
    fs.utimesSync(lockFile, hardStaleTime, hardStaleTime);

    assert.equal(
      casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
      true
    );
    assert.equal(readJobFile(PROJECT_CWD, jobId).status, "completed");
  });

  it("leases a lock when owner identity lookup throws", async () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const owner = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true }
    );
    await new Promise((resolve, reject) => {
      owner.once("spawn", resolve);
      owner.once("error", reject);
    });

    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: owner.pid,
        identity: "unverifiable-owner",
        timestamp: Date.now(),
      })
    );

    const originalReadFileSync = fs.readFileSync;
    const originalSpawnSync = childProcess.spawnSync;
    let identityLookups = 0;
    Reflect.set(fs, "readFileSync", (filePath, ...args) => {
      if (String(filePath) === `/proc/${owner.pid}/stat`) {
        identityLookups += 1;
        throw Object.assign(new Error("synthetic identity failure"), {
          code: "EIO",
        });
      }
      return originalReadFileSync(filePath, ...args);
    });
    Reflect.set(childProcess, "spawnSync", (command, args, ...rest) => {
      const targetsOwner =
        (command === "ps" && args?.at(-1) === String(owner.pid)) ||
        (command === "powershell.exe" &&
          args?.at(-1)?.includes(`ProcessId = ${owner.pid}`));
      if (targetsOwner) {
        identityLookups += 1;
        return {
          error: Object.assign(new Error("synthetic identity failure"), {
            code: "EIO",
          }),
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
        };
      }
      return originalSpawnSync(command, args, ...rest);
    });
    syncBuiltinESMExports();

    try {
      assert.throws(
        () => casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
        isLockBusyError
      );
      assert.equal(fs.existsSync(lockFile), true);
      assert.equal(identityLookups, 0);
      fs.writeFileSync(
        lockFile,
        JSON.stringify({
          pid: owner.pid,
          identity: "unverifiable-owner",
          timestamp: Date.now() - 31_000,
        })
      );
      assert.throws(
        () => casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
        isLockBusyError
      );
      assert.equal(fs.existsSync(lockFile), true);
      assert.equal(readJobFile(PROJECT_CWD, jobId).status, "running");
      assert.ok(identityLookups >= 1);

      const hardStaleTime = new Date(Date.now() - 121_000);
      fs.utimesSync(lockFile, hardStaleTime, hardStaleTime);
      assert.equal(
        casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
        true
      );
      assert.equal(readJobFile(PROJECT_CWD, jobId).status, "completed");
    } finally {
      Reflect.set(fs, "readFileSync", originalReadFileSync);
      Reflect.set(childProcess, "spawnSync", originalSpawnSync);
      syncBuiltinESMExports();
      owner.kill();
    }
  });

  it("falls back to exclusive lock creation when hard links are unsupported", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const originalLinkSync = fs.linkSync;
    let linkAttempts = 0;
    Reflect.set(fs, "linkSync", () => {
      linkAttempts += 1;
      throw Object.assign(new Error("hard links unavailable"), {
        code: "EPERM",
      });
    });
    syncBuiltinESMExports();

    try {
      assert.equal(
        casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
        true
      );
      writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
      assert.equal(
        casJobStatus(PROJECT_CWD, jobId, "running", "completed"),
        true
      );
      assert.equal(linkAttempts, 1);
      assert.equal(readJobFile(PROJECT_CWD, jobId).status, "completed");
    } finally {
      Reflect.set(fs, "linkSync", originalLinkSync);
      syncBuiltinESMExports();
    }
  });
});

// ---------------------------------------------------------------------------
// current session marker
// ---------------------------------------------------------------------------

describe("current session marker", () => {
  const sessionId = "test-current-session";
  let repoDir;

  beforeEach(() => {
    repoDir = createTempGitRepo();
  });

  afterEach(() => {
    clearCurrentSession(repoDir);
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("stores and reads the current session id", () => {
    setCurrentSession(repoDir, sessionId);
    assert.equal(getCurrentSession(repoDir), sessionId);
  });

  it("clears the current session id", () => {
    setCurrentSession(repoDir, sessionId);
    clearCurrentSession(repoDir, sessionId);
    assert.equal(getCurrentSession(repoDir), null);
  });

  it("does not clear a newer session marker when ids differ", () => {
    setCurrentSession(repoDir, "newer-session");
    clearCurrentSession(repoDir, sessionId);
    assert.equal(getCurrentSession(repoDir), "newer-session");
  });
});

describe("pending session cleanup markers", () => {
  const sessionIds = ["ended-session-a", "ended-session-b"];
  let repoDir;

  beforeEach(() => {
    repoDir = createTempGitRepo();
  });

  afterEach(() => {
    for (const sessionId of sessionIds) {
      clearSessionCleanupPending(repoDir, sessionId);
    }
    fs.rmSync(resolveStateDir(repoDir), { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("round-trips and clears ended-session ownership", () => {
    for (const sessionId of sessionIds) {
      markSessionCleanupPending(repoDir, sessionId);
    }
    markSessionCleanupPending(repoDir, sessionIds[0]);

    const stateDir = resolveStateDir(repoDir);
    fs.writeFileSync(path.join(stateDir, "unrelated.json"), JSON.stringify({
      sessionId: "unrelated-session",
    }));
    fs.writeFileSync(
      path.join(stateDir, "session-cleanup-pending-wrong-extension.txt"),
      JSON.stringify({ sessionId: "wrong-extension-session" })
    );
    fs.writeFileSync(
      path.join(stateDir, "session-cleanup-pending-malformed.json"),
      "{"
    );
    fs.writeFileSync(
      path.join(stateDir, "session-cleanup-pending-invalid-id.json"),
      JSON.stringify({ sessionId: "../invalid" })
    );
    const duplicateMarkerFile = path.join(
      stateDir,
      "session-cleanup-pending-duplicate.json"
    );
    fs.writeFileSync(
      duplicateMarkerFile,
      JSON.stringify({ sessionId: sessionIds[0] })
    );

    assert.deepEqual(
      new Set(listPendingSessionCleanups(repoDir)),
      new Set(sessionIds)
    );
    assert.equal(listPendingSessionCleanups(repoDir).length, sessionIds.length);

    fs.unlinkSync(duplicateMarkerFile);
    clearSessionCleanupPending(repoDir, sessionIds[0]);
    assert.deepEqual(listPendingSessionCleanups(repoDir), [sessionIds[1]]);
  });

  it("returns no pending cleanups when the state directory is absent", () => {
    assert.deepEqual(listPendingSessionCleanups(repoDir), []);
  });
});

// ---------------------------------------------------------------------------
// sanitizeId (tested indirectly via job functions)
// ---------------------------------------------------------------------------

describe("sanitizeId (via writeJobFile / readJobFile)", () => {
  it("accepts valid alphanumeric-dash-dot-underscore IDs", () => {
    const validIds = ["abc-123", "job_01", "review.v2", "a-b_c.d"];
    for (const id of validIds) {
      assert.doesNotThrow(() => {
        writeJobFile(PROJECT_CWD, id, { id, status: "test" });
      }, `Expected '${id}' to be accepted`);
      // Clean up
      try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${id}.json`)); } catch {}
    }
  });

  it("rejects path traversal attempts", () => {
    assert.throws(() => writeJobFile(PROJECT_CWD, "../etc", {}), /Invalid/);
    assert.throws(() => readJobFile(PROJECT_CWD, "../../passwd"), /Invalid/);
    assert.throws(() => writeJobFile(PROJECT_CWD, "/tmp/evil", {}), /Invalid/);
  });

  it("rejects IDs with spaces or special characters", () => {
    assert.throws(() => writeJobFile(PROJECT_CWD, "has space", {}), /Invalid/);
    assert.throws(() => writeJobFile(PROJECT_CWD, "semi;colon", {}), /Invalid/);
  });
});

// ---------------------------------------------------------------------------
// cleanupOldJobs
// ---------------------------------------------------------------------------

describe("cleanupOldJobs", () => {
  it("runs without error on an empty jobs directory", () => {
    assert.doesNotThrow(() => cleanupOldJobs(PROJECT_CWD));
  });

  it("does not remove non-terminal jobs", () => {
    const id = "test-cleanup-running";
    writeJobFile(PROJECT_CWD, id, { id, status: "running", createdAt: "2020-01-01T00:00:00Z" });
    try {
      cleanupOldJobs(PROJECT_CWD);
      const job = readJobFile(PROJECT_CWD, id);
      assert.ok(job, "Running job should not be cleaned up");
    } finally {
      try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${id}.json`)); } catch {}
    }
  });

  it("keeps the newest 100 terminal jobs per session", () => {
    const repoDir = createTempGitRepo();
    try {
      for (let i = 0; i < 105; i++) {
        const sessionAId = `test-retain-session-a-${i}`;
        writeJobFile(repoDir, sessionAId, {
          id: sessionAId,
          status: "completed",
          sessionId: "session-a",
          createdAt: new Date(Date.now() - i * 1000).toISOString(),
        });

        const sessionBId = `test-retain-session-b-${i}`;
        writeJobFile(repoDir, sessionBId, {
          id: sessionBId,
          status: "completed",
          sessionId: "session-b",
          createdAt: new Date(Date.now() - i * 1000).toISOString(),
        });
      }

      cleanupOldJobs(repoDir);

      const jobs = listJobs(repoDir);
      const terminalJobs = jobs.filter((job) => job.status === "completed");
      const sessionAJobs = terminalJobs.filter((job) => job.sessionId === "session-a");
      const sessionBJobs = terminalJobs.filter((job) => job.sessionId === "session-b");

      assert.equal(terminalJobs.length, 200);
      assert.equal(sessionAJobs.length, 100);
      assert.equal(sessionBJobs.length, 100);
      assert.ok(sessionAJobs.some((job) => job.id === "test-retain-session-a-0"));
      assert.ok(sessionAJobs.some((job) => job.id === "test-retain-session-a-99"));
      assert.ok(!sessionAJobs.some((job) => job.id === "test-retain-session-a-100"));
      assert.ok(!sessionAJobs.some((job) => job.id === "test-retain-session-a-104"));
      assert.ok(sessionBJobs.some((job) => job.id === "test-retain-session-b-0"));
      assert.ok(sessionBJobs.some((job) => job.id === "test-retain-session-b-99"));
      assert.ok(!sessionBJobs.some((job) => job.id === "test-retain-session-b-100"));
      assert.ok(!sessionBJobs.some((job) => job.id === "test-retain-session-b-104"));
    } finally {
      fs.rmSync(resolveStateDir(repoDir), { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("preserves active jobs while pruning old terminal job files and logs per session", () => {
    const repoDir = createTempGitRepo();
    try {
      const runningId = "test-retain-running";
      writeJobFile(repoDir, runningId, {
        id: runningId,
        status: "running",
        sessionId: "session-a",
        createdAt: new Date(Date.now() - 200_000).toISOString(),
      });

      const prunedId = "test-retain-pruned";
      writeJobFile(repoDir, prunedId, {
        id: prunedId,
        status: "completed",
        sessionId: "session-a",
        createdAt: new Date(Date.now() - 300_000).toISOString(),
        logFile: resolveJobLogFile(repoDir, prunedId),
      });
      fs.writeFileSync(resolveJobLogFile(repoDir, prunedId), "old log\n", "utf8");
      const prunedIdentityCheck = path.join(
        resolveJobsDir(repoDir),
        `${prunedId}.json.identity-check`
      );
      const prunedIdentityProbe = path.join(
        resolveJobsDir(repoDir),
        `${prunedId}.json.identity-probe`
      );
      const prunedIdentityUnavailable = path.join(
        resolveJobsDir(repoDir),
        `${prunedId}.json.identity-unavailable`
      );
      fs.writeFileSync(prunedIdentityCheck, "", "utf8");
      fs.writeFileSync(prunedIdentityProbe, "", "utf8");
      fs.writeFileSync(prunedIdentityUnavailable, "", "utf8");

      for (let i = 0; i < 100; i++) {
        const sessionAId = `test-retain-session-a-keep-${i}`;
        writeJobFile(repoDir, sessionAId, {
          id: sessionAId,
          status: "completed",
          sessionId: "session-a",
          createdAt: new Date(Date.now() - i * 1000).toISOString(),
        });

        const sessionBId = `test-retain-session-b-keep-${i}`;
        writeJobFile(repoDir, sessionBId, {
          id: sessionBId,
          status: "completed",
          sessionId: "session-b",
          createdAt: new Date(Date.now() - i * 1000).toISOString(),
        });
      }

      cleanupOldJobs(repoDir);

      const terminalJobs = listJobs(repoDir).filter((job) => job.status === "completed");
      const sessionAJobs = terminalJobs.filter((job) => job.sessionId === "session-a");
      const sessionBJobs = terminalJobs.filter((job) => job.sessionId === "session-b");

      assert.ok(readJobFile(repoDir, runningId), "running job should be preserved");
      assert.equal(readJobFile(repoDir, prunedId), null);
      assert.equal(fs.existsSync(resolveJobLogFile(repoDir, prunedId)), false);
      assert.equal(fs.existsSync(prunedIdentityCheck), false);
      assert.equal(fs.existsSync(prunedIdentityProbe), false);
      assert.equal(fs.existsSync(prunedIdentityUnavailable), false);
      assert.equal(sessionAJobs.length, 100);
      assert.equal(sessionBJobs.length, 100);
      assert.ok(sessionBJobs.some((job) => job.id === "test-retain-session-b-keep-99"));
    } finally {
      fs.rmSync(resolveStateDir(repoDir), { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does not unlink an arbitrary tampered logFile path while pruning old jobs", () => {
    const repoDir = createTempGitRepo();
    const outsideFile = path.join(os.tmpdir(), `claude-state-outside-${Date.now()}.log`);
    try {
      fs.writeFileSync(outsideFile, "keep me\n", "utf8");

      const prunedId = "test-retain-tampered-log";
      writeJobFile(repoDir, prunedId, {
        id: prunedId,
        status: "completed",
        sessionId: "session-a",
        createdAt: new Date(Date.now() - 300_000).toISOString(),
        logFile: outsideFile,
      });

      for (let i = 0; i < 100; i++) {
        const keepId = `test-retain-session-a-safe-${i}`;
        writeJobFile(repoDir, keepId, {
          id: keepId,
          status: "completed",
          sessionId: "session-a",
          createdAt: new Date(Date.now() - i * 1000).toISOString(),
        });
      }

      cleanupOldJobs(repoDir);

      assert.equal(readJobFile(repoDir, prunedId), null);
      assert.equal(fs.existsSync(outsideFile), true);
    } finally {
      try {
        fs.unlinkSync(outsideFile);
      } catch {}
      fs.rmSync(resolveStateDir(repoDir), { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("removes stale reservation and staged-lock files", () => {
    const repoDir = createTempGitRepo();
    try {
      const jobsDir = resolveJobsDir(repoDir);
      fs.mkdirSync(jobsDir, { recursive: true });
      const staleReservation = path.join(jobsDir, "review-stale.reserve");
      const freshReservation = path.join(jobsDir, "review-fresh.reserve");
      const staleStagedLock = path.join(
        jobsDir,
        `review-stale.json.lock.publish.123.${"a".repeat(32)}`
      );
      const freshStagedLock = path.join(
        jobsDir,
        `review-fresh.json.lock.publish.123.${"b".repeat(32)}`
      );
      const deceptiveId = "review.json.lock.publish.123";
      const deceptiveJobFile = path.join(jobsDir, `${deceptiveId}.json`);
      fs.writeFileSync(staleReservation, "{}", "utf8");
      fs.writeFileSync(freshReservation, "{}", "utf8");
      fs.writeFileSync(staleStagedLock, "{}", "utf8");
      fs.writeFileSync(freshStagedLock, "{}", "utf8");
      writeJobFile(repoDir, deceptiveId, {
        id: deceptiveId,
        status: "running",
        createdAt: nowIso(),
      });

      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      fs.utimesSync(staleReservation, twoHoursAgo / 1000, twoHoursAgo / 1000);
      fs.utimesSync(staleStagedLock, twoHoursAgo / 1000, twoHoursAgo / 1000);
      fs.utimesSync(deceptiveJobFile, twoHoursAgo / 1000, twoHoursAgo / 1000);

      cleanupOldJobs(repoDir);

      assert.equal(fs.existsSync(staleReservation), false);
      assert.equal(fs.existsSync(freshReservation), true);
      assert.equal(fs.existsSync(staleStagedLock), false);
      assert.equal(fs.existsSync(freshStagedLock), true);
      assert.ok(readJobFile(repoDir, deceptiveId));
    } finally {
      fs.rmSync(resolveStateDir(repoDir), { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("continues cleaning later reserved markers when one entry errors", () => {
    const repoDir = createTempGitRepo();
    const originalStatSync = fs.statSync;
    try {
      const jobsDir = resolveJobsDir(repoDir);
      fs.mkdirSync(jobsDir, { recursive: true });
      const badReservation = path.join(jobsDir, "review-bad.reserve");
      const staleReservation = path.join(jobsDir, "review-stale.reserve");
      fs.writeFileSync(badReservation, "{}", "utf8");
      fs.writeFileSync(staleReservation, "{}", "utf8");

      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      fs.utimesSync(badReservation, twoHoursAgo / 1000, twoHoursAgo / 1000);
      fs.utimesSync(staleReservation, twoHoursAgo / 1000, twoHoursAgo / 1000);

      Reflect.set(fs, "statSync", (targetPath, ...args) => {
        if (targetPath === badReservation) {
          const error = /** @type {NodeJS.ErrnoException} */ (
            new Error("synthetic stat failure")
          );
          error.code = "EIO";
          throw error;
        }
        return originalStatSync(targetPath, ...args);
      });

      cleanupOldJobs(repoDir);

      assert.equal(fs.existsSync(badReservation), true);
      assert.equal(fs.existsSync(staleReservation), false);
    } finally {
      Reflect.set(fs, "statSync", originalStatSync);
      fs.rmSync(resolveStateDir(repoDir), { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// reapStaleJobs
// ---------------------------------------------------------------------------

describe("reapStaleJobs", () => {
  const staleTimestamp = () => new Date(Date.now() - 5_000).toISOString();
  const staleQueuedWithoutPidTimestamp = () => new Date(Date.now() - 31_000).toISOString();
  const backdateJob = (id, timestamp) => {
    const jobFile = path.join(resolveJobsDir(PROJECT_CWD), `${id}.json`);
    const current = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    fs.writeFileSync(
      jobFile,
      JSON.stringify(
        {
          ...current,
          createdAt: timestamp,
          startedAt: timestamp,
          updatedAt: timestamp,
        },
        null,
        2
      ),
      "utf8"
    );
  };

  afterEach(() => {
    // Clean up test job files
    const jobsDir = resolveJobsDir(PROJECT_CWD);
    for (const f of fs.readdirSync(jobsDir)) {
      if (f.startsWith("test-reap-")) {
        try { fs.unlinkSync(path.join(jobsDir, f)); } catch {}
      }
    }
  });

  it("transitions running job with dead PID to failed", () => {
    const id = "test-reap-dead";
    const deadPid = 99999999; // Almost certainly not running
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: deadPid,
      pidIdentity: "bogus-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());

    const jobs = [readJobFile(PROJECT_CWD, id)];
    const result = reapStaleJobs(PROJECT_CWD, jobs);

    assert.equal(result.length, 1);
    assert.equal(result[0].status, "failed");
    assert.ok(result[0].errorMessage.includes("Auto-reaped"));
    assert.equal(result[0].pid, null);
    assert.equal(result[0].pidIdentity, null);
    assert.ok(result[0].completedAt);
  });

  it("keeps a running job while its owning worker is alive after the Claude PID exits", () => {
    const id = "test-reap-live-worker";
    const claudePid = 11111;
    const workerPid = 22222;
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: claudePid,
      pidIdentity: "claude-identity",
      workerPid,
      workerPidIdentity: "worker-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());
    const checkedPids = [];

    const result = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      {
        platform: "linux",
        isProcessAliveImpl: (pid) => {
          checkedPids.push(pid);
          return pid === workerPid;
        },
        getProcessIdentityImpl: (pid) =>
          pid === workerPid ? "worker-identity" : "claude-identity",
      }
    );

    assert.deepEqual(checkedPids, [workerPid]);
    assert.equal(result[0].status, "running");
    assert.equal(result[0].pid, claudePid);
    assert.equal(result[0].workerPid, workerPid);
  });

  it("falls back to the identity-checked Claude PID when worker identity is missing", () => {
    const id = "test-reap-worker-no-identity";
    const claudePid = 11113;
    const workerPid = 22224;
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: claudePid,
      pidIdentity: "claude-identity",
      workerPid,
      workerPidIdentity: null,
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());
    const checkedPids = [];

    const result = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      {
        platform: "linux",
        isProcessAliveImpl: (pid) => {
          checkedPids.push(pid);
          return false;
        },
        getProcessIdentityImpl: () => "claude-identity",
      }
    );

    assert.deepEqual(checkedPids, [claudePid]);
    assert.equal(result[0].status, "failed");
  });

  it("terminates a live Claude child when its owning worker dies", () => {
    const id = "test-reap-dead-worker-live-child";
    const claudePid = 11114;
    const workerPid = 22225;
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: claudePid,
      pidIdentity: "claude-identity",
      workerPid,
      workerPidIdentity: "worker-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());
    const terminated = [];

    const result = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      {
        platform: "linux",
        isProcessAliveImpl: (pid) => pid === claudePid,
        getProcessIdentityImpl: () => "worker-identity",
        terminateProcessTreeIfIdentityMatchesImpl: (pid, identity) => {
          terminated.push([pid, identity]);
          return { attempted: true, delivered: true };
        },
      }
    );

    assert.deepEqual(terminated, [[claudePid, "claude-identity"]]);
    assert.equal(result[0].status, "failed");
    assert.equal(result[0].pid, null);
    assert.equal(result[0].pidIdentity, null);
  });

  it("bounds Windows Claude child cleanup to the reaper identity timeout", () => {
    const id = "test-reap-dead-worker-windows-child-timeout";
    const claudePid = 11116;
    const workerPid = 22227;
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: claudePid,
      pidIdentity: "123456789",
      workerPid,
      workerPidIdentity: "987654321",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());
    /** @type {{ timeout?: number } | null} */
    let cleanupOptions = null;

    reapStaleJobs(PROJECT_CWD, [readJobFile(PROJECT_CWD, id)], {
      platform: "win32",
      isProcessAliveImpl: (pid) => pid === claudePid,
      getProcessIdentityImpl: () => "987654321",
      terminateProcessTreeIfIdentityMatchesImpl: (_pid, _identity, options) => {
        cleanupOptions = options;
        return { attempted: true, delivered: true };
      },
    });

    assert.equal(cleanupOptions?.timeout, 2_000);
  });

  it("clears a recycled Claude child PID when its owning worker dies", () => {
    const id = "test-reap-dead-worker-recycled-child";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: 11115,
      pidIdentity: "old-claude-identity",
      workerPid: 22226,
      workerPidIdentity: "worker-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());

    const result = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      {
        platform: "linux",
        isProcessAliveImpl: () => false,
        getProcessIdentityImpl: () => "worker-identity",
        terminateProcessTreeIfIdentityMatchesImpl: () => ({
          attempted: false,
          delivered: false,
          reason: "identity-mismatch",
        }),
      }
    );

    assert.equal(result[0].status, "failed");
    assert.equal(result[0].pid, null);
    assert.equal(result[0].pidIdentity, null);
    assert.doesNotMatch(result[0].errorMessage, /manual cleanup/i);
  });

  it("clears an identity-unavailable Claude child after confirming it is dead", () => {
    const id = "test-reap-dead-worker-dead-unidentified-child";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: 11117,
      pidIdentity: null,
      workerPid: 22228,
      workerPidIdentity: "worker-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());

    const result = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      {
        platform: "linux",
        isProcessAliveImpl: () => false,
        getProcessIdentityImpl: () => "worker-identity",
        terminateProcessTreeIfIdentityMatchesImpl: () => ({
          attempted: false,
          delivered: false,
          reason: "identity-unavailable",
        }),
      }
    );

    assert.equal(result[0].status, "failed");
    assert.equal(result[0].pid, null);
    assert.equal(result[0].pidIdentity, null);
    assert.doesNotMatch(result[0].errorMessage, /manual cleanup/i);
  });

  it("reports cancel_failed when a live Claude child cannot be cleaned up", () => {
    const id = "test-reap-cancelling-dead-worker-live-child";
    const claudePid = 11118;
    const workerPid = 22229;
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "cancelling",
      pid: claudePid,
      pidIdentity: null,
      workerPid,
      workerPidIdentity: "worker-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());

    const result = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      {
        platform: "linux",
        isProcessAliveImpl: (pid) => pid === claudePid,
        getProcessIdentityImpl: () => "worker-identity",
        terminateProcessTreeIfIdentityMatchesImpl: () => ({
          attempted: false,
          delivered: false,
          reason: "identity-unavailable",
        }),
      }
    );

    assert.equal(result[0].status, "cancel_failed");
    assert.equal(result[0].pid, claudePid);
    assert.equal(result[0].phase, "cancel_failed");
    assert.match(result[0].errorMessage, /manual cleanup/i);
  });

  it("transitions queued job with dead worker PID to failed", () => {
    const id = "test-reap-queued-dead";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "queued",
      pid: 99999999,
      pidIdentity: "bogus-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());

    const result = reapStaleJobs(PROJECT_CWD, [readJobFile(PROJECT_CWD, id)]);

    assert.equal(result[0].status, "failed");
    assert.ok(result[0].errorMessage.includes("Auto-reaped"));
  });

  it("transitions stale queued job without a recorded worker PID to failed", () => {
    const id = "test-reap-queued-nopid";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "queued",
      pid: null,
      createdAt: nowIso(),
    });
    backdateJob(id, staleQueuedWithoutPidTimestamp());

    const result = reapStaleJobs(PROJECT_CWD, [readJobFile(PROJECT_CWD, id)]);

    assert.equal(result[0].status, "failed");
    assert.match(result[0].errorMessage, /Worker did not start/);
  });

  it("keeps queued jobs without a worker PID during the extended startup grace window", () => {
    const id = "test-reap-queued-nopid-grace";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "queued",
      pid: null,
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());

    const result = reapStaleJobs(PROJECT_CWD, [readJobFile(PROJECT_CWD, id)]);

    assert.equal(result[0].status, "queued");
    assert.equal(result[0].pid, null);
  });

  it("does not touch running job with alive PID", () => {
    const id = "test-reap-alive";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: process.pid, // This process is alive
      createdAt: nowIso(),
    });

    const jobs = [readJobFile(PROJECT_CWD, id)];
    const result = reapStaleJobs(PROJECT_CWD, jobs);

    assert.equal(result.length, 1);
    assert.equal(result[0].status, "running");
  });

  it("keeps Windows read paths cheap for a live PID with stored identity", () => {
    const id = "test-reap-windows-alive";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: process.pid,
      pidIdentity: "stored-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());
    let identityChecks = 0;

    const result = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      {
        platform: "win32",
        isProcessAliveImpl: () => true,
        getProcessIdentityImpl: () => {
          identityChecks += 1;
          return "different-identity";
        },
      }
    );

    assert.equal(identityChecks, 0);
    assert.equal(result[0].status, "running");
  });

  it("rechecks a silent Windows job after the bounded liveness shortcut", () => {
    const id = "test-reap-windows-recycled";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: process.pid,
      pidIdentity: "old-process-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, new Date(Date.now() - 301_000).toISOString());
    let identityChecks = 0;

    const result = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      {
        platform: "win32",
        isProcessAliveImpl: () => true,
        getProcessIdentityImpl: () => {
          identityChecks += 1;
          return "different-identity";
        },
      }
    );

    assert.equal(identityChecks, 1);
    assert.equal(result[0].status, "failed");
  });

  it("does not look up identity after liveness already failed", () => {
    const id = "test-reap-dead-no-identity";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: 99_999_999,
      pidIdentity: "stored-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, new Date(Date.now() - 301_000).toISOString());
    let identityChecks = 0;

    const result = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      {
        platform: "win32",
        isProcessAliveImpl: () => false,
        getProcessIdentityImpl: () => {
          identityChecks += 1;
          return "stored-identity";
        },
      }
    );

    assert.equal(identityChecks, 0);
    assert.equal(result[0].status, "failed");
  });

  it("reaps a live PID when its directly read identity mismatches", () => {
    const id = "test-reap-direct-identity-mismatch";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: process.pid,
      pidIdentity: "stored-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());

    const result = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      {
        platform: "linux",
        isProcessAliveImpl: () => true,
        getProcessIdentityImpl: () => "different-identity",
      }
    );

    assert.equal(result[0].status, "failed");
  });

  it("does not refresh POSIX jobs whose identity matches", () => {
    const id = "test-reap-posix-match";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: process.pid,
      pidIdentity: "stored-identity",
      createdAt: nowIso(),
    });
    const timestamp = staleTimestamp();
    backdateJob(id, timestamp);

    const result = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      {
        platform: "linux",
        isProcessAliveImpl: () => true,
        getProcessIdentityImpl: () => "stored-identity",
      }
    );

    assert.equal(result[0].status, "running");
    assert.equal(result[0].updatedAt, timestamp);
    assert.equal(readJobFile(PROJECT_CWD, id).updatedAt, timestamp);
  });

  it("rate-limits successful Windows identity rechecks across job reads", () => {
    const id = "test-reap-windows-cooldown";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: process.pid,
      pidIdentity: "stored-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, new Date(Date.now() - 301_000).toISOString());
    let identityChecks = 0;
    const options = {
      platform: "win32",
      isProcessAliveImpl: () => true,
      getProcessIdentityImpl: () => {
        identityChecks += 1;
        return "stored-identity";
      },
    };

    const first = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      options
    );
    const second = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      options
    );

    assert.equal(first[0].status, "running");
    assert.equal(second[0].status, "running");
    assert.equal(first[0].updatedAt, readJobFile(PROJECT_CWD, id).updatedAt);
    assert.equal(first[0].updatedAt, first[0].createdAt);
    assert.equal(identityChecks, 1);
    assert.equal(
      fs.readFileSync(
        path.join(resolveJobsDir(PROJECT_CWD), `${id}.json.identity-check`),
        "utf8"
      ),
      "verified\n"
    );
  });

  it("starts the Windows unverifiable ceiling at the first unavailable probe", () => {
    const id = "test-reap-windows-first-unavailable";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: process.pid,
      pidIdentity: "stored-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, new Date(Date.now() - 301_000).toISOString());
    let identityUnavailable = false;
    const options = {
      platform: "win32",
      isProcessAliveImpl: () => true,
      getProcessIdentityImpl: () => {
        if (identityUnavailable) {
          throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
        }
        return "stored-identity";
      },
    };

    const verified = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      options
    );
    const identityCheckFile = path.join(
      resolveJobsDir(PROJECT_CWD),
      `${id}.json.identity-check`
    );
    const identityProbeFile = path.join(
      resolveJobsDir(PROJECT_CWD),
      `${id}.json.identity-probe`
    );
    const identityUnavailableFile = path.join(
      resolveJobsDir(PROJECT_CWD),
      `${id}.json.identity-unavailable`
    );
    const leaseExpired = new Date(Date.now() - 301_000);
    fs.utimesSync(identityCheckFile, leaseExpired, leaseExpired);
    fs.utimesSync(identityProbeFile, leaseExpired, leaseExpired);
    identityUnavailable = true;

    const firstUnavailable = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      options
    );
    const firstUnavailableMtime =
      fs.statSync(identityUnavailableFile).mtimeMs;

    const fourteenMinutesAgo = new Date(Date.now() - 14 * 60 * 1000);
    fs.utimesSync(
      identityUnavailableFile,
      fourteenMinutesAgo,
      fourteenMinutesAgo
    );
    fs.utimesSync(identityProbeFile, leaseExpired, leaseExpired);
    const beforeCeiling = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      options
    );

    const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000);
    fs.utimesSync(
      identityUnavailableFile,
      sixteenMinutesAgo,
      sixteenMinutesAgo
    );
    fs.utimesSync(identityProbeFile, leaseExpired, leaseExpired);
    const afterCeiling = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      options
    );

    assert.equal(verified[0].status, "running");
    assert.equal(firstUnavailable[0].status, "running");
    assert.ok(firstUnavailableMtime > leaseExpired.getTime());
    assert.equal(beforeCeiling[0].status, "running");
    assert.equal(afterCeiling[0].status, "failed");
    assert.equal(afterCeiling[0].reapedUnverifiable, true);
  });

  it("keeps timed-out Windows identity checks alive and rate-limited", () => {
    const id = "test-reap-windows-timeout";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: process.pid,
      pidIdentity: "stored-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, new Date(Date.now() - 301_000).toISOString());
    let identityChecks = 0;
    const options = {
      platform: "win32",
      isProcessAliveImpl: () => true,
      getProcessIdentityImpl: (_pid, identityOptions) => {
        identityChecks += 1;
        assert.equal(identityOptions.timeout, 2_000);
        throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      },
    };

    const first = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      options
    );
    const identityUnavailableFile = path.join(
      resolveJobsDir(PROJECT_CWD),
      `${id}.json.identity-unavailable`
    );
    const identityProbeFile = path.join(
      resolveJobsDir(PROJECT_CWD),
      `${id}.json.identity-probe`
    );
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
    fs.utimesSync(identityUnavailableFile, sixMinutesAgo, sixMinutesAgo);
    const firstUnavailableMtime =
      fs.statSync(identityUnavailableFile).mtimeMs;
    const firstProbeMtime = fs.statSync(identityProbeFile).mtimeMs;
    const second = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      options
    );

    assert.equal(first[0].status, "running");
    assert.equal(second[0].status, "running");
    assert.equal(identityChecks, 1);
    assert.equal(
      fs.readFileSync(identityUnavailableFile, "utf8"),
      "unavailable\n"
    );
    assert.equal(fs.readFileSync(identityProbeFile, "utf8"), "unavailable\n");
    assert.equal(
      fs.statSync(identityUnavailableFile).mtimeMs,
      firstUnavailableMtime
    );
    assert.equal(fs.statSync(identityProbeFile).mtimeMs, firstProbeMtime);
  });

  it("fails open when a Windows identity marker cannot be created", () => {
    const id = "test-reap-windows-marker-unwritable";
    const originalWriteFileSync = fs.writeFileSync;
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: process.pid,
      pidIdentity: "stored-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, new Date(Date.now() - 901_000).toISOString());
    const identityUnavailableFile = path.join(
      resolveJobsDir(PROJECT_CWD),
      `${id}.json.identity-unavailable`
    );

    try {
      Reflect.set(fs, "writeFileSync", (filePath, ...args) => {
        if (filePath === identityUnavailableFile) {
          throw Object.assign(new Error("marker denied"), { code: "EACCES" });
        }
        return originalWriteFileSync(filePath, ...args);
      });

      const result = reapStaleJobs(
        PROJECT_CWD,
        [readJobFile(PROJECT_CWD, id)],
        {
          platform: "win32",
          isProcessAliveImpl: () => true,
          getProcessIdentityImpl: () => {
            throw Object.assign(new Error("timed out"), {
              code: "ETIMEDOUT",
            });
          },
        }
      );

      assert.equal(result[0].status, "running");
      assert.equal(fs.existsSync(identityUnavailableFile), false);
    } finally {
      Reflect.set(fs, "writeFileSync", originalWriteFileSync);
    }
  });

  it("fails a Windows job after identity stays unverifiable beyond the hard ceiling", () => {
    const id = "test-reap-windows-unverifiable-expired";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: process.pid,
      pidIdentity: "stored-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, new Date(Date.now() - 301_000).toISOString());
    const identityUnavailableFile = path.join(
      resolveJobsDir(PROJECT_CWD),
      `${id}.json.identity-unavailable`
    );
    fs.writeFileSync(identityUnavailableFile, "unavailable\n");
    const expired = new Date(Date.now() - 901_000);
    fs.utimesSync(identityUnavailableFile, expired, expired);

    const result = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      {
        platform: "win32",
        isProcessAliveImpl: () => true,
        getProcessIdentityImpl: () => {
          throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
        },
      }
    );

    assert.equal(result[0].status, "failed");
    assert.equal(result[0].pid, process.pid);
    assert.equal(result[0].pidIdentity, "stored-identity");
    assert.equal(result[0].reapedUnverifiable, true);
    assert.match(result[0].errorMessage, /identity remained unverifiable/i);
  });

  it("preserves manual cleanup handles when cancelling identity stays unverifiable", () => {
    const id = "test-reap-windows-cancelling-unverifiable";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "cancelling",
      pid: process.pid,
      pidIdentity: "stored-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, new Date(Date.now() - 301_000).toISOString());
    const identityUnavailableFile = path.join(
      resolveJobsDir(PROJECT_CWD),
      `${id}.json.identity-unavailable`
    );
    fs.writeFileSync(identityUnavailableFile, "unavailable\n");
    const expired = new Date(Date.now() - 901_000);
    fs.utimesSync(identityUnavailableFile, expired, expired);

    const result = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      {
        platform: "win32",
        isProcessAliveImpl: () => true,
        getProcessIdentityImpl: () => {
          throw new Error("CIM unavailable");
        },
      }
    );

    assert.equal(result[0].status, "cancel_failed");
    assert.equal(result[0].pid, process.pid);
    assert.equal(result[0].pidIdentity, "stored-identity");
    assert.equal(result[0].pgid, process.pid);
  });

  it("keeps jobs alive when identity lookup races cannot be verified", () => {
    const id = "test-reap-identity-race";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: process.pid,
      pidIdentity: "stored-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());

    const result = reapStaleJobs(
      PROJECT_CWD,
      [readJobFile(PROJECT_CWD, id)],
      {
        platform: "linux",
        isProcessAliveImpl: () => true,
        getProcessIdentityImpl: () => {
          throw new Error("process exited between checks");
        },
      }
    );

    assert.equal(result[0].status, "running");
    assert.equal(result[0].pid, process.pid);
  });

  it("keeps recently updated running job alive during the reap grace window", () => {
    const id = "test-reap-recent";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: 99999999,
      pidIdentity: "bogus-identity",
      createdAt: nowIso(),
      startedAt: nowIso(),
    });

    const jobs = [readJobFile(PROJECT_CWD, id)];
    const result = reapStaleJobs(PROJECT_CWD, jobs);

    assert.equal(result.length, 1);
    assert.equal(result[0].status, "running");
  });

  it("does not touch running job with no PID (pre-spawn)", () => {
    const id = "test-reap-nopid";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: null,
      createdAt: nowIso(),
    });

    const jobs = [readJobFile(PROJECT_CWD, id)];
    const result = reapStaleJobs(PROJECT_CWD, jobs);

    assert.equal(result.length, 1);
    assert.equal(result[0].status, "running");
  });

  it("does not touch completed/failed jobs", () => {
    const id1 = "test-reap-completed";
    const id2 = "test-reap-failed";
    writeJobFile(PROJECT_CWD, id1, {
      id: id1,
      status: "completed",
      pid: 99999999,
      createdAt: nowIso(),
    });
    writeJobFile(PROJECT_CWD, id2, {
      id: id2,
      status: "failed",
      pid: 99999999,
      createdAt: nowIso(),
    });

    const jobs = [readJobFile(PROJECT_CWD, id1), readJobFile(PROJECT_CWD, id2)];
    const result = reapStaleJobs(PROJECT_CWD, jobs);

    assert.equal(result[0].status, "completed");
    assert.equal(result[1].status, "failed");
  });

  it("reaps cancelling job with dead PID as cancelled", () => {
    const id = "test-reap-cancelling";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "cancelling",
      pid: 99999999,
      pidIdentity: "bogus",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());

    const jobs = [readJobFile(PROJECT_CWD, id)];
    const result = reapStaleJobs(PROJECT_CWD, jobs);

    assert.equal(result[0].status, "cancelled");
    assert.match(result[0].errorMessage, /Cancelled by user/);
  });

  it("listJobs integrates the reaper automatically", () => {
    const id = "test-reap-integration";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: 99999999,
      pidIdentity: "bogus",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());

    const jobs = listJobs(PROJECT_CWD);
    const found = jobs.find((j) => j.id === id);
    assert.ok(found);
    assert.equal(found.status, "failed");
    assert.ok(found.errorMessage.includes("Auto-reaped"));
  });
});
