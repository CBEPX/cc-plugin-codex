/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import "../test-env.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createEnvironment, checked } from "../fixtures/peer-environment.mjs";
import { startNativeRuntime } from "../fixtures/native-runtime.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const companion = path.join(root, "scripts", "claude-companion.mjs");
const available = process.platform !== "win32" && typeof globalThis.WebSocket === "function" && spawnSync("codex", ["--version"]).status === 0;
const quote = (text) => `'${String(text).replaceAll("'", `'"'"'`)}'`;
const flattenTools = (tools) => (tools ?? []).flatMap((tool) => [tool, ...flattenTools(tool.tools)]);
const textItem = (text) => ({ type: "message", role: "assistant", id: "msg-" + Math.random(), content: [{ type: "output_text", text }] });
function nativeToolName(tools, name, prefix = "") {
  for (const tool of tools ?? []) {
    if (tool.tools) {
      const found = nativeToolName(tool.tools, name, prefix + tool.name + ".");
      if (found) return found;
    } else if (tool.name === name) return prefix + name;
  }
  return null;
}
let calls = 0;
function callItem(body, name, args) {
  assert.ok(flattenTools(body.tools).some((tool) => tool.name === name), `Missing native tool ${name}`);
  const qualified = nativeToolName(body.tools, name);
  const separator = qualified.lastIndexOf(".");
  return { type: "function_call", call_id: `native-call-${++calls}`, name,
    ...(separator >= 0 ? { namespace: qualified.slice(0, separator) } : {}), arguments: JSON.stringify(args) };
}
function shellItem(body, cmd, cwd) {
  const names = flattenTools(body.tools).map((tool) => tool.name);
  const name = names.includes("exec_command") ? "exec_command" : names.includes("shell_command") ? "shell_command" : "shell";
  return callItem(body, name, name === "exec_command" ? { cmd, workdir: cwd, yield_time_ms: 10000, max_output_tokens: 14000 }
    : name === "shell_command" ? { command: cmd, cwd, timeout_ms: 20000 } : { command: ["sh", "-c", cmd], timeout_ms: 20000 });
}
function outputPayload(body, key) {
  const find = (value) => {
    if (typeof value === "string") {
      const start = value.indexOf("{");
      if (start >= 0) { try { return find(JSON.parse(value.slice(start))); } catch {} }
      return null;
    }
    if (!value || typeof value !== "object") return null;
    if (key in value) return value;
    for (const child of Object.values(value)) { const found = find(child); if (found) return found; }
    return null;
  };
  for (const item of [...body.input].reverse()) if (item.type === "function_call_output") { const found = find(item.output); if (found) return found; }
  return null;
}
async function waitFor(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await delay(20); }
  assert.fail("Native parent did not finish the expected phase");
}
function sectionRead(file, epoch) {
  return `node - ${quote(file)} <<'CC_NATIVE_READ'
const fs=require('node:fs'),path=require('node:path');
const file=process.argv[2],data=JSON.parse(fs.readFileSync(file,'utf8'));
if(data.epoch!==${epoch})throw new Error('STALE_EPOCH');
for(const field of ['finalResult','branches.codex.payload','branches.claude.payload','checkpoint','feedback','critique','brief','modelManifest','toolManifest']){
 const value=field.split('.').reduce((v,k)=>v?.[k],data),text=JSON.stringify(value??null);
 for(let offset=0;offset<text.length;offset+=1024)console.log(JSON.stringify({field,text:text.slice(offset,offset+1024),nextOffset:offset+1024<text.length?offset+1024:null}));
}
fs.unlinkSync(file);fs.rmdirSync(path.dirname(file));
CC_NATIVE_READ`;
}

test("native background research wakes its parent, runs critique/synthesis once and returns to planning", { skip: !available, timeout: 90000 }, async () => {
  const testEnv = createEnvironment();
  Object.assign(testEnv.env, { FAKE_SEARCH_RECEIPTS: "1" });
  let runtime;
  let threadId;
  let workflowId;
  let plans;
  const prepareCommands = [];
  let parent = "seed";
  let critique = 0;
  let synthesis = "wait";
  let synthExport;
  let finalExport;
  const phases = [];
  const hash = createHash("sha256").update(fs.realpathSync.native(testEnv.workspaceDir)).digest("hex").slice(0, 12);
  const state = () => JSON.parse(fs.readFileSync(path.join(testEnv.env.CODEX_HOME, "plugins/data/cc/state", hash, "workflows", workflowId + ".json"), "utf8"));
  const command = (args, input = undefined) => {
    const r = spawnSync(process.execPath, [companion, ...args, "--cwd", testEnv.workspaceDir, "--json"], {
      env: { ...testEnv.env, CODEX_THREAD_ID: threadId ?? "owner-a" }, encoding: "utf8", input, timeout: 20000,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout); return JSON.parse(r.stdout);
  };
  const lease = (plan, name = null) => name
    ? JSON.parse(plan.message.match(/<peer_attempts>\n([^\n]+)\n<\/peer_attempts>/)[1])[name]
    : plan.message.match(/\{"lease":"([a-f0-9]{64})"\}/)[1];
  try {
    runtime = await startNativeRuntime({ workspace: testEnv.workspaceDir, home: testEnv.env.CODEX_HOME, env: testEnv.env, hookCommand: `node ${quote(path.join(root, "hooks/research-continuation-hook.mjs"))}`, onRequest: async (body) => {
      assert.ok(phases.length < 60, "Native controller loop did not converge");
      const userText = JSON.stringify(body.input.filter((item) => item.role === "user"));
      if (userText.includes("You are a pure Claude forwarder for a peer continuation")) {
        phases.push("critique-" + critique);
        if (critique++ === 0) return [shellItem(body, plans[0].message.slice(plans[0].message.indexOf("node ")), testEnv.workspaceDir)];
        assert.equal(state().stages.critique.status, "completed");
        return [textItem("Critique completed; receipt only.")];
      }
      if (userText.includes("You are the Codex synthesizer for a peer continuation")) {
        phases.push("synthesis-" + synthesis);
        if (synthesis === "wait") {
          if (state().stages.critique.status !== "completed") return [shellItem(body, `node ${quote(companion)} peer-wait ${quote(workflowId)} --cwd ${quote(testEnv.workspaceDir)} --mode research --json`, testEnv.workspaceDir)];
          synthesis = "export";
          const recipe = plans[1].message.match(/node - <<'CC_PEER_READ_EXPORT'\n[\s\S]*?\nCC_PEER_READ_EXPORT/)[0];
          return [shellItem(body, recipe, testEnv.workspaceDir)];
        }
        if (synthesis === "export") {
          synthExport = outputPayload(body, "outputFile")?.outputFile;
          assert.ok(synthExport, "Synthesis must receive a full export receipt");
          synthesis = "read"; return [shellItem(body, sectionRead(synthExport, 0), testEnv.workspaceDir)];
        }
        if (synthesis === "read") {
          assert.ok(JSON.stringify(body).includes("CODEX_EVIDENCE"));
          assert.ok(JSON.stringify(body).includes("Repository and primary evidence agree"));
          await waitFor(() => runtime.notifications.filter((e) => e.method === "turn/completed" && e.params.threadId === threadId).length >= 2);
          synthesis = "commit";
          const activation = plans[1].message.match(/node '[^\n]+peer-activate-attempt[^\n]+\n\{"lease":"[a-f0-9]+"\}\nCC_PEER_SYNTHESIS_ACTIVATION/)[0];
          const payload = { findings: ["FROZEN_SYNTHESIS"], sourceQuality: "Primary fixtures", contradictions: [], confidence: "high", gaps: [] };
          const submit = `node ${quote(companion)} peer-final ${quote(workflowId)} --cwd ${quote(testEnv.workspaceDir)} --brief-hash ${quote(state().briefHash)} --epoch 0 --json <<'CC_NATIVE_FINAL'\n${JSON.stringify({ lease: lease(plans[1], "synthesis"), payload })}\nCC_NATIVE_FINAL`;
          return [shellItem(body, `set -e\n${activation}\n${submit}`, testEnv.workspaceDir)];
        }
        assert.equal(state().status, "completed");
        assert.equal(state().continuation.events.completed.delivery, "queued", JSON.stringify(body.input.filter((item) => item.type === "function_call_output")).replace(/[a-f0-9]{64}/g, "[test-digest]"));
        return [textItem("Synthesis completed; receipt only.")];
      }
      phases.push("parent-" + parent);
      assert.match(JSON.stringify(body), /Plan Mode/i);
      assert.doesNotMatch(JSON.stringify(body), /sandbox_mode.*danger-full-access/);
      if (parent === "seed") { parent = "prepare"; return [shellItem(body, `node ${quote(companion)} peer-status ${quote(workflowId)} --cwd ${quote(testEnv.workspaceDir)} --json`, testEnv.workspaceDir)]; }
      if (parent === "prepare") {
        assert.equal(state().continuation.state, "ready", JSON.stringify(body.input.slice(-2)));
        parent = "prepared"; return [shellItem(body, "set -e\n" + prepareCommands.join("\n"), testEnv.workspaceDir)];
      }
      if (parent === "prepared") { parent = "wake"; return [textItem("INITIAL_TURN_RETURNED")]; }
      if (parent === "wake") {
        const event = state().continuation.events.checkpoint;
        assert.ok(userText.includes(event.id)); parent = "resume";
        return [shellItem(body, `node ${quote(companion)} peer-resume-plan ${quote(workflowId)} --cwd ${quote(testEnv.workspaceDir)} --mode research --continue --wake-event ${quote(event.id)} --wake-epoch 0 --json`, testEnv.workspaceDir)];
      }
      if (parent === "resume") {
        const result = outputPayload(body, "spawnPlan");
        assert.equal(result?.continuation.accepted, true, JSON.stringify(body.input.filter((item) => item.type === "function_call_output")).replace(/[a-f0-9]{64}/g, "[test-digest]").slice(-4000)); plans = result.spawnPlan;
        assert.equal(plans.length, 2); parent = "spawn-synthesis";
        return [callItem(body, "spawn_agent", { ...plans[0], agent_type: "default" })];
      }
      if (parent === "spawn-synthesis") {
        assert.ok(outputPayload(body, "agent_id")); parent = "return-background";
        return [callItem(body, "spawn_agent", { ...plans[1], agent_type: "default" })];
      }
      if (parent === "return-background") {
        assert.ok(outputPayload(body, "agent_id")); parent = "final-wake";
        return [textItem("CRITIQUE_AND_SYNTHESIS_RUNNING_IN_BACKGROUND")];
      }
      if (parent === "final-wake") {
        const event = state().continuation.events.completed;
        if (!event || !userText.includes(event.id)) return [textItem("WAITING_FOR_FENCED_FINAL_EVENT")];
        parent = "final-ack";
        return [shellItem(body, `node ${quote(companion)} peer-resume-plan ${quote(workflowId)} --cwd ${quote(testEnv.workspaceDir)} --mode research --continue --wake-event ${quote(event.id)} --wake-epoch 0 --json`, testEnv.workspaceDir)];
      }
      if (parent === "final-ack") {
        const result = outputPayload(body, "readPlan"); assert.equal(result?.completed, true);
        parent = "final-export"; return [shellItem(body, result.readPlan[2], testEnv.workspaceDir)];
      }
      if (parent === "final-export") {
        finalExport = outputPayload(body, "outputFile")?.outputFile; assert.ok(finalExport);
        parent = "plan"; return [shellItem(body, sectionRead(finalExport, 0), testEnv.workspaceDir)];
      }
      assert.ok(JSON.stringify(body).includes("FROZEN_SYNTHESIS"));
      assert.ok(JSON.stringify(body).includes("CODEX_EVIDENCE"));
      assert.ok(JSON.stringify(body).includes("Compare the frozen memos"));
      parent = "done";
      return [textItem("PLAN_READY: use the frozen findings, resolve remaining decisions, then wait for implementation approval.")];
    } });
    const started = await runtime.request("thread/start", { cwd: testEnv.workspaceDir, model: "mock-model", approvalPolicy: "never", sandbox: "workspace-write" });
    threadId = started.thread.id;
    const instructions = fs.readFileSync(path.join(root, "skills/research/SKILL.md"), "utf8") + "\n" + fs.readFileSync(path.join(root, "internal-skills/peer-runtime/runtime.md"), "utf8");
    const prepare = (args, input) => prepareCommands.push(`node ${quote(companion)} ${[...args, "--cwd", testEnv.workspaceDir, "--json"].map(quote).join(" ")} <<'CC_NATIVE_PREPARE'\n${input}\nCC_NATIVE_PREPARE`);
    const before = checked(testEnv.workspaceDir, "git", ["status", "--porcelain=v1", "--untracked-files=all"]);
    const created = command(["peer-create", "--mode", "research", "--owner-session-id", "owner-a", "--search-provider", "native", "--codex-search-tool", "web.run", "Trace cancellation"]);
    workflowId = created.workflow.id;
    assert.equal(created.continuation.state, "unavailable");
    const codex = created.spawnPlan[0];
    prepare(["peer-activate-attempt", workflowId, "--stage", "memo", "--branch", "codex", "--brief-hash", created.workflow.briefHash, "--epoch", "0"], JSON.stringify({ lease: lease(codex, "memo") }));
    prepare(["peer-submit-memo", workflowId, "--branch", "codex", "--brief-hash", created.workflow.briefHash, "--epoch", "0"], JSON.stringify({ lease: lease(codex, "memo"), payload: {
      content: { findings: ["CODEX_EVIDENCE"] }, repoCitations: [{ path: testEnv.repoFile, line: 1 }], webCitations: ["https://example.test/codex"],
      toolEvents: [{ tool: "web.run", operation: "search", toolUseId: "search-1" }], toolResults: [{ toolUseId: "search-1", isError: false }],
    } }));
    prepare(["peer-claude-turn", workflowId, "--brief-hash", created.workflow.briefHash, "--epoch", "0"], JSON.stringify({ lease: lease(created.spawnPlan[1]) }));
    prepare(["peer-activate-attempt", workflowId, "--stage", "checkpoint", "--brief-hash", created.workflow.briefHash, "--epoch", "0"], JSON.stringify({ lease: lease(codex, "checkpoint") }));
    prepare(["peer-checkpoint", workflowId, "--brief-hash", created.workflow.briefHash, "--epoch", "0"], JSON.stringify({ lease: lease(codex, "checkpoint"), payload: { agreements: ["checked"], disagreements: [], decisionsNeeded: [] } }));
    await runtime.request("turn/start", { threadId, input: [{ type: "text", text: instructions + "\nSEED: launch research and later continue planning only." }], collaborationMode: { mode: "plan", settings: { model: "mock-model", reasoning_effort: "low", developer_instructions: null } } });
    await waitFor(() => parent === "done" || runtime.errors.length > 0, 45000);
    assert.deepEqual(runtime.errors, [], runtime.stderr());
    assert.equal(parent, "done", JSON.stringify(phases));
    await waitFor(() => runtime.notifications.filter((e) => e.method === "turn/completed" && e.params.threadId === threadId).length >= 3);
    const finished = state();
    assert.ok(finished.continuation.events.checkpoint.consumedAt);
    assert.ok(finished.continuation.events.completed.consumedAt);
    assert.equal(finished.stages.critique.attempts, 1);
    assert.equal(finished.stages.synthesis.attempts, 1);
    const invocations = fs.readFileSync(testEnv.env.FAKE_CLAUDE_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations.length, 2);
    assert.ok(invocations.every((call) => call.args.includes("--no-session-persistence") && !call.args.includes("--resume")));
    assert.equal(checked(testEnv.workspaceDir, "git", ["status", "--porcelain=v1", "--untracked-files=all"]), before);
    assert.ok(!fs.existsSync(synthExport) && !fs.existsSync(finalExport));
  } catch (error) {
    if (process.env.CC_NATIVE_E2E_DEBUG_FILE) {
      let current;
      try { current = state(); } catch {}
      const debug = { parent, critique, synthesis, phases, errors: runtime?.errors, stderr: runtime?.stderr(),
        workflow: current ? { status: current.status, phase: current.phase, continuation: current.continuation,
          stages: Object.fromEntries(Object.entries(current.stages).map(([name, stage]) => [name, { status: stage.status, failureReason: stage.failureReason, failureDetail: stage.failureDetail }])) } : null,
        lastNotifications: runtime?.notifications.slice(-12).map((event) => ({ method: event.method, threadId: event.params?.threadId, status: event.params?.turn?.status, error: event.params?.turn?.error })),
      };
      fs.writeFileSync(process.env.CC_NATIVE_E2E_DEBUG_FILE, JSON.stringify(debug, null, 2).replace(/[a-f0-9]{64}/g, "[test-digest]"));
    }
    throw error;
  } finally {
    await runtime?.close();
    fs.rmSync(testEnv.rootDir, { recursive: true, force: true });
  }
});
