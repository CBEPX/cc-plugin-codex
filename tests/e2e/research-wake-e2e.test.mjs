/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { reserveWorkflow, submitWorkflowStage, readWorkflow } from "../../scripts/lib/workflows.mjs";
import { probeResearchContinuation, deliverResearchContinuation } from "../../scripts/lib/research-continuation.mjs";
import { callCodexAppServer } from "../../scripts/lib/codex-app-server.mjs";
import { connectCodexSharedServer } from "../../scripts/lib/codex-shared-server.mjs";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const available = process.platform !== "win32" && typeof globalThis.WebSocket === "function" && spawnSync("codex", ["--version"]).status === 0;

// Characterize the native boundary before relying on queue ACK as parent wake.
test("native queue wakes the same parent after its turn ends and preserves Plan Mode", { skip: !available, timeout: 45000 }, async () => {
  const root = fs.mkdtempSync("/tmp/cc-native-wake-");
  const home = path.join(root, "codex");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(home); fs.mkdirSync(workspace);
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.test"], ["config", "user.name", "Test"], ["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "base"]]) {
    const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
  }
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") { res.writeHead(404); res.end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const id = `response-${requests.length}`;
    const events = [
      { type: "response.created", response: { id } },
      { type: "response.output_item.done", item: { id: `msg-${id}`, type: "message", role: "assistant", content: [{ type: "output_text", text: requests.length === 1 ? "SEED_FINISHED" : "WAKE_CONSUMED" }] } },
      { type: "response.completed", response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", () => resolve(null)));
  const port = /** @type {import('node:net').AddressInfo} */ (provider.address()).port;
  fs.writeFileSync(path.join(home, "config.toml"), `model="mock-model"
model_provider="mock"
approval_policy="never"
sandbox_mode="read-only"
[model_providers.mock]
name="Local test"
base_url="http://127.0.0.1:${port}/v1"
wire_api="responses"
request_max_retries=0
stream_max_retries=0
supports_websockets=false
`);
  const socket = path.join(root, "server.sock");
  const child = spawn("codex", ["app-server", "--listen", `unix://${socket}`], {
    cwd: workspace, env: { ...process.env, CODEX_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.resume();
  let client;
  try {
    for (let i = 0; i < 200 && !fs.existsSync(socket); i += 1) {
      assert.equal(child.exitCode, null, stderr);
      await delay(25);
    }
    assert.ok(fs.existsSync(socket), stderr);
    const notifications = [];
    client = await connectCodexSharedServer({ serverSocket: socket, timeoutMs: 6000,
      onNotification: (event) => notifications.push(event) });
    const rpc = client.request;
    const waitTurns = async (count) => {
      for (let i = 0; i < 500; i += 1) {
        if (notifications.filter((event) => event.method === "turn/completed").length >= count) return;
        await delay(25);
      }
      assert.fail(`Missing turn completion ${count}; stderr=${stderr}; notifications=${JSON.stringify(notifications.slice(-8))}`);
    };
    const started = await rpc("thread/start", { cwd: workspace, model: "mock-model", approvalPolicy: "never", sandbox: "read-only" });
    const threadId = started.thread.id;
    await rpc("turn/start", { threadId, input: [{ type: "text", text: "SEED" }], collaborationMode: { mode: "plan", settings: { model: "mock-model", reasoning_effort: "low", developer_instructions: null } } });
    await waitTurns(1);
    const loaded = await callCodexAppServer({ cwd: workspace, method: "thread/loaded/list", params: {}, serverSocket: socket });
    assert.ok(loaded.data.includes(threadId));
    assert.equal(requests.length, 1);
    const qualified = await probeResearchContinuation({ cwd: workspace, parentThreadId: threadId, serverSocket: socket });
    assert.equal(qualified.available, true, qualified.reason);
    assert.equal(qualified.binding.parentThreadId, threadId);
    let workflow = reserveWorkflow(workspace, { mode: "research", brief: "PRIVATE_BRIEF_NOT_IN_QUEUE", originSessionId: "parent-owner",
      stages: ["checkpoint", "feedback", "critique", "synthesis"], branches: [], continuation: { policy: "auto", binding: qualified.binding } });
    workflow = submitWorkflowStage(workspace, workflow.id, { revision: workflow.revision, epoch: 0, stage: "checkpoint", oneShot: true,
      payload: { agreements: ["checked"] }, field: "checkpoint", status: "awaiting_user", phase: "checkpoint" });
    const eventId = workflow.continuation.events.checkpoint.id;
    const receipt = await deliverResearchContinuation({ cwd: workspace, workflowId: workflow.id, expectedBinding: workflow.continuation.binding });
    assert.equal(receipt.delivery, "queued");
    assert.ok(receipt.queueId);
    await waitTurns(2);
    assert.equal(requests.length, 2);
    const second = JSON.stringify(requests[1]);
    assert.match(second, /\$cc:research --continue/);
    assert.ok(second.includes(eventId));
    assert.doesNotMatch(second, /PRIVATE_BRIEF_NOT_IN_QUEUE/);
    assert.equal(readWorkflow(workspace, workflow.id).continuation.events.checkpoint.queueId, receipt.queueId);
    assert.equal((await deliverResearchContinuation({ cwd: workspace, workflowId: workflow.id, expectedBinding: workflow.continuation.binding })).delivery, "already_sent");
    assert.match(second, /Plan Mode/i);
    assert.match(second, /read-only/);
    assert.equal(notifications.filter((event) => event.method === "turn/completed").every((event) => event.params.threadId === threadId), true);

  } finally {
    client?.close();
    child.kill("SIGTERM");
    await new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(null); else child.once("exit", () => resolve(null)); });
    await new Promise((resolve) => provider.close(() => resolve(null)));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
