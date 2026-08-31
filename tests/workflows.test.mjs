/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import {
  cleanupOldWorkflows,
  completeWorkflowCancellation,
  getWorkflowRetryContext,
  listWorkflows,
  markWorkflowBranchFailure,
  readWorkflow,
  rebindWorkflowOwner,
  reserveWorkflow,
  resolveWorkflowFile,
  resolveWorkflowsDir,
  casStartWorkflowStage,
  submitWorkflowStage,
} from "../scripts/lib/workflows.mjs";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WORKFLOW_RACE_FIXTURE = path.join(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "start-workflow-stage.mjs"
);
const tempDirs = [];

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cc-workflow-test-"));
  tempDirs.push(repo);
  runGit(repo, ["init", "--initial-branch=main"]);
  runGit(repo, ["config", "user.name", "Codex Test"]);
  runGit(repo, ["config", "user.email", "codex@example.com"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n", "utf8");
  runGit(repo, ["add", "tracked.txt"]);
  runGit(repo, ["commit", "-m", "initial"]);
  return repo;
}

function createWorkflow(repo, overrides = {}) {
  return reserveWorkflow(repo, {
    id: overrides.id ?? "workflow-test",
    mode: overrides.mode ?? "design",
    brief: overrides.brief ?? "Design the smallest safe change.",
    originSessionId: overrides.originSessionId ?? "origin-session",
    currentOwnerSessionId:
      overrides.currentOwnerSessionId ?? "origin-session",
    modelManifest: overrides.modelManifest ?? [
      { role: "drafter", requestedModel: "opus", resolvedModel: "claude-opus-5" },
    ],
    toolManifest: overrides.toolManifest ?? [
      {
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
      },
    ],
    stages: overrides.stages ?? ["memo", "critique", "final"],
    branches: overrides.branches ?? ["alpha", "beta"],
  });
}

function errorCode(fn) {
  try {
    fn();
  } catch (error) {
    return error?.code;
  }
  return null;
}

function spawnRace(repo, id, revision, epoch) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [WORKFLOW_RACE_FIXTURE, repo, id, String(revision), String(epoch)],
      { cwd: PROJECT_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("peer workflow store", () => {
  it("persists a complete secret-free workflow record in its own workspace store", () => {
    const repo = createRepo();
    const workflow = createWorkflow(repo);

    assert.equal(workflow.version, 1);
    assert.equal(workflow.id, "workflow-test");
    assert.equal(workflow.mode, "design");
    assert.equal(workflow.status, "queued");
    assert.equal(workflow.phase, "queued");
    assert.equal(workflow.revision, 0);
    assert.equal(workflow.epoch, 0);
    assert.equal(workflow.workspaceRoot, fs.realpathSync.native(repo));
    assert.equal(workflow.fingerprint.head, runGit(repo, ["rev-parse", "HEAD"]));
    assert.match(workflow.briefHash, /^[a-f0-9]{64}$/);
    assert.equal(workflow.originSessionId, "origin-session");
    assert.equal(workflow.currentOwnerSessionId, "origin-session");
    assert.deepEqual(workflow.branchAttempts, []);
    assert.equal(workflow.claudeSessionId, null);
    assert.equal(workflow.checkpoint, null);
    assert.equal(workflow.feedback, null);
    assert.equal(workflow.critique, null);
    assert.equal(workflow.finalResult, null);
    assert.equal(workflow.failureReason, null);
    assert.match(workflow.createdAt, /T/);
    assert.match(workflow.updatedAt, /T/);
    assert.equal(path.dirname(resolveWorkflowFile(repo, workflow.id)), resolveWorkflowsDir(repo));
    assert.ok(!resolveWorkflowFile(repo, workflow.id).includes(`${path.sep}jobs${path.sep}`));
    assert.deepEqual(readWorkflow(repo, workflow.id), workflow);
    assert.equal(listWorkflows(repo)[0].id, workflow.id);

    assert.equal(
      errorCode(() => reserveWorkflow(repo, {
        id: "workflow-secret",
        mode: "research",
        brief: "Research it.",
        originSessionId: "origin-session",
        modelManifest: [{ apiToken: "must-not-persist" }],
      })),
      "SECRET_BEARING_MANIFEST"
    );
    assert.throws(() => resolveWorkflowFile(repo, "../escape"), /Invalid workflow ID/);
  });

  it("accepts only the public model and tool manifest schemas", () => {
    const repo = createRepo();
    const modelManifest = [{
      role: "drafter",
      requestedModel: "opus",
      resolvedModel: "claude-opus-5",
    }];
    const toolManifest = [{
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
    }];
    const workflow = createWorkflow(repo, {
      id: "workflow-public-manifests",
      modelManifest,
      toolManifest,
    });

    assert.deepEqual(workflow.modelManifest, modelManifest);
    assert.deepEqual(workflow.toolManifest, toolManifest);

    for (const [index, manifests] of [
      { modelManifest: [{ privateKey: "hidden" }] },
      { toolManifest: [{ raw_config: { command: "server" } }] },
      { toolManifest: [{ mcp_servers: { docs: {} } }] },
      { toolManifest: [{ config: { headers: { Authorization: "hidden" } } }] },
    ].entries()) {
      assert.equal(
        errorCode(() => createWorkflow(repo, {
          id: `workflow-rejected-manifest-${index}`,
          ...manifests,
        })),
        "SECRET_BEARING_MANIFEST"
      );
    }
  });

  it("allows only one CAS stage start for a shared revision", async () => {
    const repo = createRepo();
    const workflow = createWorkflow(repo);

    const results = await Promise.all([
      spawnRace(repo, workflow.id, workflow.revision, workflow.epoch),
      spawnRace(repo, workflow.id, workflow.revision, workflow.epoch),
    ]);

    assert.equal(results.filter((result) => result.code === 0).length, 1);
    assert.equal(
      results.filter((result) => result.stderr.includes("STALE_REVISION")).length,
      1,
      JSON.stringify(results)
    );
    const stored = readWorkflow(repo, workflow.id);
    assert.equal(stored.revision, 1);
    assert.equal(stored.stages.memo.status, "running");
  });

  it("rejects duplicate continuation and keeps a completed memo immutable", () => {
    const repo = createRepo();
    const created = createWorkflow(repo);
    const started = casStartWorkflowStage(repo, created.id, {
      stage: "memo",
      revision: created.revision,
      epoch: created.epoch,
      mode: "design",
    });

    assert.equal(
      errorCode(() => casStartWorkflowStage(repo, created.id, {
        stage: "memo",
        revision: started.revision,
        epoch: started.epoch,
        mode: "design",
      })),
      "DUPLICATE_CONTINUE"
    );

    const payload = { summary: "memo", evidence: [{ file: "tracked.txt", line: 1 }] };
    const completed = submitWorkflowStage(repo, created.id, {
      stage: "memo",
      revision: started.revision,
      epoch: started.epoch,
      mode: "design",
      payload,
      field: "checkpoint",
      claudeSessionId: "claude-workflow-session",
      status: "awaiting_user",
    });
    const rawCompleted = fs.readFileSync(resolveWorkflowFile(repo, created.id), "utf8");

    assert.deepEqual(completed.stages.memo.payload, payload);
    assert.deepEqual(completed.checkpoint, payload);
    assert.equal(completed.claudeSessionId, "claude-workflow-session");
    assert.equal(
      errorCode(() => submitWorkflowStage(repo, created.id, {
        stage: "memo",
        revision: completed.revision,
        epoch: completed.epoch,
        mode: "design",
        payload: { summary: "replacement" },
      })),
      "COMPLETED_STAGE_IMMUTABLE"
    );
    assert.equal(fs.readFileSync(resolveWorkflowFile(repo, created.id), "utf8"), rawCompleted);
  });

  it("does not reopen a terminal workflow when its workspace drifts", () => {
    const repo = createRepo();
    let workflow = createWorkflow(repo);
    workflow = casStartWorkflowStage(repo, workflow.id, {
      stage: "memo",
      revision: workflow.revision,
      epoch: workflow.epoch,
    });
    workflow = submitWorkflowStage(repo, workflow.id, {
      stage: "memo",
      revision: workflow.revision,
      epoch: workflow.epoch,
      payload: { summary: "final" },
      field: "finalResult",
    });
    const before = fs.readFileSync(resolveWorkflowFile(repo, workflow.id));
    fs.writeFileSync(path.join(repo, "tracked.txt"), "drift after completion\n", "utf8");

    assert.equal(
      errorCode(() => casStartWorkflowStage(repo, workflow.id, {
        stage: "critique",
        revision: workflow.revision,
        epoch: workflow.epoch,
      })),
      "WORKFLOW_TERMINAL"
    );
    assert.deepEqual(fs.readFileSync(resolveWorkflowFile(repo, workflow.id)), before);
  });

  it("rejects a late stage submission after cancellation without changing stored bytes", () => {
    const repo = createRepo();
    let workflow = createWorkflow(repo, { id: "workflow-late-submit" });
    workflow = casStartWorkflowStage(repo, workflow.id, {
      stage: "memo",
      revision: workflow.revision,
      epoch: workflow.epoch,
    });
    workflow = completeWorkflowCancellation(repo, workflow.id, {
      revision: workflow.revision,
      epoch: workflow.epoch,
      failedJobIds: [],
    });
    const workflowFile = resolveWorkflowFile(repo, workflow.id);
    const before = fs.readFileSync(workflowFile);

    const code = errorCode(() => submitWorkflowStage(repo, workflow.id, {
      stage: "memo",
      revision: workflow.revision,
      epoch: workflow.epoch,
      payload: { summary: "late result" },
    }));

    assert.deepEqual(
      { code, unchanged: fs.readFileSync(workflowFile).equals(before) },
      { code: "WORKFLOW_TERMINAL", unchanged: true }
    );
    assert.equal(readWorkflow(repo, workflow.id).status, "cancelled");
  });

  it("rejects a late branch failure after cancellation without changing stored bytes", () => {
    const repo = createRepo();
    let workflow = createWorkflow(repo, { id: "workflow-late-failure" });
    workflow = casStartWorkflowStage(repo, workflow.id, {
      stage: "memo",
      branchId: "alpha",
      revision: workflow.revision,
      epoch: workflow.epoch,
    });
    workflow = completeWorkflowCancellation(repo, workflow.id, {
      revision: workflow.revision,
      epoch: workflow.epoch,
      failedJobIds: [],
    });
    const workflowFile = resolveWorkflowFile(repo, workflow.id);
    const before = fs.readFileSync(workflowFile);

    const code = errorCode(() => markWorkflowBranchFailure(repo, workflow.id, {
      stage: "memo",
      branchId: "alpha",
      revision: workflow.revision,
      epoch: workflow.epoch,
      reason: "late worker failure",
    }));

    assert.deepEqual(
      { code, unchanged: fs.readFileSync(workflowFile).equals(before) },
      { code: "WORKFLOW_TERMINAL", unchanged: true }
    );
    assert.equal(readWorkflow(repo, workflow.id).status, "cancelled");
  });

  it("reports only failed or missing retry work without rewriting successful payloads", () => {
    const repo = createRepo();
    let workflow = createWorkflow(repo);
    workflow = casStartWorkflowStage(repo, workflow.id, {
      stage: "memo", revision: workflow.revision, epoch: workflow.epoch,
    });
    workflow = submitWorkflowStage(repo, workflow.id, {
      stage: "memo", revision: workflow.revision, epoch: workflow.epoch,
      payload: { text: "keep these exact bytes: π" },
    });
    workflow = casStartWorkflowStage(repo, workflow.id, {
      stage: "critique", revision: workflow.revision, epoch: workflow.epoch,
    });
    workflow = markWorkflowBranchFailure(repo, workflow.id, {
      stage: "critique", revision: workflow.revision, epoch: workflow.epoch,
      reason: "model unavailable",
    });
    workflow = casStartWorkflowStage(repo, workflow.id, {
      stage: "memo", branchId: "alpha", revision: workflow.revision, epoch: workflow.epoch,
    });
    workflow = submitWorkflowStage(repo, workflow.id, {
      stage: "memo", branchId: "alpha", revision: workflow.revision, epoch: workflow.epoch,
      payload: { text: "alpha memo" },
    });
    workflow = casStartWorkflowStage(repo, workflow.id, {
      stage: "memo", branchId: "beta", revision: workflow.revision, epoch: workflow.epoch,
    });
    workflow = markWorkflowBranchFailure(repo, workflow.id, {
      stage: "memo", branchId: "beta", revision: workflow.revision, epoch: workflow.epoch,
      reason: "timeout",
    });
    const before = fs.readFileSync(resolveWorkflowFile(repo, workflow.id));

    const retry = getWorkflowRetryContext(repo, workflow.id, {
      mode: "design",
      requiredStages: ["memo", "critique", "final", "publish"],
      requiredBranches: ["alpha", "beta", "gamma"],
    });

    assert.deepEqual(retry.stages.map(({ stage, status }) => [stage, status]), [
      ["critique", "retryable_failed"],
      ["final", "pending"],
      ["publish", "missing"],
    ]);
    assert.deepEqual(retry.branches.map(({ branchId, status }) => [branchId, status]), [
      ["beta", "retryable_failed"],
      ["gamma", "missing"],
    ]);
    assert.equal(JSON.stringify(retry).includes("keep these exact bytes"), false);
    assert.deepEqual(fs.readFileSync(resolveWorkflowFile(repo, workflow.id)), before);
    assert.deepEqual(readWorkflow(repo, workflow.id).stages.memo.payload, {
      text: "keep these exact bytes: π",
    });
  });

  it("rejects stale epochs and mode/workspace mismatches while allowing explicit owner rebind", () => {
    const repo = createRepo();
    const otherRepo = createRepo();
    const created = createWorkflow(repo, { mode: "research" });
    const rebound = rebindWorkflowOwner(repo, created.id, {
      revision: created.revision,
      epoch: created.epoch,
      mode: "research",
      currentOwnerSessionId: "new-owner-session",
    });

    assert.equal(rebound.originSessionId, "origin-session");
    assert.equal(rebound.currentOwnerSessionId, "new-owner-session");
    assert.equal(rebound.epoch, 1);
    assert.equal(
      errorCode(() => casStartWorkflowStage(repo, created.id, {
        stage: "memo", revision: rebound.revision, epoch: 0, mode: "research",
      })),
      "STALE_EPOCH"
    );
    assert.equal(
      errorCode(() => casStartWorkflowStage(repo, created.id, {
        stage: "memo", revision: rebound.revision, epoch: rebound.epoch, mode: "design",
      })),
      "WORKFLOW_MODE_MISMATCH"
    );

    fs.mkdirSync(resolveWorkflowsDir(otherRepo), { recursive: true });
    fs.copyFileSync(
      resolveWorkflowFile(repo, created.id),
      resolveWorkflowFile(otherRepo, created.id)
    );
    assert.equal(
      errorCode(() => readWorkflow(otherRepo, created.id)),
      "WORKSPACE_MISMATCH"
    );
  });

  it("classifies drift before continuation and changes during a worker separately", () => {
    const staleRepo = createRepo();
    const stale = createWorkflow(staleRepo, { id: "workflow-stale" });
    fs.writeFileSync(path.join(staleRepo, "tracked.txt"), "changed before continue\n", "utf8");

    assert.equal(
      errorCode(() => casStartWorkflowStage(staleRepo, stale.id, {
        stage: "memo", revision: stale.revision, epoch: stale.epoch,
      })),
      "STALE_WORKSPACE"
    );
    assert.equal(readWorkflow(staleRepo, stale.id).failureReason, "STALE_WORKSPACE");

    const unsafeRepo = createRepo();
    let unsafe = createWorkflow(unsafeRepo, { id: "workflow-unsafe" });
    unsafe = casStartWorkflowStage(unsafeRepo, unsafe.id, {
      stage: "memo", revision: unsafe.revision, epoch: unsafe.epoch,
    });
    fs.writeFileSync(path.join(unsafeRepo, "tracked.txt"), "changed by worker\n", "utf8");

    assert.equal(
      errorCode(() => submitWorkflowStage(unsafeRepo, unsafe.id, {
        stage: "memo", revision: unsafe.revision, epoch: unsafe.epoch,
        payload: { text: "unsafe" },
      })),
      "SAFETY_VIOLATION"
    );
    const stored = readWorkflow(unsafeRepo, unsafe.id);
    assert.equal(stored.status, "incomplete");
    assert.equal(stored.failureReason, "SAFETY_VIOLATION");
    assert.equal(stored.stages.memo.status, "retryable_failed");
    assert.equal(stored.stages.memo.payload, null);
  });

  it("classifies workspace drift on the failure path as a safety violation", () => {
    const repo = createRepo();
    let workflow = createWorkflow(repo);
    workflow = casStartWorkflowStage(repo, workflow.id, {
      stage: "memo",
      branchId: "alpha",
      revision: workflow.revision,
      epoch: workflow.epoch,
    });
    fs.writeFileSync(path.join(repo, "tracked.txt"), "changed before failure\n", "utf8");

    assert.equal(
      errorCode(() => markWorkflowBranchFailure(repo, workflow.id, {
        stage: "memo",
        branchId: "alpha",
        revision: workflow.revision,
        epoch: workflow.epoch,
        reason: "worker timeout",
      })),
      "SAFETY_VIOLATION"
    );
    const stored = readWorkflow(repo, workflow.id);
    assert.equal(stored.status, "incomplete");
    assert.equal(stored.failureReason, "SAFETY_VIOLATION");
    assert.equal(stored.branches.alpha.status, "retryable_failed");
    assert.equal(stored.branches.alpha.failureReason, "SAFETY_VIOLATION");
    assert.equal(stored.branchAttempts.at(-1).failureReason, "SAFETY_VIOLATION");
  });

  it("retains nonterminal workflows and only the newest 100 terminal workflows", () => {
    const repo = createRepo();
    const workflowsDir = resolveWorkflowsDir(repo);
    fs.mkdirSync(workflowsDir, { recursive: true });
    const workspaceRoot = fs.realpathSync.native(repo);

    for (let index = 0; index < 104; index += 1) {
      const id = `terminal-${String(index).padStart(3, "0")}`;
      fs.writeFileSync(
        resolveWorkflowFile(repo, id),
        `${JSON.stringify({
          version: 1,
          id,
          mode: "design",
          status: "completed",
          phase: "done",
          revision: 1,
          epoch: 0,
          workspaceRoot,
          createdAt: new Date(index * 1000).toISOString(),
          updatedAt: new Date(index * 1000).toISOString(),
        }, null, 2)}\n`,
        "utf8"
      );
    }
    for (const [id, status] of [["waiting", "awaiting_user"], ["partial", "incomplete"]]) {
      fs.writeFileSync(
        resolveWorkflowFile(repo, id),
        `${JSON.stringify({
          version: 1,
          id,
          mode: "design",
          status,
          phase: status,
          revision: 1,
          epoch: 0,
          workspaceRoot,
          createdAt: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:00.000Z",
        }, null, 2)}\n`,
        "utf8"
      );
    }

    cleanupOldWorkflows(repo);
    const retained = listWorkflows(repo);

    assert.equal(retained.filter(({ status }) => status === "completed").length, 100);
    assert.ok(retained.some(({ id }) => id === "waiting"));
    assert.ok(retained.some(({ id }) => id === "partial"));
    assert.equal(fs.existsSync(resolveWorkflowFile(repo, "terminal-000")), false);
    assert.equal(fs.existsSync(resolveWorkflowFile(repo, "terminal-103")), true);
  });

  it("prunes terminal retention after a cancel-failed transition", () => {
    const repo = createRepo();
    const workflowsDir = resolveWorkflowsDir(repo);
    fs.mkdirSync(workflowsDir, { recursive: true });
    const workspaceRoot = fs.realpathSync.native(repo);
    for (let index = 0; index < 100; index += 1) {
      const id = `existing-terminal-${String(index).padStart(3, "0")}`;
      fs.writeFileSync(
        resolveWorkflowFile(repo, id),
        `${JSON.stringify({
          version: 1,
          id,
          mode: "design",
          status: "completed",
          phase: "done",
          revision: 1,
          epoch: 0,
          workspaceRoot,
          createdAt: new Date(index * 1000).toISOString(),
          updatedAt: new Date(index * 1000).toISOString(),
        }, null, 2)}\n`,
        "utf8"
      );
    }
    let workflow = createWorkflow(repo, { id: "new-cancel-failed" });
    workflow = casStartWorkflowStage(repo, workflow.id, {
      stage: "memo",
      revision: workflow.revision,
      epoch: workflow.epoch,
    });

    workflow = markWorkflowBranchFailure(repo, workflow.id, {
      stage: "memo",
      revision: workflow.revision,
      epoch: workflow.epoch,
      reason: "process identity unavailable",
      cancelFailed: true,
    });

    assert.equal(workflow.status, "cancel_failed");
    assert.equal(
      listWorkflows(repo).filter(({ status }) => ["completed", "cancelled", "cancel_failed"].includes(status)).length,
      100
    );
    assert.equal(fs.existsSync(resolveWorkflowFile(repo, "existing-terminal-000")), false);
  });

  it("records cancellation and preserves append-only branch attempt history", () => {
    const repo = createRepo();
    let workflow = createWorkflow(repo);
    workflow = casStartWorkflowStage(repo, workflow.id, {
      stage: "memo", branchId: "alpha", revision: workflow.revision, epoch: workflow.epoch,
    });
    const startedAttempt = structuredClone(workflow.branchAttempts[0]);
    workflow = markWorkflowBranchFailure(repo, workflow.id, {
      stage: "memo", branchId: "alpha", revision: workflow.revision, epoch: workflow.epoch,
      reason: "cancel signal failed", cancelFailed: true,
    });

    assert.deepEqual(workflow.branchAttempts[0], startedAttempt);
    assert.equal(workflow.branchAttempts[1].status, "cancel_failed");

    const cancelled = completeWorkflowCancellation(repo, workflow.id, {
      revision: workflow.revision,
      epoch: workflow.epoch,
      failedJobIds: ["workflow-child-a"],
    });
    assert.equal(cancelled.status, "cancel_failed");
    assert.equal(cancelled.failureReason, "CANCEL_FAILED");
    assert.deepEqual(cancelled.cancelFailedJobIds, ["workflow-child-a"]);
  });

  it("refuses to read a workflow record through a symlink outside managed state", () => {
    const repo = createRepo();
    const workflow = createWorkflow(repo, { id: "workflow-symlink" });
    const workflowFile = resolveWorkflowFile(repo, workflow.id);
    const outsideFile = path.join(repo, "outside-workflow.json");
    fs.renameSync(workflowFile, outsideFile);
    fs.symlinkSync(outsideFile, workflowFile);

    assert.equal(
      errorCode(() => readWorkflow(repo, workflow.id)),
      "UNSAFE_WORKFLOW_PATH"
    );
  });

  it("rejects a stored ID that does not match its workflow filename", () => {
    const repo = createRepo();
    const workflow = createWorkflow(repo, { id: "workflow-expected" });
    const workflowFile = resolveWorkflowFile(repo, workflow.id);
    fs.writeFileSync(
      workflowFile,
      `${JSON.stringify({ ...workflow, id: "workflow-other" }, null, 2)}\n`,
      "utf8"
    );

    assert.equal(
      errorCode(() => readWorkflow(repo, workflow.id)),
      "WORKFLOW_ID_MISMATCH"
    );
  });

  it("does not treat inherited object keys as declared workflow stages", () => {
    const repo = createRepo();
    const workflow = createWorkflow(repo, { stages: [] });

    assert.equal(
      errorCode(() => casStartWorkflowStage(repo, workflow.id, {
        stage: "toString",
        revision: workflow.revision,
        epoch: workflow.epoch,
      })),
      "WORKFLOW_STAGE_NOT_FOUND"
    );
  });
});
