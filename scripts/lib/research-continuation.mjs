/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { connectCodexSharedServer } from "./codex-shared-server.mjs";
import { readWorkflow, claimWorkflowContinuation, recordWorkflowContinuationDelivery, workflowNotificationEvent, listWorkflows, bindWorkflowContinuation, sameContinuationBinding, recordWorkflowContinuationPause, workflowContinuationPauseReason, endWorkflowContinuation } from "./workflows.mjs";
import { resolveCodexHome } from "./codex-paths.mjs";

function sharedEndpoint(serverSocket) {
  if (process.platform === "win32" || typeof globalThis.WebSocket !== "function") throw new Error("Shared runtime is unavailable.");
  const socketPath = fs.realpathSync.native(serverSocket);
  const socket = fs.statSync(socketPath);
  const parent = fs.statSync(path.dirname(socketPath));
  if (!socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o077) !== 0 ||
      parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) throw new Error("Shared socket is not private.");
  return { socketPath, socketDev: socket.dev, socketIno: socket.ino };
}

async function inspectParent(client, cwd, parentThreadId) {
  let cursor = null;
  const seen = new Set();
  let loaded = false;
  for (let page = 0; page < 100; page += 1) {
    const result = await client.request("thread/loaded/list", { ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data)) return "shared_runtime_probe_failed";
    if (result.data.includes(parentThreadId)) { loaded = true; break; }
    cursor = result.nextCursor;
    if (!cursor || seen.has(cursor)) break;
    seen.add(cursor);
  }
  if (!loaded) return "parent_not_loaded";
  const result = await client.request("thread/read", { threadId: parentThreadId, includeTurns: false });
  if (result?.thread?.id !== parentThreadId || fs.realpathSync.native(result.thread.cwd) !== fs.realpathSync.native(cwd)) return "parent_workspace_mismatch";
  await client.request("thread/queue/list", { threadId: parentThreadId, limit: 1 });
  return null;
}

/** Read-only qualification; never resume an unloaded parent or override its context. */
export async function probeResearchContinuation({ cwd, parentThreadId, serverSocket = path.join(resolveCodexHome(), "app-server-control", "app-server-control.sock") }) {
  const unavailable = (reason) => ({ available: false, binding: null, reason });
  if (typeof parentThreadId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(parentThreadId)) return unavailable("parent_not_loaded");
  let endpoint;
  try { endpoint = sharedEndpoint(serverSocket); } catch { return unavailable("shared_runtime_unavailable"); }
  let client;
  try {
    client = await connectCodexSharedServer({ serverSocket: endpoint.socketPath });
    const reason = await inspectParent(client, cwd, parentThreadId);
    if (reason) return unavailable(reason);
    const after = sharedEndpoint(serverSocket);
    if (after.socketDev !== endpoint.socketDev || after.socketIno !== endpoint.socketIno) return unavailable("shared_runtime_changed");
    return { available: true, reason: null, binding: { parentThreadId, ...endpoint } };
  } catch { return unavailable("shared_runtime_probe_failed"); }
  finally { client?.close(); }
}

function continuationMessage(workflowId, event) {
  return `$cc:research --continue ${workflowId} --wake-event ${event.id} --wake-epoch ${event.epoch}\n` +
    "Process this fenced research event. Preserve current user steering, collaboration mode and permissions. Read the complete authorized result. Continue planning only; do not implement changes.";
}

export async function deliverResearchContinuation({ cwd, workflowId, expectedBinding, deadlineMs = Infinity }) {
  if (Date.now() >= deadlineMs) return { delivery: "pending" };
  const workflow = readWorkflow(cwd, workflowId);
  const continuation = workflow?.continuation;
  const event = continuation?.events?.[workflowNotificationEvent(workflow ?? {})];
  if (workflowContinuationPauseReason(workflow) || !sameContinuationBinding(continuation?.binding, expectedBinding) || continuation?.policy !== "auto" || continuation.state !== "ready" || !event) return { delivery: "unavailable" };
  if (event.delivery !== "pending" || event.consumedAt) return { delivery: "already_sent" };
  const fence = { epoch: event.epoch, eventId: event.id, expectedBinding };
  try { claimWorkflowContinuation(cwd, workflowId, fence); }
  catch (error) {
    if (["CONTINUATION_ALREADY_SENT", "CONTINUATION_NOT_READY", "STALE_EPOCH", "CONTINUATION_OWNER_MISMATCH"].includes(error.code)) return { delivery: "already_sent" };
    throw error;
  }
  let client;
  let sent = false;
  try {
    const binding = expectedBinding;
    const endpoint = sharedEndpoint(binding.socketPath);
    if (endpoint.socketDev !== binding.socketDev || endpoint.socketIno !== binding.socketIno) throw new Error("Shared endpoint changed.");
    client = await connectCodexSharedServer({ serverSocket: binding.socketPath, deadlineMs });
    const unavailable = await inspectParent(client, cwd, binding.parentThreadId);
    if (unavailable) throw new Error("Parent no longer belongs to this shared runtime.");
    const latest = readWorkflow(cwd, workflowId);
    if (workflowContinuationPauseReason(latest) || !sameContinuationBinding(latest.continuation?.binding, expectedBinding) ||
        latest.continuation?.events?.[event.milestone]?.id !== event.id || latest.continuation.events[event.milestone].consumedAt ||
        latest.continuation?.state !== "ready" || latest.epoch !== event.epoch || latest.currentOwnerSessionId !== event.ownerSessionId ||
        !["awaiting_user", "running", "completed"].includes(latest.status)) throw new Error("Continuation was invalidated.");
    const text = continuationMessage(workflowId, event);
    sent = true;
    const receipt = await client.request("thread/queue/add", { threadId: binding.parentThreadId,
      input: [{ type: "text", text }], clientUserMessageId: event.id });
    const queueId = receipt?.queuedSubmission?.id;
    if (typeof queueId !== "string" || !queueId) throw new Error("Native queue receipt is missing.");
    recordWorkflowContinuationDelivery(cwd, workflowId, { ...fence, delivery: "queued", queueId });
    return { delivery: "queued", queueId };
  } catch (error) {
    const delivery = sent && error.rpcCode == null ? "unknown" : "unavailable";
    try { recordWorkflowContinuationDelivery(cwd, workflowId, { ...fence, delivery }); }
    catch (recordError) {
      if (!["CONTINUATION_NOT_READY", "STALE_EPOCH", "CONTINUATION_ALREADY_SENT", "CONTINUATION_OWNER_MISMATCH"].includes(recordError.code)) throw recordError;
    }
    return { delivery };
  } finally { client?.close(); }
}


async function hasTrustedPauseHook(client, cwd) {
  const result = await client.request("hooks/list", { cwds: [cwd] });
  const hooks = (result?.data ?? []).flatMap((entry) => entry.hooks ?? []);
  const ownScript = fileURLToPath(new URL("../../hooks/research-continuation-hook.mjs", import.meta.url));
  const ownConfig = process.env.PLUGIN_ROOT ? path.join(process.env.PLUGIN_ROOT, "hooks", "hooks.json") : null;
  const post = hooks.find((hook) => hook.eventName === "postToolUse" && hook.handlerType === "command" &&
    hook.enabled && hook.trustStatus === "trusted" && !hook.async &&
    (hook.sourcePath === ownConfig || hook.command.includes(ownScript)));
  return Boolean(post && hooks.some((hook) => hook.eventName === "interrupt" && hook.handlerType === "command" &&
    hook.sourcePath === post.sourcePath && hook.command === post.command && hook.enabled && hook.trustStatus === "trusted" && !hook.async));
}

/** Trusted hook only: derive the endpoint locally and authorize the caller through native ancestry. */
export async function dispatchResearchContinuations({ cwd, sessionId }) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) return [];
  const endpoint = sharedEndpoint(path.join(resolveCodexHome(), "app-server-control", "app-server-control.sock"));
  const deadlineMs = Date.now() + 4500;
  const client = await connectCodexSharedServer({ serverSocket: endpoint.socketPath, timeoutMs: 1000, deadlineMs });
  const receipts = [];
  try {
    if (!await hasTrustedPauseHook(client, cwd)) return [];
    const ancestors = new Set();
    let threadId = sessionId;
    for (let depth = 0; threadId && depth < 16 && !ancestors.has(threadId); depth += 1) {
      const result = await client.request("thread/read", { threadId, includeTurns: false });
      if (result?.thread?.id !== threadId || fs.realpathSync.native(result.thread.cwd) !== fs.realpathSync.native(cwd)) return [];
      ancestors.add(threadId);
      threadId = result.thread.parentThreadId;
    }
    for (const listed of listWorkflows(cwd).slice(0, 100)) {
      if (Date.now() >= deadlineMs) break;
      let workflow = listed;
      const continuation = workflow.continuation;
      if (continuation?.policy !== "auto") continue;
      if (continuation.reason === "dispatcher_unqualified" && continuation.requestedParentThreadId === sessionId) {
        if (await inspectParent(client, cwd, sessionId)) continue;
        workflow = bindWorkflowContinuation(cwd, workflow.id, { revision: workflow.revision, epoch: workflow.epoch,
          binding: { parentThreadId: sessionId, ...endpoint } });
        receipts.push({ workflowId: workflow.id, state: "ready" });
      }
      const binding = workflow.continuation.binding;
      if (workflow.continuation.state !== "ready" || !ancestors.has(binding?.parentThreadId) ||
          binding.socketPath !== endpoint.socketPath || binding.socketDev !== endpoint.socketDev || binding.socketIno !== endpoint.socketIno) continue;
      const event = workflow.continuation.events[workflowNotificationEvent(workflow)];
      if (!event || event.delivery !== "pending" || event.consumedAt) continue;
      receipts.push({ workflowId: workflow.id, ...await deliverResearchContinuation({ cwd, workflowId: workflow.id, expectedBinding: { ...binding }, deadlineMs }) });
      if (receipts.length >= 4) break;
    }
    return receipts;
  } finally { client.close(); }
}


/** Persist the stop before cleanup so late callbacks cannot recreate an older wake. */
export async function pauseResearchContinuations({ cwd, sessionId }) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) return;
  recordWorkflowContinuationPause(cwd, sessionId, "user_interrupted");
  const deadlineMs = Date.now() + 2100;
  const lockDeadline = performance.now() + 2100;
  const owned = listWorkflows(cwd).filter((workflow) =>
    (workflow.continuation?.binding?.parentThreadId ?? workflow.continuation?.requestedParentThreadId) === sessionId);
  for (const workflow of owned) {
    if (Date.now() >= deadlineMs) break;
    try { endWorkflowContinuation(cwd, workflow.id, { revision: workflow.revision, epoch: workflow.epoch,
      parentThreadId: sessionId, reason: "user_interrupted", deadlineAt: lockDeadline }); }
    catch { /* The parent fence remains authoritative if per-workflow cleanup races. */ }
  }
  let client;
  try {
    const endpoint = sharedEndpoint(path.join(resolveCodexHome(), "app-server-control", "app-server-control.sock"));
    client = await connectCodexSharedServer({ serverSocket: endpoint.socketPath, timeoutMs: 500, deadlineMs });
    if (await inspectParent(client, cwd, sessionId)) return;
    const expected = new Map();
    for (const workflow of owned) {
      const binding = workflow.continuation?.binding;
      if (binding?.socketPath !== endpoint.socketPath || binding.socketDev !== endpoint.socketDev || binding.socketIno !== endpoint.socketIno) continue;
      for (const event of Object.values(workflow.continuation.events)) expected.set(event.id, continuationMessage(workflow.id, event));
    }
    let cursor;
    do {
      const result = await client.request("thread/queue/list", { threadId: sessionId, ...(cursor ? { cursor } : {}) });
      for (const item of result?.data ?? []) {
        if (expected.get(item.clientUserMessageId) && item.input?.length === 1 && item.input[0].type === "text" &&
            item.input[0].text === expected.get(item.clientUserMessageId)) {
          await client.request("thread/queue/delete", { threadId: sessionId, queuedSubmissionId: item.id });
        }
      }
      cursor = result.nextCursor;
    } while (cursor && Date.now() < deadlineMs);
  } finally { client?.close(); }
}
