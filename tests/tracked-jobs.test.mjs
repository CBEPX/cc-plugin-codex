/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";

import {
  SESSION_ID_ENV,
  MAX_JOB_LOG_BYTES,
  nowIso,
  appendLogLine,
  appendLogBlock,
  createJobLogFile,
  createWorkerLogStdio,
  createJobProgressUpdater,
  createJobRecord,
  runTrackedJob,
} from "../scripts/lib/tracked-jobs.mjs";
import { clearCurrentSession, ensureStateDir, readJobFile, resolveJobFile, resolveJobLogFile, setCurrentSession, writeJobFile } from "../scripts/lib/state.mjs";

const PROJECT_CWD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createTempGitRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracked-jobs-session-"));
  const init = spawnSync("git", ["init", "--initial-branch=main"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  return repoDir;
}

function isLockBusyError(error) {
  return /** @type {NodeJS.ErrnoException} */ (error).code === "ELOCKBUSY";
}

// ---------------------------------------------------------------------------
// SESSION_ID_ENV
// ---------------------------------------------------------------------------

describe("SESSION_ID_ENV", () => {
  it("is the expected environment variable name", () => {
    assert.equal(SESSION_ID_ENV, "CLAUDE_COMPANION_SESSION_ID");
  });
});

// ---------------------------------------------------------------------------
// nowIso (re-exported)
// ---------------------------------------------------------------------------

describe("nowIso (tracked-jobs re-export)", () => {
  it("returns a valid ISO timestamp", () => {
    const ts = nowIso();
    assert.ok(typeof ts === "string");
    const parsed = Date.parse(ts);
    assert.ok(Number.isFinite(parsed));
    assert.ok(Math.abs(Date.now() - parsed) < 5000);
  });
});

// ---------------------------------------------------------------------------
// appendLogLine
// ---------------------------------------------------------------------------

describe("appendLogLine", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-test-"));
  });

  afterEach(() => {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
  });

  it("appends timestamped line to file", () => {
    const logFile = path.join(tmpDir, "test.log");
    fs.writeFileSync(logFile, "", "utf8");
    appendLogLine(logFile, "hello");
    const content = fs.readFileSync(logFile, "utf8");
    assert.match(content, /\[.+\] hello\n/);
  });

  it("appends multiple lines", () => {
    const logFile = path.join(tmpDir, "multi.log");
    fs.writeFileSync(logFile, "", "utf8");
    appendLogLine(logFile, "line 1");
    appendLogLine(logFile, "line 2");
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
  });

  it("skips null/empty messages", () => {
    const logFile = path.join(tmpDir, "skip.log");
    fs.writeFileSync(logFile, "", "utf8");
    appendLogLine(logFile, null);
    appendLogLine(logFile, "");
    appendLogLine(logFile, "  ");
    const content = fs.readFileSync(logFile, "utf8");
    assert.equal(content, "");
  });

  it("is a no-op when logFile is null", () => {
    // Should not throw
    appendLogLine(null, "hello");
  });

  it("trims oversized logs to the configured byte cap", () => {
    const logFile = path.join(tmpDir, "bounded.log");
    fs.writeFileSync(logFile, "", "utf8");

    appendLogLine(logFile, "header");
    appendLogLine(logFile, "x".repeat(MAX_JOB_LOG_BYTES));

    const content = fs.readFileSync(logFile, "utf8");
    assert.ok(Buffer.byteLength(content, "utf8") <= MAX_JOB_LOG_BYTES);
    assert.ok(content.includes("truncated"), "expected truncation marker");
    assert.ok(content.endsWith("\n"));
  });
});

// ---------------------------------------------------------------------------
// appendLogBlock
// ---------------------------------------------------------------------------

describe("appendLogBlock", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "block-test-"));
  });

  afterEach(() => {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
  });

  it("appends a titled block", () => {
    const logFile = path.join(tmpDir, "block.log");
    fs.writeFileSync(logFile, "", "utf8");
    appendLogBlock(logFile, "Summary", "some body text");
    const content = fs.readFileSync(logFile, "utf8");
    assert.ok(content.includes("Summary"));
    assert.ok(content.includes("some body text"));
  });

  it("skips when body is null", () => {
    const logFile = path.join(tmpDir, "nobody.log");
    fs.writeFileSync(logFile, "", "utf8");
    appendLogBlock(logFile, "Title", null);
    assert.equal(fs.readFileSync(logFile, "utf8"), "");
  });

  it("skips when logFile is null", () => {
    appendLogBlock(null, "Title", "body"); // no-op
  });

  it("retains the newest block content when the file exceeds the byte cap", () => {
    const logFile = path.join(tmpDir, "bounded-block.log");
    fs.writeFileSync(logFile, "", "utf8");

    appendLogBlock(logFile, "Old", "a".repeat(MAX_JOB_LOG_BYTES));
    appendLogBlock(logFile, "New", "latest-body");

    const content = fs.readFileSync(logFile, "utf8");
    assert.ok(Buffer.byteLength(content, "utf8") <= MAX_JOB_LOG_BYTES);
    assert.ok(content.includes("latest-body"));
  });
});

describe("createWorkerLogStdio", () => {
  it("appends detached worker stdout and stderr to the job log", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-log-"));
    const logFile = path.join(tmpDir, "worker.log");
    fs.writeFileSync(logFile, "", "utf8");

    const workerLog = createWorkerLogStdio(logFile);
    try {
      const result = spawnSync(
        process.execPath,
        ["-e", "process.stdout.write('worker out\\n'); process.stderr.write('worker err\\n')"],
        { stdio: workerLog.stdio }
      );
      assert.equal(result.status, 0);
    } finally {
      workerLog.close();
    }

    const content = fs.readFileSync(logFile, "utf8");
    assert.match(content, /worker out/);
    assert.match(content, /worker err/);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// createJobLogFile
// ---------------------------------------------------------------------------

describe("createJobLogFile", () => {
  it("creates an empty log file and writes a title line", () => {
    const logFile = createJobLogFile(PROJECT_CWD, "test-log-job", "code review");
    assert.ok(fs.existsSync(logFile));
    const content = fs.readFileSync(logFile, "utf8");
    assert.ok(content.includes("Starting code review."));
    // Cleanup
    fs.unlinkSync(logFile);
  });

  it("creates log file without title", () => {
    const logFile = createJobLogFile(PROJECT_CWD, "test-no-title", null);
    assert.ok(fs.existsSync(logFile));
    const content = fs.readFileSync(logFile, "utf8");
    assert.equal(content, "");
    fs.unlinkSync(logFile);
  });
});

// ---------------------------------------------------------------------------
// createJobRecord
// ---------------------------------------------------------------------------

describe("createJobRecord", () => {
  afterEach(() => {
    clearCurrentSession(PROJECT_CWD);
  });

  it("adds createdAt timestamp", () => {
    const record = createJobRecord({ id: "j1", kind: "review" });
    assert.ok(record.createdAt);
    assert.ok(Date.parse(record.createdAt) > 0);
  });

  it("preserves base fields", () => {
    const record = createJobRecord({ id: "j1", kind: "review", title: "My Review" });
    assert.equal(record.id, "j1");
    assert.equal(record.kind, "review");
    assert.equal(record.title, "My Review");
  });

  it("picks up sessionId from env", () => {
    const record = createJobRecord({ id: "j1" }, {
      env: { [SESSION_ID_ENV]: "sess-abc" },
    });
    assert.equal(record.sessionId, "sess-abc");
  });

  it("omits sessionId when env var is not set", () => {
    const record = createJobRecord({ id: "j1" }, { env: {} });
    assert.equal(record.sessionId, undefined);
  });

  it("falls back to the current session marker when env is unset", () => {
    const repoDir = createTempGitRepo();
    try {
      setCurrentSession(repoDir, "fallback-session");
      const record = createJobRecord({ id: "j1" }, { env: {}, cwd: repoDir });
      assert.equal(record.sessionId, "fallback-session");
    } finally {
      clearCurrentSession(repoDir);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("supports custom sessionIdEnv", () => {
    const record = createJobRecord({ id: "j1" }, {
      env: { CUSTOM_SESSION: "custom-123" },
      sessionIdEnv: "CUSTOM_SESSION",
    });
    assert.equal(record.sessionId, "custom-123");
  });

  it("prefers an explicit sessionId override over env and marker fallbacks", () => {
    const repoDir = createTempGitRepo();
    try {
      setCurrentSession(repoDir, "marker-session");
      const record = createJobRecord(
        { id: "j1" },
        {
          env: { [SESSION_ID_ENV]: "env-session" },
          cwd: repoDir,
          sessionId: "owner-session",
        }
      );
      assert.equal(record.sessionId, "owner-session");
    } finally {
      clearCurrentSession(repoDir);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// createJobProgressUpdater
// ---------------------------------------------------------------------------

describe("createJobProgressUpdater", () => {
  it("does not overwrite a terminal phase with late progress", () => {
    const repoDir = createTempGitRepo();
    const job = {
      id: "tracked-terminal-phase-job",
      workspaceRoot: repoDir,
      status: "completed",
      phase: "done",
      title: "terminal phase",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    writeJobFile(repoDir, job.id, job);

    try {
      const updateProgress = createJobProgressUpdater(repoDir, job.id);
      updateProgress({ phase: "subagent", message: "late delta" });

      const stored = readJobFile(repoDir, job.id);
      assert.equal(stored.status, "completed");
      assert.equal(stored.phase, "done");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("persists model fallback progress on the running job", () => {
    const repoDir = createTempGitRepo();
    const job = {
      id: "tracked-model-fallback-job",
      workspaceRoot: repoDir,
      status: "running",
      phase: "running",
      title: "model fallback",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    writeJobFile(repoDir, job.id, job);

    try {
      const updateProgress = createJobProgressUpdater(repoDir, job.id);
      updateProgress({
        phase: "model_fallback",
        modelFallback: {
          fromModel: "claude-opus-4-8",
          toModel: "claude-sonnet-5",
          reason: "capacity",
          source: "model_fallback",
        },
      });
      updateProgress({
        phase: "model_fallback",
        modelFallback: {
          fromModel: "claude-opus-4-8",
          toModel: "claude-sonnet-5",
          reason: "capacity",
          source: "model_fallback",
        },
      });

      const saved = readJobFile(repoDir, job.id);
      assert.equal(saved.phase, "model_fallback");
      assert.equal(saved.modelFallbacks.length, 1);
      assert.equal(saved.modelFallbacks[0].fromModel, "claude-opus-4-8");
      assert.equal(saved.modelFallbacks[0].toModel, "claude-sonnet-5");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runTrackedJob
// ---------------------------------------------------------------------------

describe("runTrackedJob", () => {
  it("does not revive a queued job after cancellation wins before startup", async () => {
    const repoDir = createTempGitRepo();
    const job = {
      id: "tracked-startup-cancel-race",
      workspaceRoot: repoDir,
      status: "queued",
      title: "startup race",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    writeJobFile(repoDir, job.id, {
      ...job,
      status: "cancelling",
    });
    let runnerCalled = false;

    await assert.rejects(
      runTrackedJob(job, async () => {
        runnerCalled = true;
        return { exitStatus: 0 };
      }),
      /left the queue before execution started \(cancelling\)/
    );

    assert.equal(runnerCalled, false);
    assert.equal(readJobFile(repoDir, job.id).status, "cancelling");
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("does not overwrite a concurrent cancelling transition when onSpawn races with cancel", async () => {
    const repoDir = createTempGitRepo();
    const job = {
      id: "tracked-race-job",
      workspaceRoot: repoDir,
      status: "queued",
      title: "race",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    writeJobFile(repoDir, job.id, job);

    await runTrackedJob(
      job,
      async (onSpawn) => {
        const beforeSpawn = readJobFile(repoDir, job.id);
        writeJobFile(repoDir, job.id, {
          ...beforeSpawn,
          status: "cancelling",
          updatedAt: nowIso(),
        });
        onSpawn({ pid: 999999, pidIdentity: "fake-ident" });
        return {
          exitStatus: 1,
          threadId: null,
          turnId: null,
          payload: {},
          rendered: "failed",
          summary: "failed",
        };
      },
      {}
    ).catch(() => {});

    const finalJob = readJobFile(repoDir, job.id);
    assert.equal(finalJob.status, "cancelling");
    assert.equal(finalJob.pid ?? null, null);
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("persists a late result after the identity reaper marked the job failed", async () => {
    const repoDir = createTempGitRepo();
    const job = {
      id: "tracked-reaper-result-job",
      workspaceRoot: repoDir,
      status: "queued",
      title: "late result",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      pidIdentity: "queued-worker-identity",
    };
    writeJobFile(repoDir, job.id, job);

    try {
      await runTrackedJob(job, async () => {
        const running = readJobFile(repoDir, job.id);
        assert.equal(running.phase, "starting");
        assert.equal(running.pidIdentity, "queued-worker-identity");
        writeJobFile(repoDir, job.id, {
          ...running,
          status: "failed",
          errorMessage: "identity remained unverifiable",
          reapedUnverifiable: true,
          pid: 12345,
          pidIdentity: "stored-identity",
          updatedAt: nowIso(),
        });
        return {
          exitStatus: 0,
          threadId: "thread-late",
          turnId: "turn-late",
          payload: { answer: 42 },
          rendered: "finished",
          summary: "finished",
        };
      });

      const finalJob = readJobFile(repoDir, job.id);
      assert.equal(finalJob.status, "completed");
      assert.equal(finalJob.phase, "done");
      assert.equal(finalJob.threadId, "thread-late");
      assert.equal(finalJob.turnId, "turn-late");
      assert.equal(finalJob.summary, "finished");
      assert.equal(finalJob.rendered, "finished");
      assert.deepEqual(finalJob.result, { answer: 42 });
      assert.equal(finalJob.errorMessage, null);
      assert.equal(finalJob.reapedUnverifiable, false);
      assert.equal(finalJob.pid, null);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("persists an ordinary runner failure without treating it as lock contention", async () => {
    const repoDir = createTempGitRepo();
    const job = {
      id: "tracked-runner-failure-job",
      workspaceRoot: repoDir,
      status: "queued",
      title: "runner failure",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    writeJobFile(repoDir, job.id, job);

    try {
      await assert.rejects(
        runTrackedJob(job, async () => {
          throw new Error("runner exploded");
        }),
        /runner exploded/
      );

      const finalJob = readJobFile(repoDir, job.id);
      assert.equal(finalJob.status, "failed");
      assert.equal(finalJob.phase, "failed");
      assert.equal(finalJob.errorMessage, "runner exploded");
      assert.equal(finalJob.pid, null);
      assert.equal(finalJob.pidIdentity, null);
      assert.ok(finalJob.completedAt);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite an unrelated failed state with a late result", async () => {
    const repoDir = createTempGitRepo();
    const job = {
      id: "tracked-unrelated-failure-job",
      workspaceRoot: repoDir,
      status: "queued",
      title: "unrelated failure",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    writeJobFile(repoDir, job.id, job);

    try {
      await runTrackedJob(job, async () => {
        const running = readJobFile(repoDir, job.id);
        writeJobFile(repoDir, job.id, {
          ...running,
          status: "failed",
          errorMessage: "independent failure",
          updatedAt: nowIso(),
        });
        return {
          exitStatus: 0,
          payload: { answer: 42 },
          rendered: "finished",
          summary: "finished",
        };
      });

      const finalJob = readJobFile(repoDir, job.id);
      assert.equal(finalJob.status, "failed");
      assert.equal(finalJob.errorMessage, "independent failure");
      assert.equal(finalJob.result, undefined);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("retries tagged lock contention when persisting a spawned job", async () => {
    const repoDir = createTempGitRepo();
    const job = {
      id: "tracked-lock-retry-job",
      workspaceRoot: repoDir,
      status: "queued",
      title: "lock retry",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const originalLinkSync = fs.linkSync;
    let collisions = 0;
    let injectCollisions = false;
    writeJobFile(repoDir, job.id, job);

    Reflect.set(fs, "linkSync", (existingPath, newPath) => {
      if (
        injectCollisions &&
        String(newPath).endsWith(`${job.id}.json.lock`) &&
        collisions < 3
      ) {
        collisions += 1;
        throw Object.assign(new Error("synthetic collision"), {
          code: "EEXIST",
        });
      }
      return originalLinkSync(existingPath, newPath);
    });
    syncBuiltinESMExports();

    try {
      await runTrackedJob(job, async (onSpawn) => {
        injectCollisions = true;
        onSpawn({ pid: 12345, pidIdentity: "spawned-identity" });
        const spawnedJob = readJobFile(repoDir, job.id);
        assert.equal(spawnedJob.pid, 12345);
        assert.equal(spawnedJob.pidIdentity, "spawned-identity");
        return {
          exitStatus: 0,
          payload: {},
          rendered: "finished",
          summary: "finished",
        };
      });

      assert.equal(collisions, 3);
      assert.equal(readJobFile(repoDir, job.id).status, "completed");
    } finally {
      Reflect.set(fs, "linkSync", originalLinkSync);
      syncBuiltinESMExports();
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("fails closed after bounded tagged lock retries without corrupting job state", async () => {
    const repoDir = createTempGitRepo();
    const job = {
      id: "tracked-lock-exhaustion-job",
      workspaceRoot: repoDir,
      status: "queued",
      title: "lock exhaustion",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const originalLinkSync = fs.linkSync;
    let collisions = 0;
    let injectCollisions = false;
    writeJobFile(repoDir, job.id, job);

    Reflect.set(fs, "linkSync", (existingPath, newPath) => {
      if (
        injectCollisions &&
        String(newPath).endsWith(`${job.id}.json.lock`)
      ) {
        collisions += 1;
        throw Object.assign(new Error("persistent synthetic collision"), {
          code: "EEXIST",
        });
      }
      return originalLinkSync(existingPath, newPath);
    });
    syncBuiltinESMExports();

    try {
      await assert.rejects(
        runTrackedJob(job, async (onSpawn) => {
          injectCollisions = true;
          onSpawn({ pid: 99999999, pidIdentity: "spawned-identity" });
          throw new Error("onSpawn should reject first");
        }),
        isLockBusyError
      );

      const finalJob = readJobFile(repoDir, job.id);
      assert.equal(collisions, 9);
      assert.equal(finalJob.status, "running");
      assert.equal(finalJob.errorMessage, undefined);
    } finally {
      Reflect.set(fs, "linkSync", originalLinkSync);
      syncBuiltinESMExports();
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
