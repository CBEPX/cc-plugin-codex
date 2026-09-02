/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const COMPANION = path.join(PROJECT_ROOT, "scripts", "claude-companion.mjs");
const SESSION_HOOK = path.join(PROJECT_ROOT, "hooks", "session-lifecycle-hook.mjs");

function checked(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function writeFakeMcp(filePath, name) {
  fs.writeFileSync(filePath, `#!/usr/bin/env node
import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  const result = request.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(name)}, version: "1" } }
    : { tools: [{ name: "search", description: "Search public documentation", annotations: { readOnlyHint: true } }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`, "utf8");
}

function writeFakeClaude(filePath) {
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
async function stdin() {
  let body = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) body += chunk;
  return body;
}
async function main() {
  if (args[0] === "--version") return void process.stdout.write("2.1.90 (Claude Code)\\n");
  if (args[0] === "auth" && args[1] === "status") return void process.stdout.write("authenticated\\n");
  const prompt = await stdin();
  const resumed = value("--resume");
  const critique = prompt.includes("Critique both frozen memos");
  const sessionId = resumed ? "forked-peer-session" : critique ? "fresh-critique-session" : "fresh-peer-session";
  const mcpPath = value("--mcp-config");
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    args,
    prompt,
    mcpConfig: mcpPath ? JSON.parse(fs.readFileSync(mcpPath, "utf8")) : null,
  }) + "\\n");
  if (process.env.FAKE_CLAUDE_SANDBOX_UNAVAILABLE === "1") {
    process.stderr.write("Sandbox initialization failed: sandbox unavailable\\n");
    process.exitCode = 1;
    return;
  }
  if (!args.includes("--no-session-persistence")) {
    const projectDir = path.join(process.env.HOME, ".claude", "projects", "fake");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, sessionId + ".jsonl"), prompt, "utf8");
  }
  const tool = (name, input) => process.stdout.write(JSON.stringify({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "content_block_start", content_block: { type: "tool_use", name, input } },
  }) + "\\n");
  tool("Read", { file_path: process.env.FAKE_REPO_FILE });
  if (process.env.FAKE_CLAUDE_SPARSE !== "1") tool("WebSearch", { query: "primary docs" });
  if (process.env.FAKE_CLAUDE_DELTA_MARKER) process.stdout.write(JSON.stringify({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "content_block_delta", delta: {
      type: "text_delta", text: process.env.FAKE_CLAUDE_DELTA_MARKER,
    } },
  }) + "\\n");
  if (!resumed) process.stdout.write(JSON.stringify({
    type: "system", subtype: "model_fallback", session_id: sessionId,
    from_model: "claude-fable-5-1", to_model: "claude-opus-5", reason: "capacity",
  }) + "\\n");
  const payload = critique
    ? { content: { critique: "Compare the frozen memos." } }
    : resumed
    ? { content: { critique: "Compare the frozen memos." } }
    : {
        content: { findings: [process.env.FAKE_CLAUDE_MARKER || "Repository and primary evidence agree."] },
        repoCitations: [{ path: process.env.FAKE_REPO_FILE, line: 1 }],
        webCitations: process.env.FAKE_CLAUDE_SPARSE === "1" ? [] : ["https://example.test/primary"],
      };
  const resultLine = () => JSON.stringify({
    type: "result", session_id: sessionId, result: JSON.stringify(payload),
    model: "claude-opus-5",
    modelUsage: { "claude-opus-5": { inputTokens: 1, outputTokens: 1, contextWindow: 1000000 } },
  }) + "\\n";
  const emitResult = () => process.stdout.write(resultLine());
  if (process.env.FAKE_CLAUDE_RESULT_ON_TERM === "1") {
    process.on("SIGTERM", () => {
      fs.writeFileSync(process.stdout.fd, resultLine(), "utf8");
      fs.writeFileSync(
        process.env.FAKE_CLAUDE_TERM_DELIVERED_FILE,
        process.env.FAKE_CLAUDE_MARKER + "\\n",
        "utf8"
      );
      process.exit(0);
    });
    fs.writeFileSync(process.env.FAKE_CLAUDE_TERM_READY_FILE, "ready\\n", "utf8");
    setInterval(() => {}, 1000);
    return;
  }
  const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS || 0);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  emitResult();
}
main().catch((error) => { process.stderr.write(String(error.stack || error) + "\\n"); process.exitCode = 1; });
`, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function createEnvironment() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-peer-e2e-"));
  const homeDir = path.join(rootDir, "home");
  const binDir = path.join(rootDir, "bin");
  const workspaceDir = path.join(rootDir, "workspace");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  writeFakeClaude(path.join(binDir, "claude"));
  const docsMcp = path.join(rootDir, "docs-mcp.mjs");
  const unusedMcp = path.join(rootDir, "unused-mcp.mjs");
  writeFakeMcp(docsMcp, "docs");
  writeFakeMcp(unusedMcp, "unused");
  fs.writeFileSync(path.join(homeDir, ".claude.json"), JSON.stringify({
    mcpServers: {
      docs: { command: process.execPath, args: [docsMcp] },
      unused: { command: process.execPath, args: [unusedMcp] },
    },
  }), "utf8");
  checked(workspaceDir, "git", ["init", "--initial-branch=main"]);
  checked(workspaceDir, "git", ["config", "user.name", "Codex Test"]);
  checked(workspaceDir, "git", ["config", "user.email", "codex@example.com"]);
  const repoFile = path.join(workspaceDir, "tracked.txt");
  fs.writeFileSync(repoFile, "base\n", "utf8");
  checked(workspaceDir, "git", ["add", "tracked.txt"]);
  checked(workspaceDir, "git", ["commit", "-m", "initial"]);
  const codexHome = path.join(homeDir, ".codex");
  return {
    rootDir,
    workspaceDir,
    repoFile,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODEX_HOME: codexHome,
      CODEX_THREAD_ID: "owner-a",
      CLAUDE_COMPANION_SESSION_ID: "owner-a",
      FAKE_REPO_FILE: repoFile,
      FAKE_CLAUDE_LOG: path.join(rootDir, "claude.ndjson"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    },
  };
}

function run(testEnv, args, options = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...testEnv.env, ...(options.env ?? {}) },
    input: options.input,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function runJson(testEnv, args, options = {}) {
  const result = run(testEnv, args, options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runAsync(testEnv, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COMPANION, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...testEnv.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for test condition");
}

function stateDir(testEnv) {
  const canonical = fs.realpathSync.native(testEnv.workspaceDir);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return path.join(testEnv.env.CODEX_HOME, "plugins", "data", "cc", "state", hash);
}

function readWorkflow(testEnv, id) {
  return JSON.parse(fs.readFileSync(path.join(stateDir(testEnv), "workflows", `${id}.json`), "utf8"));
}

function readStateText(testEnv) {
  const values = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) values.push(fs.readFileSync(candidate, "utf8"));
    }
  };
  visit(stateDir(testEnv));
  return values.join("\n");
}

function readTreeText(root, include = (_filePath) => true) {
  if (!fs.existsSync(root)) return "";
  const values = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && include(candidate)) values.push(fs.readFileSync(candidate, "utf8"));
    }
  };
  visit(root);
  return values.join("\n");
}

function writeWorkflow(testEnv, workflow) {
  fs.writeFileSync(
    path.join(stateDir(testEnv), "workflows", `${workflow.id}.json`),
    `${JSON.stringify(workflow, null, 2)}\n`,
    "utf8"
  );
}

function createPeer(testEnv, id = null) {
  const created = runJson(testEnv, [
    "peer-create", "--mode", "design", "--cwd", testEnv.workspaceDir,
    "--owner-session-id", "owner-a", "--user-mcp-tool", "mcp__docs__search",
    "--json", id ?? "Compare", "the", "runtime", "design.",
  ]);
  return created;
}

function memo(testEnv, who) {
  return {
    content: { findings: [`${who} memo`] },
    repoCitations: [{ path: testEnv.repoFile, line: 1 }],
    webCitations: [`https://example.test/${who}`],
    toolEvents: [{ tool: "repo-read" }, { tool: "web-search" }],
  };
}

function planLease(result, taskPart, attempt = null) {
  const child = result.spawnPlan.find(({ task_name }) => task_name.includes(taskPart));
  assert.ok(child);
  if (attempt) {
    const match = child.message.match(/<peer_attempts>\n([^\n]+)\n<\/peer_attempts>/u);
    assert.ok(match);
    return JSON.parse(match[1])[attempt];
  }
  return child.message.match(/\{"lease":"([a-f0-9]{64})"\}/u)?.[1];
}

function attemptInput(lease, payload) {
  return JSON.stringify({ lease, ...(payload === undefined ? {} : { payload }) });
}

function activate(testEnv, result, stage, branch, lease) {
  return runJson(testEnv, [
    "peer-activate-attempt", result.workflow.id, "--cwd", testEnv.workspaceDir,
    "--stage", stage, ...(branch ? ["--branch", branch] : []),
    "--brief-hash", result.workflow.briefHash,
    "--epoch", String(result.workflow.epoch), "--json",
  ], { input: attemptInput(lease) });
}

test("peer workflow acceptance covers aggregate surfaces, retry, lifecycle, and no workspace writes", async () => {
  const testEnv = createEnvironment();
  try {
    const before = checked(testEnv.workspaceDir, "git", ["status", "--porcelain=v1", "--untracked-files=all"]);
    const created = createPeer(testEnv);
    assert.equal(created.spawnPlan.length, 2);
    assert.equal(created.spawnPlan.every(({ fork_turns }) => fork_turns === "none"), true);
    const codexLease = planLease(created, "_codex_", "memo");
    const claudeLease = planLease(created, "_claude_");
    const checkpointLease = planLease(created, "_codex_", "checkpoint");
    activate(testEnv, created, "memo", "codex", codexLease);
    const marker = "CLAUDE_FIRST_ACCEPTANCE_MARKER_4A7D91";
    const progressMarker = "CLAUDE_PROGRESS_MUST_NOT_PERSIST_8C2E65";
    const claudePromise = runAsync(testEnv, [
      "peer-claude-turn", created.workflow.id, "--cwd", testEnv.workspaceDir,
      "--brief-hash", created.workflow.briefHash,
      "--epoch", String(created.workflow.epoch), "--json",
    ], { input: attemptInput(claudeLease), env: {
      FAKE_CLAUDE_MARKER: marker,
      FAKE_CLAUDE_DELTA_MARKER: progressMarker,
      FAKE_CLAUDE_DELAY_MS: "25",
    } });
    await waitFor(() => readWorkflow(testEnv, created.workflow.id).branches.claude.commitment);
    const managedRoot = stateDir(testEnv);
    const waitingSurfaces = {
      workflows: readTreeText(path.join(managedRoot, "workflows")),
      jobs: readTreeText(path.join(managedRoot, "jobs"), (file) => file.endsWith(".json")),
      logs: readTreeText(path.join(managedRoot, "jobs"), (file) => file.endsWith(".log")),
      codexState: readTreeText(testEnv.env.CODEX_HOME),
      claudeProjects: readTreeText(path.join(testEnv.env.HOME, ".claude", "projects")),
    };
    for (const [surface, text] of Object.entries(waitingSurfaces)) {
      assert.doesNotMatch(text, new RegExp(marker), `${surface} exposed terminal content`);
      assert.doesNotMatch(text, new RegExp(progressMarker), `${surface} exposed streamed content`);
    }
    assert.equal(fs.existsSync(path.join(testEnv.env.HOME, ".claude", "projects")), false);

    const codex = await runAsync(testEnv, [
      "peer-submit-memo", created.workflow.id, "--cwd", testEnv.workspaceDir,
      "--branch", "codex", "--brief-hash", created.workflow.briefHash,
      "--epoch", String(created.workflow.epoch), "--json",
    ], { input: attemptInput(codexLease, memo(testEnv, "codex")) });
    const claude = await claudePromise;
    assert.equal(codex.status, 0, codex.stderr || codex.stdout);
    assert.equal(claude.status, 0, claude.stderr || claude.stdout);
    activate(testEnv, created, "checkpoint", null, checkpointLease);
    runJson(testEnv, [
      "peer-checkpoint", created.workflow.id, "--cwd", testEnv.workspaceDir,
      "--brief-hash", created.workflow.briefHash,
      "--epoch", String(created.workflow.epoch), "--json",
    ], { input: attemptInput(checkpointLease, {
      agreements: ["same"], disagreements: [], decisionsNeeded: ["choose"],
    }) });

    const status = runJson(testEnv, ["status", "--cwd", testEnv.workspaceDir, "--json"]);
    assert.deepEqual(status.workflows.map(({ id }) => id), [created.workflow.id]);
    assert.equal(status.running.some(({ workflowId }) => workflowId === created.workflow.id), false);
    const all = runJson(testEnv, ["status", "--cwd", testEnv.workspaceDir, "--all", "--json"]);
    assert.equal([
      ...all.running,
      all.latestFinished,
      ...all.recent,
    ].filter(Boolean).some(({ workflowId }) => workflowId === created.workflow.id), true);
    const checkpoint = runJson(testEnv, [
      "result", created.workflow.id, "--cwd", testEnv.workspaceDir, "--json",
    ]);
    assert.equal(checkpoint.targetType, "workflow");
    assert.equal(checkpoint.workflow.phase, "checkpoint");
    assert.deepEqual(checkpoint.workflow.checkpoint.agreements, ["same"]);

    const continuation = runJson(testEnv, [
      "peer-resume-plan", created.workflow.id, "--cwd", testEnv.workspaceDir,
      "--continue", "--owner-session-id", "owner-b", "--json",
    ], { input: JSON.stringify({ feedback: "Prefer simple." }) });
    const critiqueLease = planLease(continuation, "_critique_");
    runJson(testEnv, [
      "peer-claude-critique", created.workflow.id, "--cwd", testEnv.workspaceDir,
      "--brief-hash", created.workflow.briefHash,
      "--epoch", String(continuation.workflow.epoch), "--json",
    ], { input: attemptInput(critiqueLease) });
    const synthesisLease = planLease(continuation, "_synthesis_", "synthesis");
    activate(testEnv, continuation, "synthesis", null, synthesisLease);
    runJson(testEnv, [
      "peer-final", created.workflow.id, "--cwd", testEnv.workspaceDir,
      "--brief-hash", created.workflow.briefHash,
      "--epoch", String(continuation.workflow.epoch), "--json",
    ], { input: attemptInput(synthesisLease, {
      recommendation: "Use the narrow path.",
    }) });
    const finalResult = runJson(testEnv, [
      "result", created.workflow.id, "--cwd", testEnv.workspaceDir, "--json",
    ]);
    assert.equal(finalResult.workflow.currentOwnerSessionId, "owner-b");
    assert.equal(finalResult.workflow.finalResult.recommendation, "Use the narrow path.");

    const partial = createPeer(testEnv, "Partial failure retry.");
    const partialCodexLease = planLease(partial, "_codex_", "memo");
    activate(testEnv, partial, "memo", "codex", partialCodexLease);
    runJson(testEnv, [
      "peer-submit-memo", partial.workflow.id, "--cwd", testEnv.workspaceDir,
      "--branch", "codex", "--brief-hash", partial.workflow.briefHash,
      "--epoch", String(partial.workflow.epoch), "--json",
    ], { input: attemptInput(partialCodexLease, memo(testEnv, "partial-codex")) });
    const partialClaudeLease = planLease(partial, "_claude_");
    const sparse = run(testEnv, [
      "peer-claude-turn", partial.workflow.id, "--cwd", testEnv.workspaceDir,
      "--brief-hash", partial.workflow.briefHash,
      "--epoch", String(partial.workflow.epoch), "--json",
    ], {
      input: attemptInput(partialClaudeLease),
      env: { FAKE_CLAUDE_SPARSE: "1" },
    });
    assert.notEqual(sparse.status, 0);
    const retry = runJson(testEnv, [
      "peer-resume-plan", partial.workflow.id, "--cwd", testEnv.workspaceDir,
      "--retry", "--owner-session-id", "owner-b", "--json",
    ]);
    assert.deepEqual(retry.work, [
      { kind: "branch", id: "claude" },
      { kind: "stage", id: "checkpoint" },
    ]);
    const retryClaudeLease = planLease(retry, "_claude_");
    const retryCheckpointLease = planLease(retry, "_checkpoint_", "checkpoint");

    const isolated = createPeer(testEnv, "Sandbox failure path.");
    const isolationLease = planLease(isolated, "_claude_");
    const isolationFailure = run(testEnv, [
      "peer-claude-turn", isolated.workflow.id, "--cwd", testEnv.workspaceDir,
      "--brief-hash", isolated.workflow.briefHash,
      "--epoch", String(isolated.workflow.epoch), "--json",
    ], {
      input: attemptInput(isolationLease),
      env: { FAKE_CLAUDE_SANDBOX_UNAVAILABLE: "1" },
    });
    assert.notEqual(isolationFailure.status, 0);
    assert.match(isolationFailure.stderr, /PEER_ISOLATION_UNAVAILABLE/u);

    const lifecycle = createPeer(testEnv, "SessionEnd path.");
    const startedAt = new Date().toISOString();
    writeWorkflow(testEnv, {
      ...lifecycle.workflow,
      status: "running",
      phase: "memo",
      revision: lifecycle.workflow.revision + 1,
      startedAt,
      updatedAt: startedAt,
      branches: {
        ...lifecycle.workflow.branches,
        codex: {
          ...lifecycle.workflow.branches.codex,
          status: "running",
          stage: "memo",
          attempts: 1,
          startedAt,
          startFingerprint: lifecycle.workflow.fingerprint,
          attemptReservation: {
            epoch: lifecycle.workflow.epoch,
            leaseDigest: createHash("sha256").update("e2e-attempt").digest("hex"),
            reservedAt: startedAt,
          },
        },
      },
    });
    const ended = spawnSync(process.execPath, [SESSION_HOOK, "SessionEnd"], {
      cwd: PROJECT_ROOT,
      env: testEnv.env,
      input: JSON.stringify({ cwd: testEnv.workspaceDir, session_id: "owner-a" }),
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(ended.status, 0, ended.stderr || ended.stdout);
    assert.equal(readWorkflow(testEnv, lifecycle.workflow.id).branches.codex.failureReason, "SESSION_ENDED");

    const cancellable = createPeer(testEnv, "Cancellation path.");
    const cancellableLease = planLease(cancellable, "_claude_");
    const termReadyFile = path.join(testEnv.rootDir, "term-handler-ready");
    const termDeliveredFile = path.join(testEnv.rootDir, "term-result-delivered");
    const lateResultMarker = "LATE_TERM_RESULT_MUST_NOT_PERSIST_73B4C1";
    assert.equal(path.relative(testEnv.workspaceDir, termReadyFile).startsWith(".."), true);
    assert.equal(path.relative(testEnv.workspaceDir, termDeliveredFile).startsWith(".."), true);
    const cancellableClaude = runAsync(testEnv, [
      "peer-claude-turn", cancellable.workflow.id, "--cwd", testEnv.workspaceDir,
      "--brief-hash", cancellable.workflow.briefHash,
      "--epoch", String(cancellable.workflow.epoch), "--json",
    ], {
      input: attemptInput(cancellableLease),
      env: {
        FAKE_CLAUDE_RESULT_ON_TERM: "1",
        FAKE_CLAUDE_MARKER: lateResultMarker,
        FAKE_CLAUDE_TERM_READY_FILE: termReadyFile,
        FAKE_CLAUDE_TERM_DELIVERED_FILE: termDeliveredFile,
      },
    });
    try {
      await waitFor(() => fs.existsSync(termReadyFile)
        && fs.readFileSync(termReadyFile, "utf8") === "ready\n");
    } catch (error) {
      runJson(testEnv, ["cancel", cancellable.workflow.id, "--cwd", testEnv.workspaceDir, "--json"]);
      await cancellableClaude;
      throw error;
    }
    const cancelled = runJson(testEnv, [
      "cancel", cancellable.workflow.id, "--cwd", testEnv.workspaceDir, "--json",
    ]);
    assert.equal(cancelled.workflow.status, "cancelled");
    const cancellableResult = await cancellableClaude;
    assert.equal(fs.readFileSync(termDeliveredFile, "utf8"), `${lateResultMarker}\n`);
    const cancelledWorkflowPath = path.join(
      stateDir(testEnv), "workflows", `${cancellable.workflow.id}.json`
    );
    const cancelledWorkflowBytes = fs.readFileSync(cancelledWorkflowPath);
    assert.equal(cancellableResult.status, 1, cancellableResult.stderr || cancellableResult.stdout);
    assert.equal(cancellableResult.stdout, "");
    assert.equal(cancellableResult.stderr, "STALE_EPOCH\n");
    assert.deepEqual(fs.readFileSync(cancelledWorkflowPath), cancelledWorkflowBytes);
    const cancelledStored = readWorkflow(testEnv, cancellable.workflow.id);
    assert.equal(cancelledStored.status, "cancelled");
    assert.equal(cancelledStored.branches.claude.payload, null);
    assert.doesNotMatch(JSON.stringify(cancelledStored), new RegExp(lateResultMarker));

    const invocations = fs.readFileSync(testEnv.env.FAKE_CLAUDE_LOG, "utf8").trim()
      .split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations.every(({ args }) => !args.some((value) => value.startsWith("Agent"))), true);
    assert.equal(invocations.every(({ args }) => args.includes("--no-session-persistence")), true);
    assert.equal(invocations.every(({ mcpConfig }) =>
      JSON.stringify(Object.keys(mcpConfig.mcpServers)) === JSON.stringify(["docs"])
    ), true);
    const initialWorkflow = readWorkflow(testEnv, created.workflow.id);
    assert.equal(initialWorkflow.branches.claude.payload.model.finalModel, "claude-opus-5");
    assert.equal(initialWorkflow.branches.claude.payload.model.modelFallbacks.length, 1);
    assert.deepEqual(initialWorkflow.toolManifest.map(({ toolId }) => toolId), ["mcp__docs__search"]);
    assert.equal(initialWorkflow.branches.claude.payload.repoCitations.length, 1);
    assert.equal(initialWorkflow.branches.claude.payload.webCitations.length, 1);
    assert.deepEqual(initialWorkflow.branches.claude.payload.content.findings, [marker]);
    const publicAndDurable = [
      readStateText(testEnv),
      JSON.stringify(created.workflow),
      JSON.stringify(status),
      JSON.stringify(all),
      JSON.stringify(checkpoint),
      JSON.stringify(finalResult),
    ].join("\n");
    for (const lease of [
      codexLease,
      claudeLease,
      checkpointLease,
      critiqueLease,
      synthesisLease,
      partialCodexLease,
      partialClaudeLease,
      retryClaudeLease,
      retryCheckpointLease,
      isolationLease,
      cancellableLease,
    ]) {
      assert.doesNotMatch(publicAndDurable, new RegExp(lease));
    }
    const after = checked(testEnv.workspaceDir, "git", ["status", "--porcelain=v1", "--untracked-files=all"]);
    assert.equal(after, before);
  } finally {
    fs.rmSync(testEnv.rootDir, { recursive: true, force: true });
  }
});
