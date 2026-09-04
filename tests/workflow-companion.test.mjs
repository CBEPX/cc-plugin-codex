/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION = path.join(PROJECT_ROOT, "scripts", "claude-companion.mjs");
const cleanup = [];

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function createEnvironment() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-workflow-cli-"));
  cleanup.push(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const homeDir = path.join(rootDir, "home");
  const workspaceDir = path.join(rootDir, "workspace");
  const binDir = path.join(rootDir, "bin");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const claudePath = path.join(binDir, "claude");
  fs.writeFileSync(
    claudePath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
if (args[0] === "--version") {
  process.stdout.write("2.1.90 (Claude Code)\\n");
} else if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write("authenticated\\n");
} else {
  const sessionId = value("--resume") || value("--session-id") || "fresh-workflow-session";
  if (process.env.CLAUDE_INVOCATION_FILE) {
    fs.writeFileSync(process.env.CLAUDE_INVOCATION_FILE, JSON.stringify({ args, sessionId }) + "\\n");
  }
  process.stdout.write(JSON.stringify({ type: "result", session_id: sessionId, subtype: "success", terminal_reason: "completed", is_error: false, result: "done" }) + "\\n");
}
`,
    "utf8"
  );
  fs.chmodSync(claudePath, 0o755);
  runGit(workspaceDir, ["init", "--initial-branch=main"]);
  runGit(workspaceDir, ["config", "user.name", "Codex Test"]);
  runGit(workspaceDir, ["config", "user.email", "codex@example.com"]);
  fs.writeFileSync(path.join(workspaceDir, "tracked.txt"), "base\n", "utf8");
  runGit(workspaceDir, ["add", "tracked.txt"]);
  runGit(workspaceDir, ["commit", "-m", "initial"]);
  return {
    rootDir,
    homeDir,
    workspaceDir,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODEX_HOME: path.join(homeDir, ".codex"),
      CODEX_THREAD_ID: "",
      CLAUDE_COMPANION_SESSION_ID: "",
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    },
  };
}

function runCompanion(testEnv, args, options = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...testEnv.env, ...(options.env ?? {}) },
    encoding: "utf8",
    input: options.input,
    timeout: 30_000,
  });
}

function runJson(testEnv, args, options = {}) {
  const result = runCompanion(testEnv, args, options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function stateDirFor(testEnv) {
  const canonical = fs.realpathSync.native(testEnv.workspaceDir);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return path.join(
    testEnv.homeDir,
    ".codex",
    "plugins",
    "data",
    "cc",
    "state",
    hash
  );
}

function writeJob(testEnv, job) {
  const jobsDir = path.join(stateDirFor(testEnv), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobsDir, `${job.id}.json`),
    `${JSON.stringify(job, null, 2)}\n`,
    "utf8"
  );
}

function readJob(testEnv, jobId) {
  return JSON.parse(
    fs.readFileSync(path.join(stateDirFor(testEnv), "jobs", `${jobId}.json`), "utf8")
  );
}

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()();
});

describe("workflow companion internals", () => {
  it("does not mutate a workflow when generic submission input is malformed", () => {
    const testEnv = createEnvironment();
    const workflow = runJson(testEnv, [
      "workflow-create", "--cwd", testEnv.workspaceDir, "--json",
    ], { input: JSON.stringify({
      id: "workflow-malformed-submit",
      mode: "design",
      brief: "Keep malformed input atomic.",
      originSessionId: "owner-a",
      stages: ["memo"],
    }) });
    const filePath = path.join(
      stateDirFor(testEnv), "workflows", `${workflow.id}.json`
    );
    const before = fs.readFileSync(filePath);

    const malformed = runCompanion(testEnv, [
      "workflow-submit-stage", workflow.id, "--cwd", testEnv.workspaceDir,
      "--stage", "memo", "--revision", String(workflow.revision),
      "--epoch", String(workflow.epoch), "--json",
    ], { input: "{" });

    assert.notEqual(malformed.status, 0);
    assert.deepEqual(fs.readFileSync(filePath), before);
  });

  it("creates, reads, lists, submits, retries, and rebinds through narrow JSON commands", () => {
    const testEnv = createEnvironment();
    const created = runJson(
      testEnv,
      ["workflow-create", "--cwd", testEnv.workspaceDir, "--json"],
      {
        input: JSON.stringify({
          id: "workflow-cli",
          mode: "design",
          brief: "Design through stdin.",
          originSessionId: "owner-a",
          modelManifest: [{ requestedModel: "opus" }],
          toolManifest: [{
            toolId: "mcp__docs__search",
            source: "user",
            capability: "docs_search",
            reason: "brief needs docs",
            safetyDecision: {
              eligible: true,
              decision: "eligible",
              reason: "read_only_annotation",
            },
            transport: "stdio",
            configFingerprint: "abc123",
          }],
          stages: ["memo", "critique"],
          branches: ["alpha"],
        }),
      }
    );
    assert.equal(created.id, "workflow-cli");

    const listed = runJson(testEnv, [
      "workflow-list", "--cwd", testEnv.workspaceDir, "--mode", "design", "--json",
    ]);
    assert.deepEqual(listed.map(({ id }) => id), ["workflow-cli"]);
    assert.equal(runJson(testEnv, [
      "workflow-read", "workflow-cli", "--cwd", testEnv.workspaceDir,
      "--mode", "design", "--json",
    ]).brief, "Design through stdin.");

    const submitted = runJson(
      testEnv,
      [
        "workflow-submit-stage", "workflow-cli", "--cwd", testEnv.workspaceDir,
        "--stage", "memo", "--revision", String(created.revision),
        "--epoch", String(created.epoch), "--mode", "design",
        "--field", "checkpoint", "--claude-session-id", "claude-owned",
        "--status", "awaiting_user", "--json",
      ],
      { input: JSON.stringify({ text: "--cwd is payload, not argv" }) }
    );
    assert.deepEqual(submitted.checkpoint, { text: "--cwd is payload, not argv" });
    assert.equal(submitted.claudeSessionId, "claude-owned");

    const critiqueFailed = runJson(testEnv, [
      "workflow-fail-branch", "workflow-cli", "--cwd", testEnv.workspaceDir,
      "--stage", "critique", "--revision", String(submitted.revision),
      "--epoch", String(submitted.epoch), "--mode", "design",
      "--reason", "retry the critique", "--json",
    ]);
    assert.equal(critiqueFailed.stages.critique.status, "retryable_failed");

    const retry = runJson(testEnv, [
      "workflow-retry-context", "workflow-cli", "--cwd", testEnv.workspaceDir,
      "--mode", "design", "--required-stage", "memo", "--required-stage", "critique",
      "--required-branch", "alpha", "--retry", "--json",
    ]);
    assert.deepEqual(retry.stages.map(({ stage }) => stage), ["critique"]);
    assert.deepEqual(retry.branches.map(({ branchId }) => branchId), ["alpha"]);
    assert.equal(JSON.stringify(retry).includes("--cwd is payload"), false);

    const rebound = runJson(testEnv, [
      "workflow-rebind", "workflow-cli", "--cwd", testEnv.workspaceDir,
      "--revision", String(critiqueFailed.revision), "--epoch", String(critiqueFailed.epoch),
      "--mode", "design", "--owner-session-id", "owner-b", "--json",
    ]);
    assert.equal(rebound.currentOwnerSessionId, "owner-b");
    assert.equal(rebound.originSessionId, "owner-a");
    assert.equal(rebound.epoch, 1);

    const duplicate = runCompanion(testEnv, [
      "workflow-submit-stage", "workflow-cli", "--cwd", testEnv.workspaceDir,
      "--stage", "memo", "--revision", String(rebound.revision),
      "--epoch", String(rebound.epoch), "--json",
    ], { input: JSON.stringify({ replacement: true }) });
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /COMPLETED_STAGE_IMMUTABLE/);
  });

  it("cancels only linked jobs and keeps workflow jobs out of generic rescue resume", () => {
    const testEnv = createEnvironment();
    const created = runJson(
      testEnv,
      ["workflow-reserve", "--cwd", testEnv.workspaceDir, "--json"],
      {
        input: JSON.stringify({
          id: "workflow-cancel",
          mode: "research",
          brief: "Research safely.",
          originSessionId: "owner-session",
          stages: ["memo"],
        }),
      }
    );
    const timestamp = new Date().toISOString();
    writeJob(testEnv, {
      id: "workflow-child",
      status: "queued",
      kind: "task",
      jobClass: "workflow",
      workflowId: created.id,
      workflowStage: "memo",
      sessionId: "owner-session",
      workspaceRoot: fs.realpathSync.native(testEnv.workspaceDir),
      threadId: "claude-linked-session",
      result: { sessionId: "claude-linked-session" },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    writeJob(testEnv, {
      id: "ordinary-task",
      status: "queued",
      kind: "task",
      jobClass: "task",
      sessionId: "owner-session",
      workspaceRoot: fs.realpathSync.native(testEnv.workspaceDir),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const candidate = runJson(testEnv, [
      "task-resume-candidate", "--cwd", testEnv.workspaceDir,
      "--owner-session-id", "owner-session", "--json",
    ]);
    assert.equal(candidate.available, false);
    assert.equal(candidate.reason, "active_task");
    assert.equal(candidate.activeJobId, "ordinary-task");

    const cancelled = runJson(testEnv, [
      "workflow-cancel-linked-jobs", created.id, "--cwd", testEnv.workspaceDir,
      "--revision", String(created.revision), "--epoch", String(created.epoch),
      "--mode", "research", "--json",
    ]);
    assert.equal(cancelled.workflow.status, "cancelled");
    assert.deepEqual(cancelled.cancelledJobIds, ["workflow-child"]);
    assert.equal(readJob(testEnv, "workflow-child").status, "cancelled");
    assert.equal(readJob(testEnv, "ordinary-task").status, "queued");

    const afterCancelCandidate = runJson(testEnv, [
      "task-resume-candidate", "--cwd", testEnv.workspaceDir,
      "--owner-session-id", "owner-session", "--json",
    ]);
    assert.equal(afterCancelCandidate.available, false);
    assert.equal(afterCancelCandidate.candidate, null);
  });

  it("preserves an earlier linked cancel failure when cancellation is retried", () => {
    const testEnv = createEnvironment();
    const created = runJson(
      testEnv,
      ["workflow-reserve", "--cwd", testEnv.workspaceDir, "--json"],
      {
        input: JSON.stringify({
          id: "workflow-cancel-retry",
          mode: "research",
          brief: "Retry cancellation safely.",
          originSessionId: "owner-session",
          stages: ["memo"],
        }),
      }
    );
    const timestamp = new Date().toISOString();
    writeJob(testEnv, {
      id: "workflow-child-failed",
      status: "cancel_failed",
      kind: "task",
      jobClass: "workflow",
      workflowId: created.id,
      workflowStage: "memo",
      sessionId: "owner-session",
      workspaceRoot: fs.realpathSync.native(testEnv.workspaceDir),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const cancelled = runJson(testEnv, [
      "workflow-cancel-linked-jobs", created.id, "--cwd", testEnv.workspaceDir,
      "--revision", String(created.revision), "--epoch", String(created.epoch),
      "--mode", "research", "--json",
    ]);

    assert.equal(cancelled.workflow.status, "cancel_failed");
    assert.deepEqual(cancelled.failedJobIds, ["workflow-child-failed"]);
  });

  it("resolves public cancel to the aggregate workflow and preserves linked cancel_failed", () => {
    const testEnv = createEnvironment();
    const created = runJson(
      testEnv,
      ["workflow-reserve", "--cwd", testEnv.workspaceDir, "--json"],
      {
        input: JSON.stringify({
          id: "workflow-public-cancel",
          mode: "design",
          brief: "Cancel through the public surface.",
          originSessionId: "owner-session",
          stages: ["memo"],
        }),
      }
    );
    const timestamp = new Date().toISOString();
    writeJob(testEnv, {
      id: "workflow-public-child",
      status: "cancel_failed",
      kind: "task",
      jobClass: "workflow",
      workflowId: created.id,
      workflowStage: "memo",
      sessionId: "owner-session",
      workspaceRoot: fs.realpathSync.native(testEnv.workspaceDir),
      pid: 987654321,
      pidIdentity: "identity-unavailable",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const cancelled = runJson(testEnv, [
      "cancel", created.id, "--cwd", testEnv.workspaceDir, "--json",
    ]);

    assert.equal(cancelled.targetType, "workflow");
    assert.equal(cancelled.workflow.id, created.id);
    assert.equal(cancelled.workflow.status, "cancel_failed");
    assert.deepEqual(cancelled.failedJobIds, ["workflow-public-child"]);
    assert.equal(readJob(testEnv, "workflow-public-child").status, "cancel_failed");
  });

  it("binds tracked work to the workflow-owned Claude session without generic resume lookup", () => {
    const testEnv = createEnvironment();
    let workflow = runJson(
      testEnv,
      ["workflow-create", "--cwd", testEnv.workspaceDir, "--json"],
      {
        input: JSON.stringify({
          id: "workflow-owned-session",
          mode: "design",
          brief: "Continue the owned peer session.",
          originSessionId: "owner-session",
          stages: ["memo", "critique"],
        }),
      }
    );
    workflow = runJson(
      testEnv,
      [
        "workflow-submit-stage", workflow.id, "--cwd", testEnv.workspaceDir,
        "--stage", "memo", "--revision", String(workflow.revision),
        "--epoch", String(workflow.epoch), "--claude-session-id", "claude-owned-session",
        "--status", "awaiting_user", "--json",
      ],
      { input: JSON.stringify({ memo: "complete" }) }
    );
    const timestamp = new Date().toISOString();
    writeJob(testEnv, {
      id: "ordinary-resume-candidate",
      status: "completed",
      kind: "task",
      jobClass: "task",
      sessionId: "owner-session",
      workspaceRoot: fs.realpathSync.native(testEnv.workspaceDir),
      threadId: "wrong-generic-session",
      result: { sessionId: "wrong-generic-session" },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const invocationFile = path.join(testEnv.rootDir, "workflow-invocation.json");

    const launch = runJson(
      testEnv,
      [
        "task", "--cwd", testEnv.workspaceDir, "--background", "--json", "--resume",
        "--owner-session-id", "owner-session", "--workflow-id", workflow.id,
        "--workflow-stage", "critique", "continue peer memo",
      ],
      { env: { CLAUDE_INVOCATION_FILE: invocationFile } }
    );

    const linkedJob = readJob(testEnv, launch.jobId);
    assert.equal(linkedJob.jobClass, "workflow");
    assert.equal(linkedJob.workflowId, workflow.id);
    assert.equal(linkedJob.workflowStage, "critique");
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(invocationFile) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    const invocation = JSON.parse(fs.readFileSync(invocationFile, "utf8"));
    assert.equal(
      invocation.args[invocation.args.indexOf("--resume") + 1],
      "claude-owned-session"
    );

    const candidate = runJson(testEnv, [
      "task-resume-candidate", "--cwd", testEnv.workspaceDir,
      "--owner-session-id", "owner-session", "--json",
    ]);
    assert.equal(candidate.candidate.id, "ordinary-resume-candidate");
    assert.notEqual(candidate.candidate.id, launch.jobId);
  });

  it("releases a reserved job when workflow binding validation fails", () => {
    const testEnv = createEnvironment();
    const reserved = runJson(testEnv, [
      "task-reserve-job", "--cwd", testEnv.workspaceDir, "--json",
    ]);
    const reservationFile = path.join(
      stateDirFor(testEnv),
      "jobs",
      `${reserved.jobId}.reserve`
    );
    assert.equal(fs.existsSync(reservationFile), true);

    const result = runCompanion(testEnv, [
      "task", "--cwd", testEnv.workspaceDir, "--background", "--json",
      "--job-id", reserved.jobId, "--owner-session-id", "owner-session",
      "--workflow-id", "missing-workflow", "--workflow-stage", "memo",
      "must not leak reservation",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WORKFLOW_NOT_FOUND/);
    assert.equal(fs.existsSync(reservationFile), false);
  });
});
