/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function checked(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

/**
 * @param {string} filePath
 * @param {string} name
 * @param {Array<{name: string, description: string, annotations?: {readOnlyHint?: boolean, destructiveHint?: boolean}}>} [tools]
 */
function writeFakeMcp(filePath, name, tools = [{
  name: "search",
  description: "Search public documentation",
  annotations: { readOnlyHint: true },
}]) {
  fs.writeFileSync(filePath, `#!/usr/bin/env node
import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  const result = request.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(name)}, version: "1" } }
    : { tools: ${JSON.stringify(tools)} };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`, "utf8");
}

function writeFakeClaude(filePath) {
  fs.writeFileSync(filePath, `#!${process.execPath}
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
  const tool = (name, input) => {
  const id = "toolu-" + name;
  process.stdout.write(JSON.stringify({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "content_block_start", content_block: { type: "tool_use", name, input, ...(process.env.FAKE_SEARCH_RECEIPTS === "1" ? { id } : {}) } },
  }) + "\\n");
  if (process.env.FAKE_SEARCH_RECEIPTS === "1") process.stdout.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "result", is_error: false }] } }) + "\\n");
  };
  tool("Read", { file_path: process.env.FAKE_REPO_FILE });
  if (process.env.FAKE_CLAUDE_SPARSE !== "1") tool(
    process.env.FAKE_CLAUDE_BRAVE === "1" ? "mcp__brave-search__brave_web_search" : "WebSearch",
    { query: "primary docs" }
  );
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
    type: "result", session_id: sessionId, subtype: "success", is_error: false,
    structured_output: payload, result: JSON.stringify(payload),
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


export { checked, createEnvironment, writeFakeMcp };
