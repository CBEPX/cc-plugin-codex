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

import {
  sortJobsNewestFirst,
  enrichJob,
  readJobProgressPreview,
  buildStatusSnapshot,
  buildSingleJobSnapshot,
  buildSingleStatusSnapshot,
  resolveResultJob,
  resolveResultTarget,
  resolveCancelableJob,
  resolveCancelableTarget,
  DEFAULT_MAX_STATUS_JOBS,
  DEFAULT_MAX_PROGRESS_LINES,
} from "../scripts/lib/job-control.mjs";
import {
  clearCurrentSession,
  setCurrentSession,
  writeJobFile,
  resolveJobsDir,
  resolveJobLogFile,
} from "../scripts/lib/state.mjs";
import { reserveWorkflow, resolveWorkflowsDir } from "../scripts/lib/workflows.mjs";

const PROJECT_CWD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createTempGitRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "jc-session-"));
  const init = spawnSync("git", ["init", "--initial-branch=main"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  return repoDir;
}

function withTempJobRepo(run) {
  const repoDir = createTempGitRepo();
  try {
    return run(repoDir);
  } finally {
    clearCurrentSession(repoDir);
    fs.rmSync(resolveJobsDir(repoDir), { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

function writeJobAt(repoDir, payload) {
  const jobFile = writeJobFile(repoDir, payload.id, payload);
  fs.writeFileSync(jobFile, JSON.stringify(payload), "utf8");
}

function writePeerWorkflow(repoDir, overrides = {}) {
  for (const args of [
    ["config", "user.name", "Codex Test"],
    ["config", "user.email", "codex@example.com"],
    ["commit", "--allow-empty", "-m", "workflow baseline"],
  ]) {
    const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  return reserveWorkflow(repoDir, {
    id: overrides.id ?? "workflow-visible",
    mode: overrides.mode ?? "design",
    brief: overrides.brief ?? "Compare the safe options.",
    originSessionId: overrides.originSessionId ?? "session-a",
    currentOwnerSessionId: overrides.currentOwnerSessionId ?? "session-a",
    modelManifest: [{ role: "claude", requestedModel: "fable", resolvedModel: null }],
    toolManifest: [],
    stages: ["checkpoint", "critique", "synthesis"],
    branches: ["codex", "claude"],
  });
}

// ---------------------------------------------------------------------------
// sortJobsNewestFirst
// ---------------------------------------------------------------------------

describe("sortJobsNewestFirst", () => {
  it("sorts by updatedAt descending", () => {
    const jobs = [
      { id: "old", updatedAt: "2024-01-01T00:00:00Z" },
      { id: "new", updatedAt: "2024-06-01T00:00:00Z" },
      { id: "mid", updatedAt: "2024-03-01T00:00:00Z" },
    ];
    const sorted = sortJobsNewestFirst(jobs);
    assert.deepEqual(sorted.map((j) => j.id), ["new", "mid", "old"]);
  });

  it("does not mutate the original array", () => {
    const jobs = [
      { id: "a", updatedAt: "2024-06-01T00:00:00Z" },
      { id: "b", updatedAt: "2024-01-01T00:00:00Z" },
    ];
    const original = [...jobs];
    sortJobsNewestFirst(jobs);
    assert.deepEqual(jobs, original);
  });

  it("handles missing updatedAt gracefully", () => {
    const jobs = [
      { id: "nodate" },
      { id: "hasdate", updatedAt: "2024-01-01T00:00:00Z" },
    ];
    const sorted = sortJobsNewestFirst(jobs);
    // hasdate sorts before nodate (non-empty string > empty string)
    assert.equal(sorted[0].id, "hasdate");
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(sortJobsNewestFirst([]), []);
  });
});

describe("DEFAULT_MAX_STATUS_JOBS", () => {
  it("defaults to 15 jobs", () => {
    assert.equal(DEFAULT_MAX_STATUS_JOBS, 15);
  });
});

describe("buildStatusSnapshot", () => {
  it("shows one aggregate workflow by default and linked jobs only with --all", () => {
    withTempJobRepo((repoDir) => {
      const workflow = writePeerWorkflow(repoDir);
      for (const job of [
        {
          id: "peer-linked",
          status: "running",
          jobClass: "workflow",
          workflowId: workflow.id,
          sessionId: "session-a",
        },
        {
          id: "ordinary-job",
          status: "running",
          jobClass: "task",
          sessionId: "session-a",
        },
      ]) {
        writeJobAt(repoDir, {
          ...job,
          workspaceRoot: repoDir,
          createdAt: "2026-09-01T10:00:00Z",
          updatedAt: "2026-09-01T10:00:00Z",
        });
      }
      setCurrentSession(repoDir, "session-a");

      const defaultView = buildStatusSnapshot(repoDir);
      assert.deepEqual(defaultView.workflows.map(({ id }) => id), [workflow.id]);
      assert.deepEqual(defaultView.running.map(({ id }) => id), ["ordinary-job"]);

      const allView = buildStatusSnapshot(repoDir, { all: true });
      assert.deepEqual(allView.workflows.map(({ id }) => id), [workflow.id]);
      assert.deepEqual(
        allView.running.map(({ id }) => id).sort(),
        ["ordinary-job", "peer-linked"]
      );
    });
  });

  it("filters overview jobs to the current session marker when env is absent", () => {
    const repoDir = createTempGitRepo();
    const scopedIds = ["test-status-session-a", "test-status-session-b"];
    try {
      writeJobFile(repoDir, scopedIds[0], {
        id: scopedIds[0],
        status: "completed",
        jobClass: "task",
        sessionId: "session-a",
        createdAt: "2026-04-03T10:00:00Z",
        completedAt: "2026-04-03T10:00:01Z",
        updatedAt: "2026-04-03T10:00:01Z",
      });
      writeJobFile(repoDir, scopedIds[1], {
        id: scopedIds[1],
        status: "completed",
        jobClass: "task",
        sessionId: "session-b",
        createdAt: "2026-04-03T11:00:00Z",
        completedAt: "2026-04-03T11:00:01Z",
        updatedAt: "2026-04-03T11:00:01Z",
      });

      setCurrentSession(repoDir, "session-a");
      const snapshot = buildStatusSnapshot(repoDir);

      assert.equal(snapshot.latestFinished?.id, scopedIds[0]);
      const recentIds = snapshot.recent.map((job) => job.id);
      assert.ok(!recentIds.includes(scopedIds[1]));
      const runningIds = snapshot.running.map((job) => job.id);
      assert.ok(!runningIds.includes(scopedIds[1]));
    } finally {
      clearCurrentSession(repoDir);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("status --all bypasses the current-session filter and shows workspace jobs", () => {
    const repoDir = createTempGitRepo();
    const scopedIds = ["test-status-all-a", "test-status-all-b"];
    try {
      writeJobFile(repoDir, scopedIds[0], {
        id: scopedIds[0],
        status: "completed",
        jobClass: "task",
        sessionId: "session-a",
        createdAt: "2026-04-03T10:00:00Z",
        completedAt: "2026-04-03T10:00:01Z",
        updatedAt: "2026-04-03T10:00:01Z",
      });
      writeJobFile(repoDir, scopedIds[1], {
        id: scopedIds[1],
        status: "completed",
        jobClass: "review",
        sessionId: "session-b",
        createdAt: "2026-04-03T11:00:00Z",
        completedAt: "2026-04-03T11:00:01Z",
        updatedAt: "2026-04-03T11:00:01Z",
      });

      setCurrentSession(repoDir, "session-a");
      const snapshot = buildStatusSnapshot(repoDir, { all: true });

      const ids = [
        snapshot.latestFinished?.id,
        ...snapshot.recent.map((job) => job.id),
        ...snapshot.running.map((job) => job.id),
      ].filter(Boolean);
      assert.ok(ids.includes(scopedIds[0]));
      assert.ok(ids.includes(scopedIds[1]));
    } finally {
      clearCurrentSession(repoDir);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("separates running/latest/recent jobs and honors display limits", () => {
    withTempJobRepo((repoDir) => {
      const jobs = [
        { id: "run", status: "running", updatedAt: "2026-04-03T12:00:00Z" },
        { id: "latest", status: "completed", updatedAt: "2026-04-03T11:00:00Z" },
        { id: "older", status: "failed", updatedAt: "2026-04-03T10:00:00Z" },
        { id: "oldest", status: "cancelled", updatedAt: "2026-04-03T09:00:00Z" },
      ];
      for (const job of jobs) {
        writeJobAt(repoDir, {
          ...job,
          jobClass: "task",
          sessionId: "session-a",
          workspaceRoot: repoDir,
          createdAt: job.updatedAt,
        });
      }
      setCurrentSession(repoDir, "session-a");
      fs.writeFileSync(
        resolveJobLogFile(repoDir, "run"),
        "[t1] first\n[t2] second\n[t3] third\n",
        "utf8"
      );

      const limited = buildStatusSnapshot(repoDir, {
        maxJobs: 2,
        maxProgressLines: 1,
      });
      assert.deepEqual(limited.running.map((job) => job.id), ["run"]);
      assert.deepEqual(limited.running[0].progressPreview, ["third"]);
      assert.equal(limited.latestFinished.id, "latest");
      assert.deepEqual(limited.recent.map((job) => job.id), ["older"]);

      const defaults = buildStatusSnapshot(repoDir);
      assert.deepEqual(defaults.recent.map((job) => job.id), ["older", "oldest"]);

      const all = buildStatusSnapshot(repoDir, { all: true, maxJobs: 1 });
      assert.deepEqual(all.recent.map((job) => job.id), ["older", "oldest"]);
    });
  });
});

describe("unified workflow target resolution", () => {
  it("resolves status and result by workflow id without shadowing exact job ids", () => {
    withTempJobRepo((repoDir) => {
      const workflow = writePeerWorkflow(repoDir, { id: "workflow-target" });
      writeJobAt(repoDir, {
        id: "ordinary-target",
        status: "completed",
        jobClass: "task",
        sessionId: "session-a",
        workspaceRoot: repoDir,
        createdAt: "2026-09-01T10:00:00Z",
        updatedAt: "2026-09-01T10:00:00Z",
      });

      const status = buildSingleStatusSnapshot(repoDir, workflow.id);
      assert.equal(status.targetType, "workflow");
      assert.equal(status.workflow.id, workflow.id);

      const result = resolveResultTarget(repoDir, workflow.id);
      assert.equal(result.targetType, "workflow");
      assert.equal(result.workflow.id, workflow.id);

      const job = buildSingleStatusSnapshot(repoDir, "ordinary-target");
      assert.equal(job.targetType, "job");
      assert.equal(job.job.id, "ordinary-target");
    });
  });

  it("treats one active workflow as one cancel target and hides its linked job", () => {
    withTempJobRepo((repoDir) => {
      const workflow = writePeerWorkflow(repoDir, { id: "workflow-cancel-target" });
      writeJobAt(repoDir, {
        id: "workflow-cancel-linked",
        status: "running",
        jobClass: "workflow",
        workflowId: workflow.id,
        sessionId: "session-a",
        workspaceRoot: repoDir,
        createdAt: "2026-09-01T10:00:00Z",
        updatedAt: "2026-09-01T10:00:00Z",
      });

      const resolved = resolveCancelableTarget(repoDir, "");
      assert.equal(resolved.targetType, "workflow");
      if (!("workflow" in resolved)) assert.fail("expected workflow target");
      assert.equal(resolved.workflow.id, workflow.id);

      const explicitLinked = resolveCancelableTarget(repoDir, "workflow-cancel-linked");
      assert.equal(explicitLinked.targetType, "job");
      if (!("job" in explicitLinked)) assert.fail("expected job target");
      assert.equal(explicitLinked.job.id, "workflow-cancel-linked");
    });
  });

  it("prefers local exact, then cross-workspace exact, before local prefixes for every surface", () => {
    const sourceRepo = createTempGitRepo();
    const otherRepo = createTempGitRepo();
    const globalJobId = "task-cross-workspace-exact-a1b2c3";
    const localWorkflowId = "workflow-local-exact-d4e5f6";
    try {
      writeJobAt(sourceRepo, {
        id: `${globalJobId}-local-prefix`,
        status: "running",
        jobClass: "task",
        workspaceRoot: sourceRepo,
        createdAt: "2026-09-01T10:00:00Z",
        updatedAt: "2026-09-01T10:00:00Z",
      });
      writeJobAt(otherRepo, {
        id: globalJobId,
        status: "running",
        jobClass: "task",
        workspaceRoot: otherRepo,
        createdAt: "2026-09-01T10:00:00Z",
        updatedAt: "2026-09-01T10:00:00Z",
      });

      const crossWorkspace = [
        buildSingleStatusSnapshot(sourceRepo, globalJobId),
        resolveResultTarget(sourceRepo, globalJobId),
        resolveCancelableTarget(sourceRepo, globalJobId),
      ];
      assert.deepEqual(
        crossWorkspace.map(({ targetType, workspaceRoot, job }) => [targetType, workspaceRoot, job?.id]),
        Array(3).fill(["job", otherRepo, globalJobId])
      );

      const workflow = writePeerWorkflow(sourceRepo, { id: localWorkflowId });
      writeJobAt(otherRepo, {
        id: localWorkflowId,
        status: "running",
        jobClass: "task",
        workspaceRoot: otherRepo,
        createdAt: "2026-09-01T10:00:00Z",
        updatedAt: "2026-09-01T10:00:00Z",
      });
      const localExact = [
        buildSingleStatusSnapshot(sourceRepo, localWorkflowId),
        resolveResultTarget(sourceRepo, localWorkflowId),
        resolveCancelableTarget(sourceRepo, localWorkflowId),
      ];
      assert.deepEqual(
        localExact.map(({ targetType, workspaceRoot, workflow: resolved }) => [
          targetType,
          workspaceRoot,
          resolved?.id,
        ]),
        Array(3).fill(["workflow", workflow.workspaceRoot, workflow.id])
      );
    } finally {
      for (const repoDir of [sourceRepo, otherRepo]) {
        fs.rmSync(resolveJobsDir(repoDir), { recursive: true, force: true });
        fs.rmSync(resolveWorkflowsDir(repoDir), { recursive: true, force: true });
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// readJobProgressPreview
// ---------------------------------------------------------------------------

describe("readJobProgressPreview", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jc-test-"));
  });

  afterEach(() => {
    // Clean up files in tmpDir (keep the dir)
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
  });

  it("returns empty array for null logFile", () => {
    assert.deepEqual(readJobProgressPreview(null), []);
  });

  it("returns empty array for non-existent file", () => {
    assert.deepEqual(readJobProgressPreview("/no/such/file.log"), []);
  });

  it("extracts last N timestamped lines", () => {
    const logFile = path.join(tmpDir, "progress.log");
    const lines = [
      "[2024-01-01T00:00:01Z] Starting claude review.",
      "[2024-01-01T00:00:02Z] Reading files.",
      "[2024-01-01T00:00:03Z] Running analysis.",
      "[2024-01-01T00:00:04Z] Writing findings.",
      "[2024-01-01T00:00:05Z] Turn completed.",
    ];
    fs.writeFileSync(logFile, lines.join("\n"), "utf8");

    const preview = readJobProgressPreview(logFile, 3);
    assert.equal(preview.length, 3);
    assert.equal(preview[0], "Running analysis.");
    assert.equal(preview[2], "Turn completed.");
  });

  it("strips timestamp prefix from lines", () => {
    const logFile = path.join(tmpDir, "prefix.log");
    fs.writeFileSync(logFile, "[2024-01-01T10:00:00Z] Hello world.\n", "utf8");
    const preview = readJobProgressPreview(logFile, 1);
    assert.equal(preview[0], "Hello world.");
  });

  it("skips lines without bracket prefix", () => {
    const logFile = path.join(tmpDir, "mixed.log");
    fs.writeFileSync(
      logFile,
      "plain line\n[2024-01-01T00:00:01Z] Timestamped line.\n  indented\n",
      "utf8"
    );
    const preview = readJobProgressPreview(logFile);
    assert.equal(preview.length, 1);
    assert.equal(preview[0], "Timestamped line.");
  });

  it("uses DEFAULT_MAX_PROGRESS_LINES by default", () => {
    const logFile = path.join(tmpDir, "many.log");
    const lines = Array.from({ length: 20 }, (_, i) => `[t${i}] Line ${i}.`);
    fs.writeFileSync(logFile, lines.join("\n"), "utf8");
    const preview = readJobProgressPreview(logFile);
    assert.equal(preview.length, DEFAULT_MAX_PROGRESS_LINES);
  });
});

// ---------------------------------------------------------------------------
// enrichJob
// ---------------------------------------------------------------------------

describe("enrichJob", () => {
  it("adds kindLabel based on jobClass=review", () => {
    const enriched = enrichJob({ id: "j1", status: "completed", jobClass: "review" });
    assert.equal(enriched.kindLabel, "review");
  });

  it("adds kindLabel based on jobClass=task", () => {
    const enriched = enrichJob({ id: "j1", status: "completed", jobClass: "task" });
    assert.equal(enriched.kindLabel, "rescue");
  });

  it("adds kindLabel based on kind=adversarial-review", () => {
    const enriched = enrichJob({ id: "j1", status: "completed", kind: "adversarial-review" });
    assert.equal(enriched.kindLabel, "adversarial-review");
  });

  it("defaults kindLabel to 'job' when no match", () => {
    const enriched = enrichJob({ id: "j1", status: "completed" });
    assert.equal(enriched.kindLabel, "job");
  });

  it("preserves existing kindLabel", () => {
    const enriched = enrichJob({ id: "j1", status: "completed", kindLabel: "custom" });
    assert.equal(enriched.kindLabel, "custom");
  });

  it("ignores a tampered stored logFile path and reads only the managed job log", () => {
    const repoDir = createTempGitRepo();
    const outsideFile = path.join(os.tmpdir(), `jc-outside-${Date.now()}.log`);
    const managedLogFile = resolveJobLogFile(repoDir, "j1");

    try {
      fs.writeFileSync(outsideFile, "[2026-04-04T00:00:00Z] SECRET.\n", "utf8");
      fs.mkdirSync(path.dirname(managedLogFile), { recursive: true });
      fs.writeFileSync(managedLogFile, "[2026-04-04T00:00:00Z] SAFE.\n", "utf8");

      const enriched = enrichJob({
        id: "j1",
        status: "running",
        workspaceRoot: repoDir,
        logFile: outsideFile,
      });

      assert.equal(enriched.logFile, managedLogFile);
      assert.deepEqual(enriched.progressPreview, ["SAFE."]);
    } finally {
      try { fs.unlinkSync(outsideFile); } catch {}
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("calculates elapsed for running job", () => {
    const fiveMinAgo = new Date(Date.now() - 300000).toISOString();
    const enriched = enrichJob({ id: "j1", status: "running", startedAt: fiveMinAgo });
    assert.ok(enriched.elapsed);
    // elapsed should contain minutes
    assert.match(enriched.elapsed, /\d+m/);
  });

  it("reports exact active-job progress freshness from the newest known activity", () => {
    const repoDir = createTempGitRepo();
    const logFile = resolveJobLogFile(repoDir, "j-progress-age");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, "[2026-04-03T10:00:04.000Z] Working.\n", "utf8");
    const logTime = new Date("2026-04-03T10:00:05.000Z");
    fs.utimesSync(logFile, logTime, logTime);

    try {
      const enriched = enrichJob(
        {
          id: "j-progress-age",
          status: "running",
          workspaceRoot: repoDir,
          updatedAt: "2026-04-03T10:00:03.000Z",
        },
        { now: Date.parse("2026-04-03T10:00:08.250Z") }
      );

      assert.equal(enriched.lastProgressAt, "2026-04-03T10:00:05.000Z");
      assert.equal(enriched.progressAgeMs, 3250);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("calculates duration for completed job", () => {
    const start = "2024-01-01T10:00:00Z";
    const end = "2024-01-01T10:05:30Z";
    const enriched = enrichJob({
      id: "j1",
      status: "completed",
      startedAt: start,
      completedAt: end,
    });
    assert.equal(enriched.duration, "5m 30s");
  });

  it("sets duration to null for running jobs", () => {
    const enriched = enrichJob({ id: "j1", status: "running", startedAt: new Date().toISOString() });
    assert.equal(enriched.duration, null);
  });

  it("infers phase from status", () => {
    assert.equal(enrichJob({ id: "j1", status: "cancelled" }).phase, "cancelled");
    assert.equal(enrichJob({ id: "j1", status: "failed" }).phase, "failed");
    assert.equal(enrichJob({ id: "j1", status: "completed" }).phase, "done");
    assert.equal(enrichJob({ id: "j1", status: "cancelling" }).phase, "cancelling");
    assert.equal(enrichJob({ id: "j1", status: "cancel_failed" }).phase, "cancel_failed");
    assert.equal(enrichJob({ id: "j1", status: "unknown" }).phase, "unknown");
  });

  it("defaults running review phase to 'reviewing'", () => {
    const enriched = enrichJob({ id: "j1", status: "running", jobClass: "review" });
    assert.equal(enriched.phase, "reviewing");
  });

  it("defaults running task phase to 'running'", () => {
    const enriched = enrichJob({ id: "j1", status: "running", jobClass: "task" });
    assert.equal(enriched.phase, "running");
  });
});

describe("buildSingleJobSnapshot", () => {
  it("resolves exact job ids across workspace state roots", () => {
    const sourceRepo = createTempGitRepo();
    const otherRepo = createTempGitRepo();
    const completedId = "task-global-completed-a1b2c3";
    const runningId = "task-global-running-d4e5f6";
    try {
      writeJobFile(otherRepo, completedId, {
        id: completedId,
        status: "completed",
        jobClass: "task",
        workspaceRoot: otherRepo,
        createdAt: "2026-04-03T10:00:00Z",
        completedAt: "2026-04-03T10:01:00Z",
      });
      writeJobFile(otherRepo, runningId, {
        id: runningId,
        status: "running",
        jobClass: "task",
        workspaceRoot: otherRepo,
        createdAt: new Date().toISOString(),
      });

      const snapshot = buildSingleJobSnapshot(sourceRepo, completedId);
      assert.equal(snapshot.workspaceRoot, otherRepo);
      assert.equal(snapshot.job.id, completedId);
      assert.equal(resolveResultJob(sourceRepo, completedId).workspaceRoot, otherRepo);
      assert.equal(resolveCancelableJob(sourceRepo, runningId).workspaceRoot, otherRepo);
      assert.throws(
        () => resolveResultJob(sourceRepo, "task-global-completed"),
        /No job found/
      );
    } finally {
      fs.rmSync(resolveJobsDir(sourceRepo), { recursive: true, force: true });
      fs.rmSync(resolveJobsDir(otherRepo), { recursive: true, force: true });
      fs.rmSync(sourceRepo, { recursive: true, force: true });
      fs.rmSync(otherRepo, { recursive: true, force: true });
    }
  });

  it("rejects duplicate exact job ids across workspace state roots", () => {
    const sourceRepo = createTempGitRepo();
    const firstRepo = createTempGitRepo();
    const secondRepo = createTempGitRepo();
    const jobId = "task-global-duplicate-a1b2c3";
    try {
      for (const repoDir of [firstRepo, secondRepo]) {
        writeJobFile(repoDir, jobId, {
          id: jobId,
          status: "completed",
          jobClass: "task",
          workspaceRoot: repoDir,
          createdAt: "2026-04-03T10:00:00Z",
        });
      }

      assert.throws(
        () => buildSingleJobSnapshot(sourceRepo, jobId),
        /exists in multiple workspaces/
      );
    } finally {
      for (const repoDir of [sourceRepo, firstRepo, secondRepo]) {
        fs.rmSync(resolveJobsDir(repoDir), { recursive: true, force: true });
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    }
  });

  it("resolves newest, exact, and unique-prefix references", () => {
    withTempJobRepo((repoDir) => {
      for (const [id, updatedAt] of [
        ["review-alpha", "2026-04-03T10:00:00Z"],
        ["review-beta", "2026-04-03T11:00:00Z"],
      ]) {
        writeJobAt(repoDir, {
          id,
          status: "completed",
          jobClass: "review",
          createdAt: updatedAt,
          updatedAt,
        });
      }

      assert.equal(buildSingleJobSnapshot(repoDir).job.id, "review-beta");
      assert.equal(buildSingleJobSnapshot(repoDir, "review-alpha").job.id, "review-alpha");
      assert.equal(buildSingleJobSnapshot(repoDir, "review-a").job.id, "review-alpha");
    });
  });

  it("rejects ambiguous and missing references with actionable errors", () => {
    withTempJobRepo((repoDir) => {
      for (const id of ["review-alpha", "review-beta"]) {
        writeJobAt(repoDir, {
          id,
          status: "completed",
          createdAt: "2026-04-03T10:00:00Z",
          updatedAt: "2026-04-03T10:00:00Z",
        });
      }

      assert.throws(
        () => buildSingleJobSnapshot(repoDir, "review-"),
        /Job reference "review-" is ambiguous\. Use a longer job id\./
      );
      assert.throws(
        () => buildSingleJobSnapshot(repoDir, "missing"),
        /No job found for "missing"\. Run status to list known jobs\./
      );
    });
  });
});

// ---------------------------------------------------------------------------
// resolveResultJob
// ---------------------------------------------------------------------------

describe("resolveResultJob", () => {
  const jobIds = ["test-result-active-running", "test-result-active-queued"];

  afterEach(() => {
    for (const id of jobIds) {
      try {
        fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${id}.json`));
      } catch {}
    }
  });

  it("returns active state for a referenced running job", () => {
    writeJobFile(PROJECT_CWD, jobIds[0], {
      id: jobIds[0],
      status: "running",
      jobClass: "review",
      title: "Claude Code Review",
      createdAt: "2026-04-03T09:00:00Z",
      startedAt: "2026-04-03T09:00:05Z",
      logFile: "/tmp/test-result-active-running.log",
    });

    const resolved = resolveResultJob(PROJECT_CWD, jobIds[0]);
    assert.equal(resolved.state, "active");
    assert.equal(resolved.job.id, jobIds[0]);
    assert.equal(resolved.job.status, "running");
    assert.ok(resolved.job.elapsed);
  });

  it("returns active state for a referenced queued job", () => {
    writeJobFile(PROJECT_CWD, jobIds[1], {
      id: jobIds[1],
      status: "queued",
      jobClass: "review",
      title: "Claude Code Review",
      createdAt: "2026-04-03T09:00:00Z",
      logFile: "/tmp/test-result-active-queued.log",
    });

    const resolved = resolveResultJob(PROJECT_CWD, jobIds[1]);
    assert.equal(resolved.state, "active");
    assert.equal(resolved.job.id, jobIds[1]);
    assert.equal(resolved.job.status, "queued");
  });

  it("returns terminal state for an explicit completed job", () => {
    withTempJobRepo((repoDir) => {
      writeJobAt(repoDir, {
        id: "finished",
        status: "completed",
        jobClass: "review",
        createdAt: "2026-04-03T09:00:00Z",
        updatedAt: "2026-04-03T09:01:00Z",
      });

      const resolved = resolveResultJob(repoDir, "finished");
      assert.equal(resolved.state, "terminal");
      assert.equal(resolved.job.id, "finished");
    });
  });

  it("selects the latest finished job from the current session", () => {
    withTempJobRepo((repoDir) => {
      for (const job of [
        {
          id: "mine",
          status: "failed",
          sessionId: "session-a",
          updatedAt: "2026-04-03T10:00:00Z",
        },
        {
          id: "other",
          status: "completed",
          sessionId: "session-b",
          updatedAt: "2026-04-03T12:00:00Z",
        },
        {
          id: "active",
          status: "running",
          sessionId: "session-a",
          updatedAt: "2026-04-03T11:00:00Z",
        },
      ]) {
        writeJobAt(repoDir, {
          ...job,
          createdAt: job.updatedAt,
        });
      }
      setCurrentSession(repoDir, "session-a");

      const resolved = resolveResultJob(repoDir);
      assert.equal(resolved.state, "terminal");
      assert.equal(resolved.job.id, "mine");
    });
  });

  it("rejects unsupported states and an empty finished-job history", () => {
    withTempJobRepo((repoDir) => {
      writeJobAt(repoDir, {
        id: "paused",
        status: "paused",
        createdAt: "2026-04-03T09:00:00Z",
        updatedAt: "2026-04-03T09:00:00Z",
      });

      assert.throws(
        () => resolveResultJob(repoDir, "paused"),
        /Job paused is paused\. Check status for more details\./
      );
      assert.throws(
        () => resolveResultJob(repoDir),
        /No finished Claude Code jobs found for this repository yet\./
      );
    });
  });
});
