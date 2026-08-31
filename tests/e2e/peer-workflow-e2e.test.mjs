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
  const sessionId = resumed ? "forked-peer-session" : "fresh-peer-session";
  const mcpPath = value("--mcp-config");
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    args,
    prompt,
    mcpConfig: mcpPath ? JSON.parse(fs.readFileSync(mcpPath, "utf8")) : null,
  }) + "\\n");
  const tool = (name, input) => process.stdout.write(JSON.stringify({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "content_block_start", content_block: { type: "tool_use", name, input } },
  }) + "\\n");
  tool("Read", { file_path: process.env.FAKE_REPO_FILE });
  if (process.env.FAKE_CLAUDE_SPARSE !== "1") tool("WebSearch", { query: "primary docs" });
  if (!resumed) process.stdout.write(JSON.stringify({
    type: "system", subtype: "model_fallback", session_id: sessionId,
    from_model: "claude-fable-5", to_model: "claude-opus-5", reason: "capacity",
  }) + "\\n");
  const payload = resumed
    ? { content: { critique: "Compare the frozen memos." } }
    : {
        content: { findings: ["Repository and primary evidence agree."] },
        repoCitations: [{ path: process.env.FAKE_REPO_FILE, line: 1 }],
        webCitations: process.env.FAKE_CLAUDE_SPARSE === "1" ? [] : ["https://example.test/primary"],
      };
  process.stdout.write(JSON.stringify({
    type: "result", session_id: sessionId, result: JSON.stringify(payload),
    model: "claude-opus-5",
    modelUsage: { "claude-opus-5": { inputTokens: 1, outputTokens: 1, contextWindow: 1000000 } },
  }) + "\\n");
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

function stateDir(testEnv) {
  const canonical = fs.realpathSync.native(testEnv.workspaceDir);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return path.join(testEnv.env.CODEX_HOME, "plugins", "data", "cc", "state", hash);
}

function readWorkflow(testEnv, id) {
  return JSON.parse(fs.readFileSync(path.join(stateDir(testEnv), "workflows", `${id}.json`), "utf8"));
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

test("peer workflow acceptance covers aggregate surfaces, retry, lifecycle, and no workspace writes", async () => {
  const testEnv = createEnvironment();
  try {
    const before = checked(testEnv.workspaceDir, "git", ["status", "--porcelain=v1", "--untracked-files=all"]);
    const created = createPeer(testEnv);
    assert.equal(created.spawnPlan.length, 2);
    assert.equal(created.spawnPlan.every(({ fork_turns }) => fork_turns === "none"), true);

    const [codex, claude] = await Promise.all([
      runAsync(testEnv, [
        "peer-submit-memo", created.workflow.id, "--cwd", testEnv.workspaceDir,
        "--branch", "codex", "--brief-hash", created.workflow.briefHash, "--json",
      ], { input: JSON.stringify(memo(testEnv, "codex")) }),
      runAsync(testEnv, [
        "peer-claude-turn", created.workflow.id, "--cwd", testEnv.workspaceDir,
        "--brief-hash", created.workflow.briefHash, "--json",
      ]),
    ]);
    assert.equal(codex.status, 0, codex.stderr || codex.stdout);
    assert.equal(claude.status, 0, claude.stderr || claude.stdout);
    runJson(testEnv, [
      "peer-checkpoint", created.workflow.id, "--cwd", testEnv.workspaceDir,
      "--brief-hash", created.workflow.briefHash, "--json",
    ], { input: JSON.stringify({ agreements: ["same"], disagreements: [], decisionsNeeded: ["choose"] }) });

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

    runJson(testEnv, [
      "peer-resume-plan", created.workflow.id, "--cwd", testEnv.workspaceDir,
      "--continue", "--owner-session-id", "owner-b", "--json",
    ], { input: JSON.stringify({ feedback: "Prefer simple." }) });
    runJson(testEnv, [
      "peer-claude-critique", created.workflow.id, "--cwd", testEnv.workspaceDir,
      "--brief-hash", created.workflow.briefHash, "--json",
    ]);
    runJson(testEnv, [
      "peer-final", created.workflow.id, "--cwd", testEnv.workspaceDir,
      "--brief-hash", created.workflow.briefHash, "--json",
    ], { input: JSON.stringify({ recommendation: "Use the narrow path." }) });
    const finalResult = runJson(testEnv, [
      "result", created.workflow.id, "--cwd", testEnv.workspaceDir, "--json",
    ]);
    assert.equal(finalResult.workflow.currentOwnerSessionId, "owner-b");
    assert.equal(finalResult.workflow.finalResult.recommendation, "Use the narrow path.");

    const partial = createPeer(testEnv, "Partial failure retry.");
    runJson(testEnv, [
      "peer-submit-memo", partial.workflow.id, "--cwd", testEnv.workspaceDir,
      "--branch", "codex", "--brief-hash", partial.workflow.briefHash, "--json",
    ], { input: JSON.stringify(memo(testEnv, "partial-codex")) });
    const sparse = run(testEnv, [
      "peer-claude-turn", partial.workflow.id, "--cwd", testEnv.workspaceDir,
      "--brief-hash", partial.workflow.briefHash, "--json",
    ], { env: { FAKE_CLAUDE_SPARSE: "1" } });
    assert.notEqual(sparse.status, 0);
    const retry = runJson(testEnv, [
      "peer-resume-plan", partial.workflow.id, "--cwd", testEnv.workspaceDir,
      "--retry", "--owner-session-id", "owner-b", "--json",
    ]);
    assert.deepEqual(retry.work, [{ kind: "branch", id: "claude" }]);

    const lifecycle = createPeer(testEnv, "SessionEnd path.");
    const started = runJson(testEnv, [
      "workflow-start-stage", lifecycle.workflow.id, "--cwd", testEnv.workspaceDir,
      "--stage", "memo", "--branch", "codex",
      "--revision", String(lifecycle.workflow.revision), "--epoch", "0", "--json",
    ]);
    assert.equal(started.branches.codex.status, "running");
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
    const jobsDir = path.join(stateDir(testEnv), "jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(path.join(jobsDir, "peer-cancel-e2e.json"), JSON.stringify({
      id: "peer-cancel-e2e",
      status: "queued",
      jobClass: "workflow",
      workflowId: cancellable.workflow.id,
      workflowStage: "memo",
      sessionId: "owner-a",
      workspaceRoot: fs.realpathSync.native(testEnv.workspaceDir),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }), "utf8");
    const cancelled = runJson(testEnv, [
      "cancel", cancellable.workflow.id, "--cwd", testEnv.workspaceDir, "--json",
    ]);
    assert.equal(cancelled.workflow.status, "cancelled");

    const invocations = fs.readFileSync(testEnv.env.FAKE_CLAUDE_LOG, "utf8").trim()
      .split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations.every(({ args }) => !args.some((value) => value.startsWith("Agent"))), true);
    assert.equal(invocations.every(({ mcpConfig }) =>
      JSON.stringify(Object.keys(mcpConfig.mcpServers)) === JSON.stringify(["docs"])
    ), true);
    const initialWorkflow = readWorkflow(testEnv, created.workflow.id);
    assert.equal(initialWorkflow.branches.claude.payload.model.finalModel, "claude-opus-5");
    assert.equal(initialWorkflow.branches.claude.payload.model.modelFallbacks.length, 1);
    assert.deepEqual(initialWorkflow.toolManifest.map(({ toolId }) => toolId), ["mcp__docs__search"]);
    assert.equal(initialWorkflow.branches.claude.payload.repoCitations.length, 1);
    assert.equal(initialWorkflow.branches.claude.payload.webCitations.length, 1);
    const after = checked(testEnv.workspaceDir, "git", ["status", "--porcelain=v1", "--untracked-files=all"]);
    assert.equal(after, before);
  } finally {
    fs.rmSync(testEnv.rootDir, { recursive: true, force: true });
  }
});
