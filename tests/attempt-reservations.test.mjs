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

import * as workflows from "../scripts/lib/workflows.mjs";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ACTIVATE_FIXTURE = path.join(PROJECT_ROOT, "tests", "fixtures", "activate-workflow-attempt.mjs");
const tempDirs = [];

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function createRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cc-attempt-reservation-"));
  tempDirs.push(repo);
  runGit(repo, ["init", "--initial-branch=main"]);
  runGit(repo, ["config", "user.name", "Codex Test"]);
  runGit(repo, ["config", "user.email", "codex@example.com"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n", "utf8");
  runGit(repo, ["add", "tracked.txt"]);
  runGit(repo, ["commit", "-m", "initial"]);
  return repo;
}

function createPeerWorkflow(repo, id) {
  return workflows.reserveWorkflow(repo, {
    id,
    mode: "design",
    brief: "Compare the smallest safe designs.",
    originSessionId: "owner-a",
    stages: ["checkpoint", "critique", "synthesis"],
    branches: ["codex", "claude"],
  });
}

function api(name) {
  assert.equal(typeof workflows[name], "function", `${name} must be exported`);
  return workflows[name];
}

function errorCode(fn) {
  try {
    fn();
  } catch (error) {
    return error?.code;
  }
  return null;
}

function activateInChild(repo, workflow, lease) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      ACTIVATE_FIXTURE,
      repo,
      workflow.id,
      String(workflow.revision),
      String(workflow.epoch),
    ], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ lease }));
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("workflow attempt reservations", () => {
  it("reserves several targets atomically without advancing attempts or persisting raw leases", () => {
    const repo = createRepo();
    const created = createPeerWorkflow(repo, "workflow-reserve-attempts");
    const reservation = api("reserveWorkflowAttempts")(repo, created.id, {
      revision: created.revision,
      epoch: created.epoch,
    }, [
      { stage: "memo", branchId: "codex" },
      { stage: "memo", branchId: "claude" },
      { stage: "checkpoint" },
    ]);

    assert.deepEqual(Object.keys(reservation.leases).sort(), [
      "branch:claude", "branch:codex", "stage:checkpoint",
    ]);
    for (const lease of Object.values(reservation.leases)) {
      assert.match(lease, /^[a-f0-9]{64}$/u);
      assert.doesNotMatch(
        fs.readFileSync(workflows.resolveWorkflowFile(repo, created.id), "utf8"),
        new RegExp(lease)
      );
    }
    assert.equal(reservation.workflow.branches.codex.status, "pending");
    assert.equal(reservation.workflow.branches.codex.attempts, 0);
    assert.deepEqual(reservation.workflow.branchAttempts, []);
    assert.deepEqual(Object.keys(reservation.workflow.branches.codex.attemptReservation).sort(), [
      "epoch", "leaseDigest", "previousFailureDetail", "reservedAt",
    ]);
    assert.equal(reservation.workflow.branches.codex.attemptReservation.previousFailureDetail, null);
  });

  it("allows only one concurrent activation and increments attempt history once", async () => {
    const repo = createRepo();
    const created = createPeerWorkflow(repo, "workflow-concurrent-activation");
    const reservation = api("reserveWorkflowAttempts")(repo, created.id, {
      revision: created.revision,
      epoch: created.epoch,
    }, [{ stage: "memo", branchId: "codex" }]);
    const lease = reservation.leases["branch:codex"];

    const results = await Promise.all([
      activateInChild(repo, reservation.workflow, lease),
      activateInChild(repo, reservation.workflow, lease),
    ]);

    assert.equal(results.filter(({ code }) => code === 0).length, 1, JSON.stringify(results));
    const stored = workflows.readWorkflow(repo, created.id);
    assert.equal(stored.branches.codex.status, "running");
    assert.equal(stored.branches.codex.attempts, 1);
    assert.equal(stored.branchAttempts.filter(({ event }) => event === "started").length, 1);
  });

  it("rejects lost and rotated reservations without mutating stored bytes", () => {
    const repo = createRepo();
    const created = createPeerWorkflow(repo, "workflow-stale-reservation");
    const activate = api("activateWorkflowAttempt");
    assert.equal(errorCode(() => activate(repo, created.id, {
      revision: created.revision,
      epoch: created.epoch,
      stage: "memo",
      branchId: "codex",
      lease: "a".repeat(64),
    })), "STALE_ATTEMPT");

    const first = api("reserveWorkflowAttempts")(repo, created.id, {
      revision: created.revision,
      epoch: created.epoch,
    }, [{ stage: "memo", branchId: "codex" }]);
    const retry = api("reconcilePeerRetry")(
      repo,
      created.id,
      { revision: first.workflow.revision, epoch: first.workflow.epoch },
      []
    );
    const second = api("reserveWorkflowAttempts")(repo, created.id, {
      revision: retry.workflow.revision,
      epoch: retry.workflow.epoch,
    }, retry.retryTargets);
    const before = fs.readFileSync(workflows.resolveWorkflowFile(repo, created.id));

    assert.equal(errorCode(() => activate(repo, created.id, {
      revision: second.workflow.revision,
      epoch: second.workflow.epoch,
      stage: "memo",
      branchId: "codex",
      lease: first.leases["branch:codex"],
    })), "STALE_ATTEMPT");
    assert.deepEqual(fs.readFileSync(workflows.resolveWorkflowFile(repo, created.id)), before);
  });

  it("rotates only unfinished retry targets and fences the downstream checkpoint", () => {
    const repo = createRepo();
    const created = createPeerWorkflow(repo, "workflow-retry-targets");
    const reserve = api("reserveWorkflowAttempts");
    const activate = api("activateWorkflowAttempt");
    let reservation = reserve(repo, created.id, {
      revision: created.revision,
      epoch: created.epoch,
    }, [
      { stage: "memo", branchId: "codex" },
      { stage: "memo", branchId: "claude" },
      { stage: "checkpoint" },
    ]);
    const codexLease = reservation.leases["branch:codex"];
    const oldCheckpointLease = reservation.leases["stage:checkpoint"];
    let workflow = activate(repo, created.id, {
      revision: reservation.workflow.revision,
      epoch: reservation.workflow.epoch,
      stage: "memo",
      branchId: "codex",
      lease: codexLease,
    });
    workflow = workflows.submitWorkflowStage(repo, created.id, {
      revision: workflow.revision,
      epoch: workflow.epoch,
      stage: "memo",
      branchId: "codex",
      lease: codexLease,
      payload: { frozen: "codex bytes" },
    });
    const completedBytes = JSON.stringify(workflow.branches.codex);
    const retry = api("reconcilePeerRetry")(
      repo,
      created.id,
      { revision: workflow.revision, epoch: workflow.epoch },
      []
    );
    assert.deepEqual(retry.retryTargets, [
      { stage: "memo", branchId: "claude" },
      { stage: "checkpoint" },
    ]);
    reservation = reserve(repo, created.id, {
      revision: retry.workflow.revision,
      epoch: retry.workflow.epoch,
    }, retry.retryTargets);
    assert.equal(JSON.stringify(reservation.workflow.branches.codex), completedBytes);
    assert.equal(errorCode(() => activate(repo, created.id, {
      revision: reservation.workflow.revision,
      epoch: reservation.workflow.epoch,
      stage: "checkpoint",
      lease: oldCheckpointLease,
    })), "STALE_ATTEMPT");
  });
});
