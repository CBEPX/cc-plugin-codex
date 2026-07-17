/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  TOOL_DEFINITIONS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  handleMcpRequest,
} from "../scripts/lib/mcp-git.mjs";

// ---------------------------------------------------------------------------
// Fixture: a tiny git repo with two commits
// ---------------------------------------------------------------------------

let repoRoot;

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr ?? result.stdout ?? "unknown"}`
    );
  }
  return result;
}

before(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-mcp-git-test-"));
  git(repoRoot, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repoRoot, "hello.txt"), "hello\nworld\n");
  fs.writeFileSync(path.join(repoRoot, "guide.md"), "# Guide\nfirst line.\n");
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-q", "-m", "initial commit"]);
  fs.writeFileSync(path.join(repoRoot, "hello.txt"), "hello\nworld\nadded line\n");
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-q", "-m", "tweak hello"]);
});

after(() => {
  if (repoRoot) {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

describe("handleMcpRequest — initialize / tools/list", () => {
  it("responds to initialize with server info + capabilities", () => {
    const res = handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      "/tmp"
    );
    assert.equal(res.id, 1);
    assert.equal(res.result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(res.result.serverInfo.name, MCP_SERVER_NAME);
    assert.ok(res.result.capabilities.tools !== undefined);
  });

  it("lists all expected tools", () => {
    const res = handleMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      "/tmp"
    );
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "blame",
      "diff",
      "grep",
      "log",
      "ls_files",
      "show",
      "status",
    ]);
    for (const tool of res.result.tools) {
      assert.equal(typeof tool.description, "string");
      assert.equal(tool.inputSchema.type, "object");
    }
  });

  it("returns method-not-found for unknown methods", () => {
    const res = handleMcpRequest(
      { jsonrpc: "2.0", id: 3, method: "wat/bogus" },
      "/tmp"
    );
    assert.equal(res.error.code, -32601);
  });

  it("returns null (no response) for the initialized notification", () => {
    const res = handleMcpRequest(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      "/tmp"
    );
    assert.equal(res, null);
  });

  it("returns Invalid Request (-32600) when payload is not a JSON object", () => {
    for (const bogus of [null, [], "string", 42, true]) {
      const res = handleMcpRequest(bogus, "/tmp");
      assert.equal(res.error.code, -32600);
      assert.equal(res.id, null);
    }
  });
});

// ---------------------------------------------------------------------------
// Tool handlers (round-trip via handleMcpRequest)
// ---------------------------------------------------------------------------

function callTool(name, args = {}) {
  return handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name, arguments: args },
    },
    repoRoot
  );
}

describe("tool: status", () => {
  it("returns clean working tree text", () => {
    const res = callTool("status", {});
    assert.equal(res.result.isError, false);
    assert.match(res.result.content[0].text, /clean|nothing to commit/i);
  });

  it("returns porcelain output", () => {
    fs.writeFileSync(path.join(repoRoot, "untracked.txt"), "x");
    try {
      const res = callTool("status", { porcelain: true });
      assert.match(res.result.content[0].text, /\?\? untracked\.txt/);
    } finally {
      fs.unlinkSync(path.join(repoRoot, "untracked.txt"));
    }
  });
});

describe("tool: log", () => {
  it("returns oneline log limited by limit", () => {
    const res = callTool("log", { limit: 1, format: "oneline" });
    assert.equal(res.result.isError, false);
    const lines = res.result.content[0].text.trim().split("\n");
    assert.equal(lines.length, 1);
  });

  it("rejects unknown formats", () => {
    const res = callTool("log", { format: "fancy" });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /format must be/);
  });

  it("rejects refs with shell metacharacters", () => {
    const res = callTool("log", { refs: "HEAD; rm -rf /" });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /refs/);
  });

  it("rejects refs that start with '-' (would be interpreted as a git flag)", () => {
    for (const ref of ["-p", "--ext-diff", "--help", "-"]) {
      const res = callTool("log", { refs: ref });
      assert.equal(res.result.isError, true, `should reject ${ref}`);
      assert.match(res.result.content[0].text, /flag|-/);
    }
  });

  it("accepts dotted ref ranges", () => {
    const res = callTool("log", { refs: "HEAD~1..HEAD", limit: 5 });
    assert.equal(res.result.isError, false);
  });
});

describe("tool: diff", () => {
  it("returns diff between HEAD~1 and HEAD", () => {
    const res = callTool("diff", { refs: "HEAD~1..HEAD" });
    assert.equal(res.result.isError, false);
    assert.match(res.result.content[0].text, /\+added line/);
  });

  it("stat: true returns --stat summary", () => {
    const res = callTool("diff", { refs: "HEAD~1..HEAD", stat: true });
    assert.match(res.result.content[0].text, /hello\.txt/);
    assert.doesNotMatch(res.result.content[0].text, /\+added line/);
  });

  it("rejects paths that escape the git root", () => {
    const res = callTool("diff", { paths: ["../escape"] });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /escape|forbidden/i);
  });

  it("rejects paths that look like flags", () => {
    const res = callTool("diff", { paths: ["--exec=evil"] });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /flag/i);
  });

  it("rejects paths with shell metacharacters", () => {
    const res = callTool("diff", { paths: ["a;rm"] });
    assert.equal(res.result.isError, true);
  });
});

describe("tool: show", () => {
  it("requires ref", () => {
    const res = callTool("show", {});
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /ref/);
  });

  it("shows HEAD content with stat", () => {
    const res = callTool("show", { ref: "HEAD", stat: true });
    assert.equal(res.result.isError, false);
    assert.match(res.result.content[0].text, /hello\.txt/);
  });
});

describe("tool: grep", () => {
  it("finds matches across tracked files", () => {
    const res = callTool("grep", { pattern: "world" });
    assert.equal(res.result.isError, false);
    assert.match(res.result.content[0].text, /hello\.txt:\d+:world/);
  });

  it("requires a non-empty pattern", () => {
    const res = callTool("grep", { pattern: "" });
    assert.equal(res.result.isError, true);
  });

  it("rejects null bytes in pattern", () => {
    const res = callTool("grep", { pattern: `a${String.fromCharCode(0)}b` });
    assert.equal(res.result.isError, true);
  });
});

describe("tool: blame", () => {
  it("requires path", () => {
    const res = callTool("blame", {});
    assert.equal(res.result.isError, true);
  });

  it("returns blame output", () => {
    const res = callTool("blame", { path: "hello.txt" });
    assert.equal(res.result.isError, false);
    assert.match(res.result.content[0].text, /hello/);
  });

  it("accepts numeric range", () => {
    const res = callTool("blame", { path: "hello.txt", range: "1,2" });
    assert.equal(res.result.isError, false);
  });

  it("rejects non-numeric range", () => {
    const res = callTool("blame", { path: "hello.txt", range: "a,b" });
    assert.equal(res.result.isError, true);
  });
});

describe("tool: ls_files", () => {
  it("lists tracked files in the worktree", () => {
    const res = callTool("ls_files", {});
    assert.equal(res.result.isError, false);
    const text = res.result.content[0].text;
    assert.match(text, /hello\.txt/);
    assert.match(text, /guide\.md/);
  });
});

// ---------------------------------------------------------------------------
// Tool registry shape
// ---------------------------------------------------------------------------

describe("TOOL_DEFINITIONS", () => {
  it("every tool has a name, description, and inputSchema", () => {
    for (const t of TOOL_DEFINITIONS) {
      assert.equal(typeof t.name, "string");
      assert.equal(typeof t.description, "string");
      assert.equal(t.inputSchema.type, "object");
    }
  });
});

// ---------------------------------------------------------------------------
// Stdio framing — runMcpGitServer end-to-end via the companion subcommand
// ---------------------------------------------------------------------------

describe("runMcpGitServer stdio framing", () => {
  const companion = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "scripts",
    "claude-companion.mjs"
  );

  function runServer(inputLines, env = {}) {
    const child = spawnSync(process.execPath, [companion, "mcp-git"], {
      input: inputLines.map((line) => `${line}\n`).join(""),
      encoding: "utf8",
      env: { ...process.env, CC_GIT_ROOT: repoRoot, ...env },
      timeout: 10_000,
    });
    return child;
  }

  it("emits a response for a valid initialize request", () => {
    const child = runServer([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    ]);
    assert.equal(child.status, 0);
    const lines = child.stdout.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const res = JSON.parse(lines[0]);
    assert.equal(res.id, 1);
    assert.ok(res.result?.serverInfo);
  });

  it("emits an Invalid Request error even when the payload is not an object", () => {
    const child = runServer(["[1,2,3]", "true", "\"hello\"", "42"]);
    assert.equal(child.status, 0);
    const lines = child.stdout.trim().split("\n").filter(Boolean);
    // One -32600 response per malformed payload.
    assert.equal(lines.length, 4);
    for (const line of lines) {
      const res = JSON.parse(line);
      assert.equal(res.error.code, -32600);
      assert.equal(res.id, null);
    }
  });

  it("emits Parse error for non-JSON lines", () => {
    const child = runServer(["this is not json"]);
    assert.equal(child.status, 0);
    const res = JSON.parse(child.stdout.trim());
    assert.equal(res.error.code, -32700);
  });

  it("does not respond to notifications (no id)", () => {
    const child = runServer([
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ]);
    assert.equal(child.status, 0);
    assert.equal(child.stdout.trim(), "");
  });

  it("exits non-zero when CC_GIT_ROOT is missing", () => {
    const child = spawnSync(process.execPath, [companion, "mcp-git"], {
      input: "",
      encoding: "utf8",
      env: { ...process.env, CC_GIT_ROOT: "" },
      timeout: 5_000,
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /CC_GIT_ROOT/);
  });
});
