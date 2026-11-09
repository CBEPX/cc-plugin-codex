/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connectCodexSharedServer } from "../../scripts/lib/codex-shared-server.mjs";

export async function startNativeRuntime({ workspace, home, env, onRequest, hookCommand = null }) {
  const requests = [];
  const errors = [];
  const notifications = [];
  const provider = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "mock-model", object: "model" }] })); return; }
    if (req.method !== "POST" || req.url !== "/v1/responses") { res.writeHead(404); res.end(); return; }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const items = await onRequest(body);
      const id = `response-${requests.length}`;
      const events = [{ type: "response.created", response: { id } },
        ...items.map((item) => ({ type: "response.output_item.done", item })),
        { type: "response.completed", response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) {
      errors.push(error.stack ?? String(error));
      res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "Local test provider failed" } }));
    }
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", () => resolve(null)));
  const port = /** @type {import('node:net').AddressInfo} */ (provider.address()).port;
  fs.mkdirSync(home, { recursive: true });
  const catalog = path.join(home, "test-models.json");
  fs.writeFileSync(catalog, JSON.stringify({ models: [{
    base_instructions: "Follow the supplied local test instructions.",
    slug: "mock-model", display_name: "Local test model", description: "Loopback test fixture",
    default_reasoning_level: "low", supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort, description: effort })),
    shell_type: "unified_exec", visibility: "list", supported_in_api: true, priority: 0,
    availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: null, truncation_policy: { mode: "tokens", limit: 20000 }, context_window: 200000,
    experimental_supported_tools: [],
  }] }));
  fs.writeFileSync(path.join(home, "config.toml"), `model="mock-model"
model_catalog_json=${JSON.stringify(catalog)}
model_provider="mock"
approval_policy="never"
sandbox_mode="workspace-write"
[sandbox_workspace_write]
writable_roots=[${JSON.stringify(home)}]
network_access=true
[features]
multi_agent=true
[model_providers.mock]
name="Local test"
base_url="http://127.0.0.1:${port}/v1"
wire_api="responses"
request_max_retries=0
stream_max_retries=0
supports_websockets=false
`);
  if (hookCommand) fs.writeFileSync(path.join(home, "hooks.json"), JSON.stringify({ hooks: {
    PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hookCommand, timeout: 8 }] }],
    Interrupt: [{ hooks: [{ type: "command", command: hookCommand, timeout: 3 }] }],
  } }));
  const serverSocket = path.join(home, "app-server-control", "app-server-control.sock");
  const nativeCoverage = env.NODE_V8_COVERAGE ? path.join(home, "native-coverage") : null;
  if (nativeCoverage) fs.mkdirSync(nativeCoverage, { recursive: true });
  const child = spawn("codex", ["app-server", "--listen", `unix://${serverSocket}`], { cwd: workspace,
    env: { ...env, CODEX_HOME: home, ...(nativeCoverage ? { NODE_V8_COVERAGE: nativeCoverage } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; }); child.stdout.resume();
  let client;
  const close = async () => {
    client?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => child.once("exit", () => resolve(null))), delay(2500)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", () => resolve(null)));
      }
    }
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(() => resolve(null)));
    if (nativeCoverage) {
      fs.mkdirSync(env.NODE_V8_COVERAGE, { recursive: true });
      for (const name of fs.readdirSync(nativeCoverage)) {
        const source = path.join(nativeCoverage, name);
        if (/^coverage-[0-9-]+\.json$/u.test(name) && fs.lstatSync(source).isFile()) {
          fs.copyFileSync(source, path.join(env.NODE_V8_COVERAGE, name), fs.constants.COPYFILE_EXCL);
        }
      }
    }
  };
  try {
    for (let i = 0; i < 200 && !fs.existsSync(serverSocket); i += 1) {
      assert.equal(child.exitCode, null, stderr); await delay(25);
    }
    assert.ok(fs.existsSync(serverSocket), stderr);
    client = await connectCodexSharedServer({ serverSocket: fs.realpathSync.native(serverSocket), timeoutMs: 10000,
      onNotification: (event) => notifications.push(event) });
    if (hookCommand) {
      const listed = await client.request("hooks/list", { cwds: [workspace] });
      const hooks = listed.data.flatMap((entry) => entry.hooks);
      assert.equal(hooks.length, 2, JSON.stringify(listed));
      assert.deepEqual(hooks.map((hook) => hook.eventName).sort(), ["interrupt", "postToolUse"]);
      assert.ok(hooks.every((hook) => hook.command === hookCommand));
      await client.request("config/batchWrite", { reloadUserConfig: true, edits: hooks.map((hook) => ({
        keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: "replace",
      })) });
      const trusted = await client.request("hooks/list", { cwds: [workspace] });
      assert.ok(trusted.data[0].hooks.every((hook) => hook.trustStatus === "trusted"), JSON.stringify(trusted));
    }
    return { ...client, serverSocket, requests, errors, notifications, close, stderr: () => stderr };
  } catch (error) { await close(); throw error; }
}
