/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import "./test-env.mjs";

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import {
  cleanupOldWorkflows,
  activateWorkflowAttempt,
  commitWorkflowStage,
  completeWorkflowCancellation,
  completeWorkflowSessionEnd,
  getWorkflowRetryContext,
  listWorkflows,
  markWorkflowBranchFailure,
  markWorkflowNotification,
  preflightWorkflowAttempt,
  readWorkflow,
  rebindWorkflowOwner,
  reserveWorkflowCancellation,
  reserveWorkflow,
  reserveWorkflowAttempts,
  resolveWorkflowFile,
  resolveWorkflowsDir,
  submitWorkflowStage,
  revealWorkflowStage,
  workflowNotificationEvent,
} from "../scripts/lib/workflows.mjs";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WORKFLOW_RACE_FIXTURE = path.join(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "activate-workflow-attempt.mjs"
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

function casStartWorkflowStage(cwd, workflowId, options) {
  const reservation = reserveWorkflowAttempts(cwd, workflowId, options, [{
    stage: options.stage,
    ...(options.branchId ? { branchId: options.branchId } : {}),
  }]);
  const key = options.branchId ? `branch:${options.branchId}` : `stage:${options.stage}`;
  const lease = reservation.leases[key];
  const workflow = activateWorkflowAttempt(cwd, workflowId, {
    ...options,
    revision: reservation.workflow.revision,
    lease,
  });
  Object.defineProperty(workflow, "attemptLease", { value: lease });
  return workflow;
}

function spawnRace(repo, id, revision, epoch, lease) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [WORKFLOW_RACE_FIXTURE, repo, id, String(revision), String(epoch)],
      { cwd: PROJECT_ROOT, env: process.env, stdio: ["pipe", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ lease, stage: "memo", branchId: null }));
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("peer workflow store", () => {
  it("requires the captured attempt lease and epoch for every late callback", () => {
    const repo = createRepo();
    const created = createWorkflow(repo, { id: "workflow-attempt-lease" });
    const first = casStartWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: created.revision, epoch: created.epoch,
    });
    assert.match(first.attemptLease, /^[a-f0-9]{64}$/u);
    const storedSource = fs.readFileSync(resolveWorkflowFile(repo, created.id), "utf8");
    assert.doesNotMatch(storedSource, new RegExp(first.attemptLease));
    assert.match(
      readWorkflow(repo, created.id).branches.alpha.attemptReservation.leaseDigest,
      /^[a-f0-9]{64}$/u
    );

    assert.equal(errorCode(() => submitWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: first.revision, epoch: first.epoch,
      payload: { summary: "missing lease" },
    })), "STALE_ATTEMPT");
    const failed = markWorkflowBranchFailure(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: first.revision, epoch: first.epoch,
      lease: first.attemptLease,
      reason: "retry",
    });
    const second = casStartWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: failed.revision, epoch: failed.epoch,
    });
    assert.notEqual(second.attemptLease, first.attemptLease);
    assert.equal(errorCode(() => submitWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: second.revision, epoch: second.epoch,
      lease: first.attemptLease,
      payload: { summary: "late success" },
    })), "STALE_ATTEMPT");
    assert.equal(errorCode(() => markWorkflowBranchFailure(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: second.revision, epoch: second.epoch,
      lease: first.attemptLease,
      reason: "late failure",
    })), "STALE_ATTEMPT");
  });

  it("commits without plaintext and reveals only with the same attempt fence", () => {
    const repo = createRepo();
    const marker = "CLAUDE_COMMIT_REVEAL_MARKER_41B7";
    const created = createWorkflow(repo, { id: "workflow-commit-reveal" });
    const started = casStartWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: created.revision, epoch: created.epoch,
    });
    const payload = { summary: marker };
    const committed = commitWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: started.revision, epoch: started.epoch,
      lease: started.attemptLease,
      payload,
    });
    assert.equal(committed.branches.alpha.status, "running");
    assert.equal(committed.branches.alpha.payload, null);
    assert.match(committed.branches.alpha.commitment, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(
      fs.readFileSync(resolveWorkflowFile(repo, created.id), "utf8"),
      new RegExp(marker)
    );
    assert.equal(errorCode(() => revealWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: committed.revision, epoch: committed.epoch,
      lease: "f".repeat(64), payload,
    })), "STALE_ATTEMPT");
    const revealed = revealWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: committed.revision, epoch: committed.epoch,
      lease: started.attemptLease, payload,
    });
    assert.deepEqual(revealed.branches.alpha.payload, payload);
  });

  it("reserves cancellation before awaits and rejects callbacks from the old epoch", () => {
    const repo = createRepo();
    const created = createWorkflow(repo, { id: "workflow-cancellation-lease" });
    const started = casStartWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: created.revision, epoch: created.epoch,
    });
    const cancellation = reserveWorkflowCancellation(repo, created.id, {
      revision: started.revision,
      epoch: started.epoch,
      mode: started.mode,
    });
    assert.equal(cancellation.workflow.epoch, started.epoch + 1);
    assert.equal(cancellation.workflow.status, "running");
    assert.match(cancellation.lease, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(
      fs.readFileSync(resolveWorkflowFile(repo, created.id), "utf8"),
      new RegExp(cancellation.lease)
    );
    assert.equal(errorCode(() => submitWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: cancellation.workflow.revision,
      epoch: started.epoch,
      lease: started.attemptLease,
      payload: { summary: "late" },
    })), "STALE_EPOCH");
    const cancelled = completeWorkflowCancellation(repo, created.id, {
      revision: cancellation.workflow.revision,
      epoch: cancellation.workflow.epoch,
      lease: cancellation.lease,
      failedJobIds: [],
    });
    assert.equal(cancelled.status, "cancelled");
  });

  it("terminalizes every unfinished target when cancellation completes", () => {
    const repo = createRepo();
    const created = createWorkflow(repo, { id: "workflow-cancellation-targets" });
    const started = casStartWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: created.revision, epoch: created.epoch,
    });
    const cancellation = reserveWorkflowCancellation(repo, created.id, {
      revision: started.revision,
      epoch: started.epoch,
    });
    const cancelled = completeWorkflowCancellation(repo, created.id, {
      revision: cancellation.workflow.revision,
      epoch: cancellation.workflow.epoch,
      lease: cancellation.lease,
      failedJobIds: [],
    });

    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.branches.alpha.status, "retryable_failed");
    assert.equal(cancelled.branches.alpha.failureReason, "CANCELLED");
    assert.equal(Object.hasOwn(cancelled.branches.alpha, "attemptReservation"), false);
    assert.equal(Object.hasOwn(cancelled.branches.alpha, "commitment"), false);
  });

  it("classifies unfinished targets cancel_failed when linked cancellation fails", () => {
    const repo = createRepo();
    const created = createWorkflow(repo, { id: "workflow-cancellation-failed-targets" });
    const started = casStartWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: created.revision, epoch: created.epoch,
    });
    const cancellation = reserveWorkflowCancellation(repo, created.id, {
      revision: started.revision,
      epoch: started.epoch,
    });
    const cancelled = completeWorkflowCancellation(repo, created.id, {
      revision: cancellation.workflow.revision,
      epoch: cancellation.workflow.epoch,
      lease: cancellation.lease,
      failedJobIds: ["workflow-child-a"],
    });

    assert.equal(cancelled.status, "cancel_failed");
    assert.equal(cancelled.branches.alpha.status, "cancel_failed");
    assert.equal(cancelled.branches.alpha.failureReason, "CANCEL_FAILED");
    assert.deepEqual(cancelled.cancelFailedJobIds, ["workflow-child-a"]);
  });

  it("preserves completed target payloads and refuses to reserve terminal workflows", () => {
    const repo = createRepo();
    const created = createWorkflow(repo, { id: "workflow-terminal-cancel" });
    const started = casStartWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: created.revision, epoch: created.epoch,
    });
    const payload = { summary: "sealed evidence" };
    const completed = submitWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: started.revision, epoch: started.epoch,
      lease: started.attemptLease, payload,
    });
    const cancellation = reserveWorkflowCancellation(repo, created.id, {
      revision: completed.revision,
      epoch: completed.epoch,
    });
    const cancelled = completeWorkflowCancellation(repo, created.id, {
      revision: cancellation.workflow.revision,
      epoch: cancellation.workflow.epoch,
      lease: cancellation.lease,
      failedJobIds: [],
    });
    assert.equal(cancelled.branches.alpha.status, "completed");
    assert.deepEqual(cancelled.branches.alpha.payload, payload);
    const storedBefore = fs.readFileSync(resolveWorkflowFile(repo, created.id));

    assert.equal(errorCode(() => reserveWorkflowCancellation(repo, created.id, {
      revision: cancelled.revision,
      epoch: cancelled.epoch,
    })), "WORKFLOW_TERMINAL");
    assert.deepEqual(fs.readFileSync(resolveWorkflowFile(repo, created.id)), storedBefore);
  });

  it("allocates a persistent notification key for every incomplete generation", () => {
    const repo = createRepo();
    const created = createWorkflow(repo, { id: "workflow-incomplete-generation" });
    const first = casStartWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: created.revision, epoch: created.epoch,
    });
    let failed = markWorkflowBranchFailure(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: first.revision, epoch: first.epoch,
      lease: first.attemptLease,
      reason: "first",
    });
    assert.equal(workflowNotificationEvent(failed), "incomplete:1");
    failed = markWorkflowNotification(repo, created.id, {
      event: "incomplete:1",
      revision: failed.revision,
      epoch: failed.epoch,
    });
    const second = casStartWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: failed.revision, epoch: failed.epoch,
    });
    const failedAgain = markWorkflowBranchFailure(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: second.revision, epoch: second.epoch,
      lease: second.attemptLease,
      reason: "second",
    });
    assert.equal(workflowNotificationEvent(failedAgain), "incomplete:2");
    assert.deepEqual(failedAgain.notifiedEvents, ["incomplete:1"]);
  });

  it("preserves bounded failure detail through retry context and activation", () => {
    const repo = createRepo();
    const created = createWorkflow(repo, { id: "workflow-failure-detail" });
    let workflow = casStartWorkflowStage(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: created.revision, epoch: created.epoch,
    });
    workflow = markWorkflowBranchFailure(repo, workflow.id, {
      stage: "memo", branchId: "alpha",
      revision: workflow.revision, epoch: workflow.epoch,
      lease: workflow.attemptLease,
      reason: "EVIDENCE_INCOMPLETE",
      failureDetail: "DIRECT_HTTPS_CITATION_REQUIRED",
    });

    assert.equal(workflow.failureDetail, "DIRECT_HTTPS_CITATION_REQUIRED");
    assert.equal(workflow.branches.alpha.failureDetail, "DIRECT_HTTPS_CITATION_REQUIRED");
    assert.equal(workflow.branchAttempts.at(-1).failureDetail, "DIRECT_HTTPS_CITATION_REQUIRED");
    assert.equal(
      getWorkflowRetryContext(repo, workflow.id, { requiredBranches: ["alpha"] })
        .branches[0].failureDetail,
      "DIRECT_HTTPS_CITATION_REQUIRED"
    );

    const reservation = reserveWorkflowAttempts(repo, workflow.id, {
      revision: workflow.revision,
      epoch: workflow.epoch,
    }, [{ stage: "memo", branchId: "alpha" }]);
    assert.equal(
      reservation.workflow.branches.alpha.attemptReservation.previousFailureDetail,
      "DIRECT_HTTPS_CITATION_REQUIRED"
    );
    const activated = activateWorkflowAttempt(repo, workflow.id, {
      stage: "memo",
      branchId: "alpha",
      revision: reservation.workflow.revision,
      epoch: reservation.workflow.epoch,
      lease: reservation.leases["branch:alpha"],
    });
    assert.equal(activated.failureDetail, null);
    assert.equal(activated.branches.alpha.failureDetail, null);
    assert.equal(
      activated.branches.alpha.attemptReservation.previousFailureDetail,
      "DIRECT_HTTPS_CITATION_REQUIRED"
    );

    const invalidRepo = createRepo();
    const invalidCreated = createWorkflow(invalidRepo, { id: "workflow-invalid-detail" });
    let invalid = casStartWorkflowStage(invalidRepo, invalidCreated.id, {
      stage: "memo", branchId: "alpha",
      revision: invalidCreated.revision, epoch: invalidCreated.epoch,
    });
    const rawDetail = `DIRECT_HTTPS_CITATION_REQUIRED:${"raw-model-output".repeat(100)}`;
    invalid = markWorkflowBranchFailure(invalidRepo, invalid.id, {
      stage: "memo", branchId: "alpha",
      revision: invalid.revision, epoch: invalid.epoch,
      lease: invalid.attemptLease,
      reason: "EVIDENCE_INCOMPLETE",
      failureDetail: rawDetail,
    });
    assert.equal(invalid.failureDetail, null);
    assert.equal(invalid.branches.alpha.failureDetail, null);
    assert.equal(invalid.branchAttempts.at(-1).failureDetail, null);
    assert.doesNotMatch(fs.readFileSync(resolveWorkflowFile(invalidRepo, invalid.id), "utf8"), /raw-model-output/u);
  });

  it("keeps aggregate failure state in both sibling completion orderings", () => {
    for (const failureFirst of [true, false]) {
      const repo = createRepo();
      const created = createWorkflow(repo, {
        id: `workflow-sibling-order-${failureFirst ? "failure" : "success"}`,
      });
      const reservation = reserveWorkflowAttempts(repo, created.id, {
        revision: created.revision,
        epoch: created.epoch,
      }, [
        { stage: "memo", branchId: "alpha" },
        { stage: "memo", branchId: "beta" },
      ]);
      let workflow = activateWorkflowAttempt(repo, created.id, {
        stage: "memo", branchId: "alpha",
        revision: reservation.workflow.revision,
        epoch: reservation.workflow.epoch,
        lease: reservation.leases["branch:alpha"],
      });
      workflow = activateWorkflowAttempt(repo, created.id, {
        stage: "memo", branchId: "beta",
        revision: workflow.revision,
        epoch: workflow.epoch,
        lease: reservation.leases["branch:beta"],
      });
      const fail = () => markWorkflowBranchFailure(repo, workflow.id, {
        stage: "memo", branchId: "alpha",
        revision: workflow.revision, epoch: workflow.epoch,
        lease: reservation.leases["branch:alpha"],
        reason: "EVIDENCE_INCOMPLETE",
        failureDetail: "WEB_TOOL_EVENT_REQUIRED",
      });
      const succeed = () => submitWorkflowStage(repo, workflow.id, {
        stage: "memo", branchId: "beta",
        revision: workflow.revision, epoch: workflow.epoch,
        lease: reservation.leases["branch:beta"],
        payload: { summary: "late sibling success" },
      });
      if (failureFirst) {
        workflow = fail();
        workflow = succeed();
      } else {
        workflow = succeed();
        workflow = fail();
      }

      assert.equal(workflow.status, "incomplete", String(failureFirst));
      assert.equal(workflow.failureReason, "EVIDENCE_INCOMPLETE", String(failureFirst));
      assert.equal(workflow.failureDetail, "WEB_TOOL_EVENT_REQUIRED", String(failureFirst));
      assert.equal(workflow.branches.alpha.status, "retryable_failed", String(failureFirst));
      assert.equal(workflow.branches.beta.status, "completed", String(failureFirst));
    }
  });

  it("keeps aggregate failure when a reserved sibling activates after the failure", () => {
    const repo = createRepo();
    const created = createWorkflow(repo, { id: "workflow-late-sibling-activation" });
    const reservation = reserveWorkflowAttempts(repo, created.id, {
      revision: created.revision,
      epoch: created.epoch,
    }, [
      { stage: "memo", branchId: "alpha" },
      { stage: "memo", branchId: "beta" },
    ]);
    let workflow = activateWorkflowAttempt(repo, created.id, {
      stage: "memo", branchId: "alpha",
      revision: reservation.workflow.revision,
      epoch: reservation.workflow.epoch,
      lease: reservation.leases["branch:alpha"],
    });
    workflow = markWorkflowBranchFailure(repo, workflow.id, {
      stage: "memo", branchId: "alpha",
      revision: workflow.revision, epoch: workflow.epoch,
      lease: reservation.leases["branch:alpha"],
      reason: "EVIDENCE_INCOMPLETE",
      failureDetail: "REPOSITORY_CITATION_REQUIRED",
    });

    workflow = activateWorkflowAttempt(repo, workflow.id, {
      stage: "memo", branchId: "beta",
      revision: workflow.revision, epoch: workflow.epoch,
      lease: reservation.leases["branch:beta"],
    });
    assert.equal(workflow.status, "incomplete");
    assert.equal(workflow.failureReason, "EVIDENCE_INCOMPLETE");
    assert.equal(workflow.failureDetail, "REPOSITORY_CITATION_REQUIRED");

    workflow = submitWorkflowStage(repo, workflow.id, {
      stage: "memo", branchId: "beta",
      revision: workflow.revision, epoch: workflow.epoch,
      lease: reservation.leases["branch:beta"],
      payload: { summary: "late sibling success" },
    });
    assert.equal(workflow.status, "incomplete");
    assert.equal(workflow.failureReason, "EVIDENCE_INCOMPLETE");
    assert.equal(workflow.failureDetail, "REPOSITORY_CITATION_REQUIRED");
    assert.equal(workflow.branches.alpha.status, "retryable_failed");
    assert.equal(workflow.branches.beta.status, "completed");
  });

  it("clears aggregate failure when the only retryable target completes one-shot", () => {
    const repo = createRepo();
    let workflow = createWorkflow(repo, {
      id: "workflow-one-shot-recovery",
      stages: ["final"],
      branches: [],
    });
    workflow = markWorkflowBranchFailure(repo, workflow.id, {
      stage: "final",
      revision: workflow.revision,
      epoch: workflow.epoch,
      oneShot: true,
      reason: "EVIDENCE_INCOMPLETE",
      failureDetail: "NON_EMPTY_CONTENT_REQUIRED",
    });

    workflow = submitWorkflowStage(repo, workflow.id, {
      stage: "final",
      revision: workflow.revision,
      epoch: workflow.epoch,
      oneShot: true,
      payload: { answer: "recovered" },
      field: "finalResult",
      status: "completed",
      phase: "done",
    });

    assert.equal(workflow.status, "completed");
    assert.equal(workflow.phase, "done");
    assert.equal(workflow.failureReason, null);
    assert.equal(workflow.failureDetail, null);
    assert.equal(workflow.stages.final.status, "completed");
  });

  it("clears stale-workspace aggregate failure when its pending reservation activates", () => {
    const repo = createRepo();
    const created = createWorkflow(repo, {
      id: "workflow-stale-pending-recovery",
      stages: ["memo"],
      branches: [],
    });
    const reservation = reserveWorkflowAttempts(repo, created.id, {
      revision: created.revision,
      epoch: created.epoch,
    }, [{ stage: "memo" }]);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "changed before activation\n", "utf8");

    assert.equal(errorCode(() => activateWorkflowAttempt(repo, created.id, {
      stage: "memo",
      revision: reservation.workflow.revision,
      epoch: reservation.workflow.epoch,
      lease: reservation.leases["stage:memo"],
    })), "STALE_WORKSPACE");

    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n", "utf8");
    const stale = readWorkflow(repo, created.id);
    const recovered = activateWorkflowAttempt(repo, created.id, {
      stage: "memo",
      revision: stale.revision,
      epoch: stale.epoch,
      lease: reservation.leases["stage:memo"],
    });
    assert.equal(recovered.status, "running");
    assert.equal(recovered.failureReason, null);
    assert.equal(recovered.failureDetail, null);
    assert.equal(recovered.stages.memo.status, "running");
  });

  it("preserves reserved retry failure detail across owner and SessionEnd rotation", () => {
    for (const action of ["rebind", "session-end"]) {
      const repo = createRepo();
      let workflow = createWorkflow(repo, {
        id: `workflow-reserved-detail-${action}`,
        stages: [],
        branches: ["alpha"],
      });
      workflow = casStartWorkflowStage(repo, workflow.id, {
        stage: "memo",
        branchId: "alpha",
        revision: workflow.revision,
        epoch: workflow.epoch,
      });
      workflow = markWorkflowBranchFailure(repo, workflow.id, {
        stage: "memo",
        branchId: "alpha",
        revision: workflow.revision,
        epoch: workflow.epoch,
        lease: workflow.attemptLease,
        reason: "EVIDENCE_INCOMPLETE",
        failureDetail: "REPOSITORY_TOOL_EVENT_REQUIRED",
      });
      const firstReservation = reserveWorkflowAttempts(repo, workflow.id, {
        revision: workflow.revision,
        epoch: workflow.epoch,
      }, [{ stage: "memo", branchId: "alpha" }]);

      if (action === "rebind") {
        workflow = rebindWorkflowOwner(repo, workflow.id, {
          revision: firstReservation.workflow.revision,
          epoch: firstReservation.workflow.epoch,
          currentOwnerSessionId: "owner-b",
        });
      } else {
        const cancellation = reserveWorkflowCancellation(repo, workflow.id, {
          revision: firstReservation.workflow.revision,
          epoch: firstReservation.workflow.epoch,
        });
        workflow = completeWorkflowSessionEnd(repo, workflow.id, {
          revision: cancellation.workflow.revision,
          epoch: cancellation.workflow.epoch,
          lease: cancellation.lease,
          cancelFailedTargets: [],
        });
      }

      assert.equal(workflow.failureReason, "EVIDENCE_INCOMPLETE", action);
      assert.equal(workflow.failureDetail, "REPOSITORY_TOOL_EVENT_REQUIRED", action);
      assert.equal(workflow.branches.alpha.failureReason, "EVIDENCE_INCOMPLETE", action);
      assert.equal(
        workflow.branches.alpha.failureDetail,
        "REPOSITORY_TOOL_EVENT_REQUIRED",
        action
      );
      assert.equal(Object.hasOwn(workflow.branches.alpha, "attemptReservation"), false, action);

      const nextReservation = reserveWorkflowAttempts(repo, workflow.id, {
        revision: workflow.revision,
        epoch: workflow.epoch,
      }, [{ stage: "memo", branchId: "alpha" }]);
      assert.equal(
        nextReservation.workflow.branches.alpha.attemptReservation.previousFailureDetail,
        "REPOSITORY_TOOL_EVENT_REQUIRED",
        action
      );
    }
  });
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
    const created = createWorkflow(repo);
    const reservation = reserveWorkflowAttempts(repo, created.id, {
      revision: created.revision,
      epoch: created.epoch,
    }, [{ stage: "memo" }]);
    const lease = reservation.leases["stage:memo"];

    const results = await Promise.all([
      spawnRace(repo, reservation.workflow.id, reservation.workflow.revision, reservation.workflow.epoch, lease),
      spawnRace(repo, reservation.workflow.id, reservation.workflow.revision, reservation.workflow.epoch, lease),
    ]);

    assert.equal(results.filter((result) => result.code === 0).length, 1);
    assert.equal(
      results.filter((result) => result.stderr.includes("STALE_REVISION")).length,
      1,
      JSON.stringify(results)
    );
    const stored = readWorkflow(repo, reservation.workflow.id);
    assert.equal(stored.revision, 2);
    assert.equal(stored.stages.memo.status, "running");
  });

  it("preflights attempts read-only without evaluating workspace drift", () => {
    const repo = createRepo();
    const created = createWorkflow(repo, {
      id: "workflow-attempt-preflight",
      stages: ["memo"],
      branches: [],
    });
    const reservation = reserveWorkflowAttempts(repo, created.id, {
      revision: created.revision,
      epoch: created.epoch,
    }, [{ stage: "memo" }]);
    const options = {
      stage: "memo",
      epoch: reservation.workflow.epoch,
      mode: reservation.workflow.mode,
      lease: reservation.leases["stage:memo"],
    };
    const before = fs.readFileSync(resolveWorkflowFile(repo, created.id));

    assert.deepEqual(
      preflightWorkflowAttempt(repo, created.id, options),
      reservation.workflow
    );
    assert.deepEqual(fs.readFileSync(resolveWorkflowFile(repo, created.id)), before);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "drift before activation\n", "utf8");
    assert.deepEqual(
      preflightWorkflowAttempt(repo, created.id, options),
      reservation.workflow
    );
    assert.deepEqual(fs.readFileSync(resolveWorkflowFile(repo, created.id)), before);

    assert.equal(errorCode(() => activateWorkflowAttempt(repo, created.id, {
      ...options,
      revision: reservation.workflow.revision,
    })), "STALE_WORKSPACE");
    const stored = readWorkflow(repo, created.id);
    assert.equal(stored.status, "incomplete");
    assert.equal(stored.failureReason, "STALE_WORKSPACE");
    assert.equal(stored.revision, reservation.workflow.revision + 1);
  });

  it("rejects branch activation through a stage other than the reserved stage", () => {
    const repo = createRepo();
    const created = createWorkflow(repo, { id: "workflow-branch-stage-fence" });
    const reservation = reserveWorkflowAttempts(repo, created.id, {
      revision: created.revision,
      epoch: created.epoch,
    }, [{ stage: "memo", branchId: "alpha" }]);
    const before = fs.readFileSync(resolveWorkflowFile(repo, created.id));

    assert.equal(errorCode(() => activateWorkflowAttempt(repo, created.id, {
      stage: "critique",
      branchId: "alpha",
      revision: reservation.workflow.revision,
      epoch: reservation.workflow.epoch,
      lease: reservation.leases["branch:alpha"],
    })), "WORKFLOW_STAGE_MISMATCH");
    assert.deepEqual(fs.readFileSync(resolveWorkflowFile(repo, created.id)), before);
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
      lease: started.attemptLease,
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
      lease: workflow.attemptLease,
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
    const cancellation = reserveWorkflowCancellation(repo, workflow.id, {
      revision: workflow.revision, epoch: workflow.epoch,
    });
    workflow = completeWorkflowCancellation(repo, workflow.id, {
      revision: cancellation.workflow.revision,
      epoch: cancellation.workflow.epoch,
      lease: cancellation.lease,
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
    const cancellation = reserveWorkflowCancellation(repo, workflow.id, {
      revision: workflow.revision, epoch: workflow.epoch,
    });
    workflow = completeWorkflowCancellation(repo, workflow.id, {
      revision: cancellation.workflow.revision,
      epoch: cancellation.workflow.epoch,
      lease: cancellation.lease,
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
      lease: workflow.attemptLease,
    });
    workflow = casStartWorkflowStage(repo, workflow.id, {
      stage: "critique", revision: workflow.revision, epoch: workflow.epoch,
    });
    workflow = markWorkflowBranchFailure(repo, workflow.id, {
      stage: "critique", revision: workflow.revision, epoch: workflow.epoch,
      reason: "model unavailable",
      lease: workflow.attemptLease,
    });
    workflow = casStartWorkflowStage(repo, workflow.id, {
      stage: "memo", branchId: "alpha", revision: workflow.revision, epoch: workflow.epoch,
    });
    workflow = submitWorkflowStage(repo, workflow.id, {
      stage: "memo", branchId: "alpha", revision: workflow.revision, epoch: workflow.epoch,
      payload: { text: "alpha memo" },
      lease: workflow.attemptLease,
    });
    workflow = casStartWorkflowStage(repo, workflow.id, {
      stage: "memo", branchId: "beta", revision: workflow.revision, epoch: workflow.epoch,
    });
    workflow = markWorkflowBranchFailure(repo, workflow.id, {
      stage: "memo", branchId: "beta", revision: workflow.revision, epoch: workflow.epoch,
      reason: "timeout",
      lease: workflow.attemptLease,
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
    const staleStored = readWorkflow(staleRepo, stale.id);
    assert.equal(staleStored.failureReason, "STALE_WORKSPACE");
    assert.equal(staleStored.incompleteGeneration, 1);
    assert.equal(workflowNotificationEvent(staleStored), "incomplete:1");

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
        lease: unsafe.attemptLease,
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
        lease: workflow.attemptLease,
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
      lease: workflow.attemptLease,
    });

    assert.equal(workflow.status, "cancel_failed");
    assert.equal(
      listWorkflows(repo).filter(({ status }) => ["completed", "cancelled", "cancel_failed"].includes(status)).length,
      100
    );
    assert.equal(fs.existsSync(resolveWorkflowFile(repo, "existing-terminal-000")), false);
  });

  it("preserves append-only branch history and refuses to recancel cancel_failed", () => {
    const repo = createRepo();
    let workflow = createWorkflow(repo);
    workflow = casStartWorkflowStage(repo, workflow.id, {
      stage: "memo", branchId: "alpha", revision: workflow.revision, epoch: workflow.epoch,
    });
    const startedAttempt = structuredClone(workflow.branchAttempts[0]);
    workflow = markWorkflowBranchFailure(repo, workflow.id, {
      stage: "memo", branchId: "alpha", revision: workflow.revision, epoch: workflow.epoch,
      reason: "cancel signal failed", cancelFailed: true,
      lease: workflow.attemptLease,
    });

    assert.deepEqual(workflow.branchAttempts[0], startedAttempt);
    assert.equal(workflow.branchAttempts[1].status, "cancel_failed");

    const before = fs.readFileSync(resolveWorkflowFile(repo, workflow.id));
    assert.equal(errorCode(() => reserveWorkflowCancellation(repo, workflow.id, {
      revision: workflow.revision, epoch: workflow.epoch,
    })), "WORKFLOW_TERMINAL");
    assert.deepEqual(fs.readFileSync(resolveWorkflowFile(repo, workflow.id)), before);
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
