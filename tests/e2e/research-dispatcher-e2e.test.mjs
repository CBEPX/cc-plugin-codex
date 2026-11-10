/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import "../test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createEnvironment } from "../fixtures/peer-environment.mjs";
import { startNativeRuntime } from "../fixtures/native-runtime.mjs";
import { probeResearchContinuation, dispatchResearchContinuations } from "../../scripts/lib/research-continuation.mjs";
import { reserveWorkflow, submitWorkflowStage, readWorkflow, reserveWorkflowCancellation, consumeWorkflowContinuation, resolveWorkflowsDir } from "../../scripts/lib/workflows.mjs";

const available = process.platform !== "win32" && typeof globalThis.WebSocket === "function" && spawnSync("codex", ["--version"]).status === 0;

test("trusted dispatcher rejects foreign threads and endpoints, ignores output commands and sends one fenced wake", { skip: !available, timeout: 45000 }, async () => {
  const testEnv = createEnvironment();
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = testEnv.env.CODEX_HOME;
  let runtime;
  try {
    runtime = await startNativeRuntime({ workspace: testEnv.workspaceDir, home: testEnv.env.CODEX_HOME, env: testEnv.env,
      hookCommand: `node '${new URL("../../hooks/research-continuation-hook.mjs", import.meta.url).pathname}'`,
      onRequest: async () => [{ type: "message", role: "assistant", id: "fixture-message", content: [{ type: "output_text", text: "DONE" }] }] });
    const start = async (text) => {
      const { thread } = await runtime.request("thread/start", { cwd: testEnv.workspaceDir, model: "mock-model", approvalPolicy: "never", sandbox: "read-only" });
      await runtime.request("turn/start", { threadId: thread.id, input: [{ type: "text", text }] });
      for (let i = 0; i < 500; i += 1) {
        if (runtime.notifications.some((e) => e.method === "turn/completed" && e.params.threadId === thread.id)) return thread.id;
        await delay(10);
      }
      assert.fail("Seed turn did not finish");
    };
    const own = await start("OWN");
    const foreign = await start("FOREIGN");
    const qualified = await probeResearchContinuation({ cwd: testEnv.workspaceDir, parentThreadId: own });
    assert.equal(qualified.available, true);
    const checkpoint = (binding) => {
      const workflow = reserveWorkflow(testEnv.workspaceDir, { mode: "research", brief: "Bounded dispatch", originSessionId: "parent-owner",
        branches: [], stages: ["checkpoint"], continuation: { policy: "auto", binding } });
      return submitWorkflowStage(testEnv.workspaceDir, workflow.id, { revision: workflow.revision, epoch: 0, stage: "checkpoint", oneShot: true,
        field: "checkpoint", payload: { agreements: ["checked"] }, status: "awaiting_user", phase: "checkpoint" });
    };
    const other = checkpoint({ ...qualified.binding, parentThreadId: foreign });
    const redirected = checkpoint({ ...qualified.binding, socketPath: qualified.binding.socketPath + ".redirected" });
    const cancelled = checkpoint(qualified.binding);
    reserveWorkflowCancellation(testEnv.workspaceDir, cancelled.id, { revision: cancelled.revision, epoch: 0, mode: "research" });
    const consumed = checkpoint(qualified.binding);
    consumeWorkflowContinuation(testEnv.workspaceDir, consumed.id, { epoch: 0, eventId: consumed.continuation.events.checkpoint.id,
      parentThreadId: own, ownerSessionId: "parent-owner" });
    const sentinel = path.join(testEnv.rootDir, "must-not-execute");
    const input = { hook_event_name: "PostToolUse", tool_name: "Bash", session_id: own, cwd: testEnv.workspaceDir,
      tool_input: { command: "echo peer-final" }, tool_response: { command: `touch '${sentinel}'`, workflowId: other.id, parentThreadId: foreign } };
    const hook = spawnSync(process.execPath, [new URL("../../hooks/research-continuation-hook.mjs", import.meta.url).pathname], {
      cwd: testEnv.workspaceDir, env: testEnv.env, input: JSON.stringify(input), encoding: "utf8", timeout: 8000,
    });
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(fs.existsSync(sentinel), false);
    assert.equal(readWorkflow(testEnv.workspaceDir, other.id).continuation.events.checkpoint.delivery, "pending");
    assert.equal(readWorkflow(testEnv.workspaceDir, redirected.id).continuation.events.checkpoint.delivery, "pending");
    assert.equal(runtime.requests.length, 2);
    const switched = checkpoint(qualified.binding);
    const workflowFile = path.join(resolveWorkflowsDir(testEnv.workspaceDir), switched.id + ".json");
    const originalRead = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function (file, ...args) {
      if (file === workflowFile && ++reads === 2) {
        const forged = JSON.parse(originalRead(file, "utf8"));
        forged.continuation.binding.parentThreadId = foreign;
        forged.continuation.events.checkpoint.parentThreadId = foreign;
        fs.writeFileSync(file, JSON.stringify(forged));
      }
      return originalRead.call(fs, file, ...args);
    };
    try { await dispatchResearchContinuations({ cwd: testEnv.workspaceDir, sessionId: own }); }
    finally { fs.readFileSync = originalRead; }
    await delay(100);
    assert.ok(reads >= 2, "The checked workflow must be reread at the delivery boundary");
    assert.equal(readWorkflow(testEnv.workspaceDir, switched.id).continuation.events.checkpoint.queueId, null,
      "A binding changed after ancestry qualification must not be queued");
    assert.equal(runtime.requests.length, 2, "The race must not create a turn on the foreign thread");
    const valid = checkpoint(qualified.binding);
    await Promise.all([dispatchResearchContinuations({ cwd: testEnv.workspaceDir, sessionId: own }),
      dispatchResearchContinuations({ cwd: testEnv.workspaceDir, sessionId: own })]);
    const delivered = readWorkflow(testEnv.workspaceDir, valid.id).continuation.events.checkpoint;
    assert.equal(delivered.delivery, "queued");
    assert.ok(delivered.queueId);
    assert.deepEqual(await dispatchResearchContinuations({ cwd: testEnv.workspaceDir, sessionId: own }), []);
    for (let i = 0; i < 500 && runtime.requests.length < 3; i += 1) await delay(10);
    assert.equal(runtime.requests.length, 3, JSON.stringify({ turns: runtime.notifications.filter((e) => e.method === "turn/completed").map(e => ({ threadId:e.params.threadId, turnId:e.params.turn.id })), requests: runtime.requests.slice(2).map(r => ({model:r.model,last:r.input.slice(-2)})) }).slice(-6000));
    assert.equal(readWorkflow(testEnv.workspaceDir, cancelled.id).continuation.events.checkpoint.queueId, null);
    assert.equal(readWorkflow(testEnv.workspaceDir, consumed.id).continuation.events.checkpoint.queueId, null);
    const hooks = await runtime.request("hooks/list", { cwds: [testEnv.workspaceDir] });
    const interrupt = hooks.data[0].hooks.find((hook) => hook.eventName === "interrupt");
    await runtime.request("config/batchWrite", { reloadUserConfig: true, edits: [{
      keyPath: `hooks.state.${JSON.stringify(interrupt.key)}.enabled`, value: false, mergeStrategy: "replace",
    }] });
    const unsupported = checkpoint(qualified.binding);
    await dispatchResearchContinuations({ cwd: testEnv.workspaceDir, sessionId: own });
    assert.equal(readWorkflow(testEnv.workspaceDir, unsupported.id).continuation.events.checkpoint.delivery, "pending",
      "Automatic delivery requires its native Interrupt hook to remain enabled and trusted");
  } finally {
    await runtime?.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(testEnv.rootDir, { recursive: true, force: true });
  }
});


test("native Interrupt fences queued research before a later user turn and preserves unrelated queued input", { skip: !available, timeout: 45000 }, async () => {
  const testEnv = createEnvironment();
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = testEnv.env.CODEX_HOME;
  let runtime;
  /** @type {(value: unknown) => void} */
  let releaseBusy = () => {};
  let busyStarted = false;
  const busy = new Promise((resolve) => { releaseBusy = resolve; });
  const wait = async (check) => {
    for (let i = 0; i < 500; i += 1) { if (check()) return; await delay(10); }
    assert.fail("Native interruption did not reach its expected state");
  };
  try {
    runtime = await startNativeRuntime({ workspace: testEnv.workspaceDir, home: testEnv.env.CODEX_HOME, env: testEnv.env,
      hookCommand: `node '${new URL("../../hooks/research-continuation-hook.mjs", import.meta.url).pathname}'`,
      onRequest: async () => {
        if (!busyStarted) { busyStarted = true; await busy; }
        return [{ type: "message", role: "assistant", id: "fixture-message", content: [{ type: "output_text", text: "DONE" }] }];
      } });
    const { thread } = await runtime.request("thread/start", { cwd: testEnv.workspaceDir, model: "mock-model", approvalPolicy: "never", sandbox: "read-only" });
    const { turn } = await runtime.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "BUSY PARENT" }] });
    await wait(() => busyStarted);
    const qualified = await probeResearchContinuation({ cwd: testEnv.workspaceDir, parentThreadId: thread.id });
    const reserved = reserveWorkflow(testEnv.workspaceDir, { mode: "research", brief: "Interrupt research", originSessionId: "label-owner",
      branches: [], stages: ["checkpoint"], continuation: { policy: "auto", binding: qualified.binding } });
    const ready = submitWorkflowStage(testEnv.workspaceDir, reserved.id, { revision: reserved.revision, epoch: 0, stage: "checkpoint", oneShot: true,
      field: "checkpoint", payload: { agreements: ["checked"] }, status: "awaiting_user", phase: "checkpoint" });
    const eventId = ready.continuation.events.checkpoint.id;
    await dispatchResearchContinuations({ cwd: testEnv.workspaceDir, sessionId: thread.id });
    assert.equal(readWorkflow(testEnv.workspaceDir, ready.id).continuation.events.checkpoint.delivery, "queued");
    await runtime.request("thread/queue/add", { threadId: thread.id, clientUserMessageId: "human-note", input: [{ type: "text", text: "KEEP HUMAN QUEUE NOTE" }] });
    await runtime.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
    releaseBusy(null);
    await wait(() => runtime.notifications.some((event) => event.method === "turn/completed" && event.params.turn.status === "interrupted"));
    await wait(() => readWorkflow(testEnv.workspaceDir, ready.id).continuation.state === "unavailable");
    assert.equal(readWorkflow(testEnv.workspaceDir, ready.id).continuation.reason, "user_interrupted");
    assert.throws(() => consumeWorkflowContinuation(testEnv.workspaceDir, ready.id, { epoch: 0, eventId,
      parentThreadId: thread.id, ownerSessionId: "label-owner" }), /CONTINUATION_NOT_READY/);
    const queue = await runtime.request("thread/queue/list", { threadId: thread.id });
    assert.ok(queue.data.some((item) => item.clientUserMessageId === "human-note"));
    assert.ok(queue.data.every((item) => item.clientUserMessageId !== eventId));
    await runtime.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "UNRELATED NEW REQUEST. Research remains paused." }] });
    await wait(() => runtime.notifications.filter((event) => event.method === "turn/completed").length >= 3);
    assert.ok(runtime.requests.every((request) => !JSON.stringify(request.input).includes(eventId)));
  } finally {
    releaseBusy?.(null);
    await runtime?.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(testEnv.rootDir, { recursive: true, force: true });
  }
});
