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
import { afterEach, test } from "node:test";
import * as workflows from "../scripts/lib/workflows.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup(policy = "auto") {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cc-continuation-")));
  roots.push(cwd);
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.test"], ["config", "user.name", "Test"], ["commit", "--allow-empty", "-qm", "base"]]) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr);
  }
  const binding = { parentThreadId: "parent-thread", socketPath: path.join(cwd, "server.sock"), socketDev: 1, socketIno: 2 };
  const workflow = workflows.reserveWorkflow(cwd, { mode: "research", brief: "Check continuation", originSessionId: "parent-owner",
    branches: [], stages: ["checkpoint", "feedback", "critique", "synthesis"],
    ...(policy ? { continuation: { policy, binding } } : {}) });
  return { cwd, workflow, binding };
}
function checkpoint(cwd, workflow) {
  return workflows.submitWorkflowStage(cwd, workflow.id, { revision: workflow.revision, epoch: workflow.epoch,
    stage: "checkpoint", oneShot: true, payload: { agreements: ["checked"] }, field: "checkpoint", status: "awaiting_user", phase: "checkpoint" });
}

test("research freezes auto binding and persists a checkpoint event with the stage", () => {
  const { cwd, workflow, binding } = setup();
  assert.equal(workflow.continuation?.policy, "auto");
  const ready = checkpoint(cwd, workflow);
  const event = ready.continuation.events.checkpoint;
  assert.equal(event.epoch, 0);
  assert.equal(event.parentThreadId, "parent-thread");
  assert.equal(event.ownerSessionId, "parent-owner");
  assert.equal(event.delivery, "pending");
  assert.equal(event.consumedAt, null);
  assert.deepEqual(ready.continuation.binding, { ...binding, ownerSessionId: "parent-owner" });
  assert.equal(workflows.readWorkflow(cwd, workflow.id).continuation.events.checkpoint.id, event.id);
});

test("old and manual workflows do not create automatic continuation events", () => {
  for (const policy of [null, "manual"]) {
    const { cwd, workflow } = setup(policy);
    const done = checkpoint(cwd, workflow);
    assert.equal(done.continuation?.events?.checkpoint, undefined);
  }
});

test("one delivery claim wins and late ACK cannot undo parent consumption", () => {
  const { cwd, workflow } = setup();
  let current = checkpoint(cwd, workflow);
  const eventId = current.continuation?.events.checkpoint.id;
  assert.ok(eventId, "checkpoint must durably reserve its event");
  const sending = workflows.claimWorkflowContinuation(cwd, workflow.id, { epoch: 0, eventId });
  assert.equal(sending.continuation.events.checkpoint.delivery, "sending");
  assert.throws(() => workflows.claimWorkflowContinuation(cwd, workflow.id, { epoch: 0, eventId }), /CONTINUATION_ALREADY_SENT/);
  current = workflows.consumeWorkflowContinuation(cwd, workflow.id, { epoch: 0, eventId, parentThreadId: "parent-thread", ownerSessionId: "parent-owner" });
  assert.ok(current.continuation.events.checkpoint.consumedAt);
  const queued = workflows.recordWorkflowContinuationDelivery(cwd, workflow.id, { epoch: 0, eventId, delivery: "queued", queueId: "queue-1" });
  assert.ok(queued.continuation.events.checkpoint.consumedAt);
  assert.equal(queued.continuation.events.checkpoint.queueId, "queue-1");
  assert.throws(() => workflows.consumeWorkflowContinuation(cwd, workflow.id, { epoch: 0, eventId, parentThreadId: "parent-thread", ownerSessionId: "parent-owner" }), /CONTINUATION_ALREADY_CONSUMED/);
});

test("cancel, rebind and wrong parent cannot consume a continuation", () => {
  const { cwd, workflow } = setup();
  const current = checkpoint(cwd, workflow);
  const eventId = current.continuation?.events.checkpoint.id;
  assert.ok(eventId);
  assert.throws(() => workflows.consumeWorkflowContinuation(cwd, workflow.id, { epoch: 0, eventId, parentThreadId: "other", ownerSessionId: "parent-owner" }), /CONTINUATION_OWNER_MISMATCH/);
  const rebound = workflows.rebindWorkflowOwner(cwd, workflow.id, { revision: current.revision, epoch: 0, mode: "research", currentOwnerSessionId: "other-owner" });
  assert.equal(rebound.continuation.state, "unavailable");
  assert.throws(() => workflows.consumeWorkflowContinuation(cwd, workflow.id, { epoch: 0, eventId, parentThreadId: "parent-thread", ownerSessionId: "parent-owner" }), /STALE_EPOCH/);
  const other = setup();
  const pending = checkpoint(other.cwd, other.workflow);
  const cancelled = workflows.reserveWorkflowCancellation(other.cwd, pending.id, { revision: pending.revision, epoch: pending.epoch, mode: "research" }).workflow;
  assert.throws(() => workflows.consumeWorkflowContinuation(other.cwd, pending.id, { epoch: 0, eventId: pending.continuation.events.checkpoint.id, parentThreadId: "parent-thread", ownerSessionId: "parent-owner" }), /STALE_EPOCH|CONTINUATION_NOT_READY/);
  assert.equal(cancelled.continuation.state, "unavailable");
  assert.equal(cancelled.continuation.reason, "cancel_requested");
});

test("SessionEnd disables even a completed workflow's unconsumed final event only for its owner", () => {
  const { cwd, workflow } = setup();
  let current = checkpoint(cwd, workflow);
  current = workflows.submitWorkflowStage(cwd, workflow.id, { revision: current.revision, epoch: 0,
    stage: "critique", oneShot: true, payload: { critique: "checked" }, field: "critique", status: "running" });
  current = workflows.submitWorkflowStage(cwd, workflow.id, { revision: current.revision, epoch: 0,
    stage: "synthesis", oneShot: true, payload: { findings: ["frozen"] }, field: "finalResult", status: "completed" });
  const finalEvent = current.continuation.events.completed.id;
  for (const sessionId of ["other-owner", "parent-owner"]) {
    const hook = spawnSync(process.execPath, [new URL("../hooks/session-lifecycle-hook.mjs", import.meta.url).pathname, "SessionEnd"], {
      cwd, env: process.env, input: JSON.stringify({ cwd, session_id: sessionId }), encoding: "utf8", timeout: 10000,
    });
    assert.equal(hook.status, 0, hook.stderr);
    const stored = workflows.readWorkflow(cwd, workflow.id);
    assert.equal(stored.continuation.state, sessionId === "parent-owner" ? "unavailable" : "ready");
    assert.deepEqual(stored.finalResult, { findings: ["frozen"] });
  }
  assert.throws(() => workflows.consumeWorkflowContinuation(cwd, workflow.id, { epoch: 0, eventId: finalEvent, parentThreadId: "parent-thread", ownerSessionId: "parent-owner" }), /CONTINUATION_NOT_READY/);
});


test("trusted dispatcher binds only the requested parent and cannot revive ended research", () => {
  const { cwd } = setup();
  const pending = workflows.reserveWorkflow(cwd, { mode: "research", brief: "Pending dispatcher", originSessionId: "owner",
    branches: [], stages: ["checkpoint"], continuation: { policy: "auto", requestedParentThreadId: "parent-thread", reason: "dispatcher_unqualified" } });
  assert.equal(pending.continuation.requestedParentThreadId, "parent-thread");
  const binding = { parentThreadId: "parent-thread", socketPath: path.join(cwd, "server.sock"), socketDev: 1, socketIno: 2 };
  assert.throws(() => workflows.bindWorkflowContinuation(cwd, pending.id, { revision: pending.revision, epoch: 0, binding: { ...binding, parentThreadId: "other" } }), /CONTINUATION_OWNER_MISMATCH/);
  const ready = workflows.bindWorkflowContinuation(cwd, pending.id, { revision: pending.revision, epoch: 0, binding });
  assert.equal(ready.continuation.state, "ready");
  const ended = workflows.endWorkflowContinuation(cwd, ready.id, { revision: ready.revision, epoch: 0, ownerSessionId: "owner" });
  assert.throws(() => workflows.bindWorkflowContinuation(cwd, ready.id, { revision: ended.revision, epoch: 0, binding }), /CONTINUATION_NOT_READY/);
});


test("SessionEnd also prevents later qualification of a pending dispatcher", () => {
  const { cwd } = setup();
  const pending = workflows.reserveWorkflow(cwd, { mode: "research", brief: "Pending hook", originSessionId: "owner",
    branches: [], stages: ["checkpoint"], continuation: { policy: "auto", reason: "dispatcher_unqualified", requestedParentThreadId: "parent-thread" } });
  const hook = spawnSync(process.execPath, [new URL("../hooks/session-lifecycle-hook.mjs", import.meta.url).pathname, "SessionEnd"], {
    cwd, env: process.env, input: JSON.stringify({ cwd, session_id: "owner" }), encoding: "utf8", timeout: 10000,
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(workflows.readWorkflow(cwd, pending.id).continuation.reason, "session_ended");
});


test("stored continuation rejects malformed control identifiers and receipts before IPC", () => {
  const { cwd, workflow } = setup();
  const ready = checkpoint(cwd, workflow);
  const file = path.join(workflows.resolveWorkflowsDir(cwd), ready.id + ".json");
  const original = fs.readFileSync(file, "utf8");
  const cases = [
    c => { c.events.checkpoint.id = "wake-safe\nUNTRUSTED_STATE_TEXT"; },
    c => { c.events.checkpoint.epoch = "0"; },
    c => { c.events.checkpoint.milestone = "completed"; },
    c => { c.events.checkpoint.parentThreadId = "foreign-parent"; },
    c => { c.events.checkpoint.ownerSessionId = "foreign-owner"; },
    c => { c.events.checkpoint.delivery = "anything"; },
    c => { c.events.checkpoint.delivery = "queued"; c.events.checkpoint.queueId = null; },
    c => { c.events.checkpoint.queueId = "queue\nINJECT"; },
    c => { c.events.checkpoint.consumedAt = {}; },
    c => { c.binding.socketDev = null; },
    c => { c.binding.socketPath = "/tmp/socket\nINJECT"; },
    c => { c.binding = null; },
    c => { c.state = "anything"; },
    c => { c.events.extra = c.events.checkpoint; },
  ];
  for (const mutate of cases) {
    const data = JSON.parse(original); mutate(data.continuation);
    fs.writeFileSync(file, JSON.stringify(data));
    assert.throws(() => workflows.readWorkflow(cwd, ready.id), undefined, mutate.toString());
  }
  fs.writeFileSync(file, original);
  assert.equal(workflows.readWorkflow(cwd, ready.id).continuation.events.checkpoint.id, ready.continuation.events.checkpoint.id);
});


test("native SessionEnd fences completed and unqualified research with a separate owner label", () => {
  for (const pending of [false, true]) {
    const { cwd } = setup();
    let workflow = workflows.reserveWorkflow(cwd, { mode: "research", brief: "Native identity", originSessionId: "label-owner", branches: [], stages: ["checkpoint", "synthesis"],
      continuation: pending ? { policy: "auto", reason: "dispatcher_unqualified", requestedParentThreadId: "native-parent" }
        : { policy: "auto", binding: { parentThreadId: "native-parent", socketPath: path.join(cwd, "server.sock"), socketDev: 1, socketIno: 2 } } });
    if (!pending) workflow = workflows.submitWorkflowStage(cwd, workflow.id, { revision: workflow.revision, epoch: 0,
      stage: "synthesis", oneShot: true, payload: { findings: ["frozen"] }, field: "finalResult", status: "completed" });
    const hook = spawnSync(process.execPath, [new URL("../hooks/session-lifecycle-hook.mjs", import.meta.url).pathname, "SessionEnd"], {
      cwd, env: process.env, input: JSON.stringify({ cwd, session_id: "native-parent" }), encoding: "utf8", timeout: 10000,
    });
    assert.equal(hook.status, 0, hook.stderr);
    const ended = workflows.readWorkflow(cwd, workflow.id);
    assert.equal(ended.continuation.reason, "session_ended");
    assert.equal(ended.continuation.state, "unavailable");
    assert.deepEqual(ended.finalResult, workflow.finalResult);
  }
});


test("a durable native pause fences old events before per-workflow cleanup", () => {
  const { cwd, workflow } = setup();
  const ready = checkpoint(cwd, workflow);
  workflows.recordWorkflowContinuationPause(cwd, "parent-thread", "user_interrupted");
  const eventId = ready.continuation.events.checkpoint.id;
  assert.throws(() => workflows.claimWorkflowContinuation(cwd, ready.id, { epoch: 0, eventId }), /CONTINUATION_NOT_READY/);
  assert.throws(() => workflows.consumeWorkflowContinuation(cwd, ready.id, { epoch: 0, eventId, parentThreadId: "parent-thread", ownerSessionId: "parent-owner" }), /CONTINUATION_NOT_READY/);
  const newer = workflows.reserveWorkflow(cwd, { mode: "research", brief: "New explicitly launched research", originSessionId: "parent-owner", branches: [], stages: ["checkpoint"],
    continuation: { policy: "auto", binding: ready.continuation.binding } });
  const next = checkpoint(cwd, newer);
  assert.equal(next.continuation.state, "ready");
});


test("a missing delivery workflow stays unavailable without native IPC", async () => {
  const { cwd, binding } = setup();
  const { deliverResearchContinuation } = await import("../scripts/lib/research-continuation.mjs");
  assert.deepEqual(await deliverResearchContinuation({ cwd, workflowId: "missing-workflow", expectedBinding: binding }), { delivery: "unavailable" });
});
