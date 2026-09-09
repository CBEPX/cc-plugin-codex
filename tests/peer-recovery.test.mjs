/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import "./test-env.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import * as peerOrchestration from "../scripts/lib/peer-orchestration.mjs";
import * as workflows from "../scripts/lib/workflows.mjs";

const tempDirs = [];

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function createRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cc-peer-recovery-"));
  tempDirs.push(repo);
  runGit(repo, ["init", "--initial-branch=main"]);
  runGit(repo, ["config", "user.name", "Codex Test"]);
  runGit(repo, ["config", "user.email", "codex@example.com"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n", "utf8");
  runGit(repo, ["add", "tracked.txt"]);
  runGit(repo, ["commit", "-m", "initial"]);
  return repo;
}

function api(module, name) {
  assert.equal(typeof module[name], "function", `${name} must be exported`);
  return module[name];
}

function createPeer(repo, id) {
  const created = workflows.reserveWorkflow(repo, {
    id,
    mode: "design",
    brief: "Recover peer work deterministically.",
    originSessionId: "owner-a",
    stages: ["checkpoint", "critique", "synthesis"],
    branches: ["codex", "claude"],
  });
  return workflows.reserveWorkflowAttempts(repo, created.id, {
    revision: created.revision,
    epoch: created.epoch,
  }, [
    { stage: "memo", branchId: "codex" },
    { stage: "memo", branchId: "claude" },
    { stage: "checkpoint" },
  ]);
}

function activate(repo, workflow, stage, branchId, lease) {
  return workflows.activateWorkflowAttempt(repo, workflow.id, {
    revision: workflow.revision,
    epoch: workflow.epoch,
    stage,
    ...(branchId ? { branchId } : {}),
    lease,
  });
}

function committedClaude(repo, id) {
  const reservation = createPeer(repo, id);
  const lease = reservation.leases["branch:claude"];
  let workflow = activate(repo, reservation.workflow, "memo", "claude", lease);
  workflow = workflows.commitWorkflowStage(repo, workflow.id, {
    revision: workflow.revision,
    epoch: workflow.epoch,
    stage: "memo",
    branchId: "claude",
    lease,
    payload: { marker: `plaintext-${id}` },
  });
  return { reservation, workflow, lease };
}

function errorCode(fn) {
  try {
    fn();
  } catch (error) {
    return error?.code;
  }
  return null;
}

function hasErrorCode(error, code) {
  return error instanceof Error &&
    /** @type {Error & {code?: string}} */ (error).code === code;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("bounded peer recovery", () => {
  it("uses one absolute 30-minute deadline and exponential 100ms-to-2s polling", async () => {
    const waitForCodexMemo = api(peerOrchestration, "waitForCodexMemo");
    let now = 0;
    const sleeps = [];
    const workflow = {
      epoch: 4,
      branches: { codex: { status: "pending" } },
    };

    await assert.rejects(
      waitForCodexMemo(() => workflow, 4, {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      }),
      (error) => hasErrorCode(error, "PEER_SIBLING_TIMEOUT")
    );

    assert.equal(now, 30 * 60 * 1000);
    assert.deepEqual(sleeps.slice(0, 6), [100, 200, 400, 800, 1600, 2000]);
    assert.equal(Math.max(...sleeps), 2000);
    assert.ok(sleeps.at(-1) <= 2000);
  });

  it("keeps waiting through a retryable Codex failure and observes its successful retry", async () => {
    const waitForCodexMemo = api(peerOrchestration, "waitForCodexMemo");
    let now = 0;
    let status = "retryable_failed";
    const sleeps = [];

    const completed = await waitForCodexMemo(() => ({
      epoch: 7,
      branches: { codex: { status } },
    }), 7, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
        status = sleeps.length === 1 ? "running" : "completed";
      },
    });

    assert.equal(completed.branches.codex.status, "completed");
    assert.deepEqual(sleeps, [100, 200]);
  });

  it("makes only Claude retryable and discards its commitment after sibling timeout", () => {
    const repo = createRepo();
    const { workflow, lease } = committedClaude(repo, "workflow-sibling-timeout");
    const codexBefore = structuredClone(workflow.branches.codex);

    const failed = workflows.markWorkflowBranchFailure(repo, workflow.id, {
      revision: workflow.revision,
      epoch: workflow.epoch,
      stage: "memo",
      branchId: "claude",
      lease,
      reason: "PEER_SIBLING_TIMEOUT",
    });

    assert.equal(failed.branches.claude.status, "retryable_failed");
    assert.equal(failed.branches.claude.failureReason, "PEER_SIBLING_TIMEOUT");
    assert.equal(failed.branches.claude.payload, null);
    assert.equal(failed.branches.claude.commitment, undefined);
    assert.deepEqual(failed.branches.codex, codexBefore);
  });

  it("invalidates stale waiters and attempt leases on rebind, SessionEnd, and cancel", async () => {
    const waitForCodexMemo = api(peerOrchestration, "waitForCodexMemo");
    for (const action of ["rebind", "session-end", "cancel"]) {
      const repo = createRepo();
      const reservation = createPeer(repo, `workflow-${action}`);
      const oldLease = reservation.leases["branch:codex"];
      let latest = reservation.workflow;
      const waiting = waitForCodexMemo(
        () => workflows.readWorkflow(repo, reservation.workflow.id),
        reservation.workflow.epoch,
        {
          now: () => 0,
          sleep: async () => {
            const current = workflows.readWorkflow(repo, reservation.workflow.id);
            if (action === "rebind") {
              latest = workflows.rebindWorkflowOwner(repo, current.id, {
                revision: current.revision,
                epoch: current.epoch,
                currentOwnerSessionId: "owner-b",
              });
              return;
            }
            const cancellation = workflows.reserveWorkflowCancellation(repo, current.id, {
              revision: current.revision,
              epoch: current.epoch,
            });
            latest = action === "session-end"
              ? workflows.completeWorkflowSessionEnd(repo, current.id, {
                  revision: cancellation.workflow.revision,
                  epoch: cancellation.workflow.epoch,
                  lease: cancellation.lease,
                  cancelFailedTargets: [],
                })
              : workflows.completeWorkflowCancellation(repo, current.id, {
                  revision: cancellation.workflow.revision,
                  epoch: cancellation.workflow.epoch,
                  lease: cancellation.lease,
                  failedJobIds: [],
                });
          },
        }
      );

      await assert.rejects(waiting, (error) => hasErrorCode(error, "STALE_EPOCH"));
      assert.equal(latest.epoch, reservation.workflow.epoch + 1);
      assert.equal(Object.hasOwn(latest.branches.codex, "attemptReservation"), false);
      assert.equal(errorCode(() => workflows.activateWorkflowAttempt(repo, latest.id, {
        revision: latest.revision,
        epoch: reservation.workflow.epoch,
        stage: "memo",
        branchId: "codex",
        lease: oldLease,
      })), "STALE_EPOCH");
    }
  });

  it("preserves only a committed Claude waiter with an active linked job", () => {
    const repo = createRepo();
    const { reservation, workflow: committed } = committedClaude(repo, "workflow-active-waiter");
    const codexLease = reservation.leases["branch:codex"];
    const running = activate(repo, committed, "memo", "codex", codexLease);
    const claudeBefore = structuredClone(running.branches.claude);

    const reconciled = workflows.reconcilePeerRetry(repo, running.id, {
      revision: running.revision,
      epoch: running.epoch,
    }, [{
      id: "active-claude-job",
      workflowId: running.id,
      workflowStage: "memo",
      status: "running",
    }]);

    assert.equal(reconciled.workflow.branches.codex.status, "retryable_failed");
    assert.equal(reconciled.workflow.branches.codex.failureReason, "EXPLICIT_RETRY");
    assert.deepEqual(reconciled.workflow.branches.claude, claudeBefore);
    assert.deepEqual(reconciled.retryTargets, [
      { stage: "memo", branchId: "codex" },
      { stage: "checkpoint" },
    ]);
  });

  it("retries a committed Claude branch whose linked job is terminal, reaped, or missing", () => {
    /** @type {Array<[string, Array<Record<string, unknown>>]>} */
    const cases = [
      ["terminal", [{ status: "completed" }]],
      ["reaped", [{ status: "failed", reapedBy: "status-reaper" }]],
      ["missing", []],
    ];
    for (const [name, jobs] of cases) {
      const repo = createRepo();
      const { workflow } = committedClaude(repo, `workflow-${name}-waiter`);
      const linkedJobs = jobs.map((job, index) => ({
        id: `${name}-${index}`,
        workflowId: workflow.id,
        workflowStage: "memo",
        ...job,
      }));

      const reconciled = workflows.reconcilePeerRetry(repo, workflow.id, {
        revision: workflow.revision,
        epoch: workflow.epoch,
      }, linkedJobs);

      assert.equal(reconciled.workflow.branches.claude.status, "retryable_failed", name);
      assert.equal(reconciled.workflow.branches.claude.commitment, undefined, name);
      assert.equal(reconciled.workflow.branches.claude.attemptReservation, undefined, name);
      assert.deepEqual(reconciled.retryTargets, [
        { stage: "memo", branchId: "codex" },
        { stage: "memo", branchId: "claude" },
        { stage: "checkpoint" },
      ], name);
    }
  });

  it("does not mistake an older active job for the current committed Claude waiter", () => {
    const repo = createRepo();
    const { workflow } = committedClaude(repo, "workflow-stale-active-job");

    const reconciled = workflows.reconcilePeerRetry(repo, workflow.id, {
      revision: workflow.revision,
      epoch: workflow.epoch,
    }, [
      {
        id: "older-active-job",
        workflowId: workflow.id,
        workflowStage: "memo",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "current-terminal-job",
        workflowId: workflow.id,
        workflowStage: "memo",
        status: "failed",
        createdAt: "2026-01-01T00:01:00.000Z",
      },
    ]);

    assert.equal(reconciled.workflow.branches.claude.status, "retryable_failed");
    assert.ok(reconciled.retryTargets.some(({ branchId }) => branchId === "claude"));
  });

  it("terminalizes the current linked cancel_failed job from every retryable Claude state", () => {
    for (const initialStatus of ["pending", "retryable_failed"]) {
      const repo = createRepo();
      const reservation = createPeer(repo, `workflow-current-cancel-failed-${initialStatus}`);
      let workflow = reservation.workflow;
      if (initialStatus === "retryable_failed") {
        const lease = reservation.leases["branch:claude"];
        workflow = activate(repo, workflow, "memo", "claude", lease);
        workflow = workflows.markWorkflowBranchFailure(repo, workflow.id, {
          revision: workflow.revision,
          epoch: workflow.epoch,
          stage: "memo",
          branchId: "claude",
          lease,
          reason: "CLAUDE_WORKER_FAILED",
        });
      }

      const reconciled = workflows.reconcilePeerRetry(repo, workflow.id, {
        revision: workflow.revision,
        epoch: workflow.epoch,
      }, [
        {
          id: `older-active-${initialStatus}`,
          workflowId: workflow.id,
          workflowStage: "memo",
          status: "running",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: `current-cancel-failed-${initialStatus}`,
          workflowId: workflow.id,
          workflowStage: "memo",
          status: "cancel_failed",
          createdAt: "2026-01-01T00:01:00.000Z",
        },
      ]);
      const context = workflows.getWorkflowRetryContext(repo, workflow.id);

      assert.equal(reconciled.workflow.status, "cancel_failed", initialStatus);
      assert.equal(reconciled.workflow.branches.claude.status, "cancel_failed", initialStatus);
      assert.equal(reconciled.workflow.branches.claude.failureReason, "CANCEL_FAILED", initialStatus);
      assert.equal(
        Object.hasOwn(reconciled.workflow.branches.claude, "attemptReservation"),
        false,
        initialStatus
      );
      assert.deepEqual(reconciled.retryTargets, [], initialStatus);
      assert.equal(context.hasRetryWork, false, initialStatus);
    }
  });

  it("keeps cancel_failed terminal and exposes no retry targets", () => {
    const repo = createRepo();
    const reservation = createPeer(repo, "workflow-cancel-failed-terminal");
    const cancellation = workflows.reserveWorkflowCancellation(repo, reservation.workflow.id, {
      revision: reservation.workflow.revision,
      epoch: reservation.workflow.epoch,
    });
    const cancelled = workflows.completeWorkflowCancellation(repo, reservation.workflow.id, {
      revision: cancellation.workflow.revision,
      epoch: cancellation.workflow.epoch,
      lease: cancellation.lease,
      failedJobIds: ["linked-cancel-failed"],
    });

    const reconciled = workflows.reconcilePeerRetry(repo, cancelled.id, {
      revision: cancelled.revision,
      epoch: cancelled.epoch,
    }, [{
      id: "linked-cancel-failed",
      workflowId: cancelled.id,
      workflowStage: "memo",
      status: "cancel_failed",
    }]);
    const context = workflows.getWorkflowRetryContext(repo, cancelled.id);

    assert.equal(cancelled.status, "cancel_failed");
    assert.deepEqual(reconciled.retryTargets, []);
    assert.equal(context.hasRetryWork, false);
    assert.deepEqual(context.branches, []);
    assert.deepEqual(context.stages, []);
  });
});
