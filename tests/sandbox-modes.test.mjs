/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildArgs,
  SANDBOX_READ_ONLY_BASH_TOOLS,
  SANDBOX_READ_ONLY_TOOLS,
  SANDBOX_REVIEW_TOOLS,
  SANDBOX_STOP_REVIEW_TOOLS,
  SANDBOX_TEMP_DIR,
  SANDBOX_SETTINGS,
  REVIEW_MCP_SERVER_NAME,
  REVIEW_MCP_TOOL_NAMES,
  REVIEW_MCP_ALLOWED_TOOLS,
  createSandboxSettings,
  cleanupSandboxSettings,
  createReviewMcpConfig,
  cleanupReviewMcpConfig,
} from "../scripts/lib/claude-cli.mjs";
import { resolvePluginRuntimeRoot } from "../scripts/lib/codex-paths.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function argsHas(args, flag, value) {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  return value === undefined || args[idx + 1] === value;
}

function argsAllowedTools(args) {
  const tools = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allowedTools") tools.push(args[i + 1]);
  }
  return tools;
}

function withTempCodexHome(run) {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodexHome = process.env.CODEX_HOME;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sandbox-home-"));
  const codexHome = path.join(homeDir, ".codex");
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.CODEX_HOME = codexHome;
  try {
    return run({ homeDir, codexHome });
  } finally {
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile == null) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. buildArgs — read-only mode
// ---------------------------------------------------------------------------

describe("buildArgs read-only mode", () => {
  const settingsFile = "/tmp/test-sandbox.json";
  const args = buildArgs("test prompt", {
    outputFormat: "stream-json",
    permissionMode: "dontAsk",
    allowedTools: SANDBOX_READ_ONLY_TOOLS,
    settingsFile,
  });

  it("includes --permission-mode dontAsk", () => {
    assert.ok(argsHas(args, "--permission-mode", "dontAsk"));
  });

  it("includes --settings with file path", () => {
    assert.ok(argsHas(args, "--settings", settingsFile));
  });

  it("includes every read-only tool via --allowedTools", () => {
    const tools = argsAllowedTools(args);
    assert.deepEqual(tools, SANDBOX_READ_ONLY_TOOLS);
    assert.equal(tools.length, SANDBOX_READ_ONLY_TOOLS.length);
  });

  it("includes read-only Git Bash patterns instead of a wildcard git shell", () => {
    const tools = argsAllowedTools(args);
    assert.ok(tools.includes("Read"));
    assert.ok(tools.includes("Glob"));
    assert.ok(tools.includes("Grep"));
    for (const pattern of SANDBOX_READ_ONLY_BASH_TOOLS) {
      assert.ok(tools.includes(pattern), `missing ${pattern}`);
    }
    assert.ok(!tools.includes("Bash(git:*)"));
    assert.ok(tools.includes("WebSearch"));
    assert.ok(tools.includes("WebFetch"));
    assert.ok(tools.includes("Agent(explore,plan)"));
  });

  it("does NOT include Write, Edit, Bash (unrestricted), Agent (unrestricted), Skill, MCP", () => {
    const tools = argsAllowedTools(args);
    assert.ok(!tools.includes("Write"));
    assert.ok(!tools.includes("Edit"));
    assert.ok(!tools.includes("Bash"));
    assert.ok(!tools.includes("Agent"));
    assert.ok(!tools.includes("Skill"));
    assert.ok(!tools.some((t) => t.startsWith("mcp__")));
  });

  it("includes stream-json format flags", () => {
    assert.ok(argsHas(args, "--output-format", "stream-json"));
    assert.ok(args.includes("--verbose"));
    assert.ok(args.includes("--include-partial-messages"));
  });
});

// ---------------------------------------------------------------------------
// 2. buildArgs — workspace-write mode
// ---------------------------------------------------------------------------

describe("buildArgs workspace-write mode", () => {
  const settingsFile = "/tmp/test-sandbox-write.json";
  const args = buildArgs("test prompt", {
    outputFormat: "stream-json",
    permissionMode: "bypassPermissions",
    settingsFile,
    // NO allowedTools — workspace-write allows everything
  });

  it("includes --permission-mode bypassPermissions", () => {
    assert.ok(argsHas(args, "--permission-mode", "bypassPermissions"));
  });

  it("includes --settings with file path", () => {
    assert.ok(argsHas(args, "--settings", settingsFile));
  });

  it("does NOT include any --allowedTools (all tools allowed)", () => {
    const tools = argsAllowedTools(args);
    assert.equal(tools.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Sandbox settings file lifecycle
// ---------------------------------------------------------------------------

describe("sandbox settings lifecycle", () => {
  it("createSandboxSettings('read-only') creates valid JSON file", () => {
    withTempCodexHome(() => {
      const f = createSandboxSettings("read-only");
      assert.ok(f);
      assert.ok(fs.existsSync(f));
      assert.ok(
        f.startsWith(path.join(resolvePluginRuntimeRoot(), "sandbox") + path.sep),
        `expected sandbox settings under ${resolvePluginRuntimeRoot()}`
      );
      const content = JSON.parse(fs.readFileSync(f, "utf8"));
      assert.deepEqual(content, SANDBOX_SETTINGS["read-only"]);
      cleanupSandboxSettings(f);
    });
  });

  it("createSandboxSettings('workspace-write') creates valid JSON file", () => {
    withTempCodexHome(() => {
      const f = createSandboxSettings("workspace-write");
      assert.ok(f);
      assert.ok(fs.existsSync(f));
      assert.ok(
        f.startsWith(path.join(resolvePluginRuntimeRoot(), "sandbox") + path.sep),
        `expected sandbox settings under ${resolvePluginRuntimeRoot()}`
      );
      const content = JSON.parse(fs.readFileSync(f, "utf8"));
      assert.deepEqual(content, SANDBOX_SETTINGS["workspace-write"]);
      cleanupSandboxSettings(f);
    });
  });

  it("createSandboxSettings('invalid') returns null", () => {
    assert.equal(createSandboxSettings("invalid"), null);
  });

  it("cleanupSandboxSettings removes the file", () => {
    withTempCodexHome(() => {
      const f = createSandboxSettings("read-only");
      assert.ok(fs.existsSync(f));
      cleanupSandboxSettings(f);
      assert.ok(!fs.existsSync(f));
    });
  });

  it("cleanupSandboxSettings(null) does not throw", () => {
    assert.doesNotThrow(() => cleanupSandboxSettings(null));
  });
});

// ---------------------------------------------------------------------------
// 4. Sandbox settings content validation
// ---------------------------------------------------------------------------

describe("sandbox settings content", () => {
  it("read-only: sandbox enabled, allowWrite temp dir only, network unrestricted", () => {
    const s = SANDBOX_SETTINGS["read-only"];
    assert.equal(s.sandbox.enabled, true);
    assert.equal(s.sandbox.autoAllowBashIfSandboxed, false);
    assert.deepEqual(s.sandbox.filesystem.allowWrite, [SANDBOX_TEMP_DIR]);
    // network block intentionally omitted: review/adversarial-review need network
    // for WebFetch/WebSearch and the Claude CLI's own API access. Mutation
    // surfaces are closed off by removing Bash from the allowlist instead.
    assert.equal(s.sandbox.network, undefined);
  });

  it("workspace-write: sandbox enabled, allowWrite cwd+temp dir, no network", () => {
    const s = SANDBOX_SETTINGS["workspace-write"];
    assert.equal(s.sandbox.enabled, true);
    assert.equal(s.sandbox.autoAllowBashIfSandboxed, true);
    assert.deepEqual(s.sandbox.filesystem.allowWrite, [".", SANDBOX_TEMP_DIR]);
    assert.deepEqual(s.sandbox.network.allowedDomains, []);
  });

  it("workspace-write has broader write access than read-only", () => {
    assert.notDeepEqual(
      SANDBOX_SETTINGS["read-only"].sandbox.filesystem,
      SANDBOX_SETTINGS["workspace-write"].sandbox.filesystem
    );
    // read-only deliberately leaves network unset (allowed) while workspace-write
    // explicitly closes outbound network from Bash. The two modes diverge here.
    assert.notDeepEqual(
      SANDBOX_SETTINGS["read-only"].sandbox.network,
      SANDBOX_SETTINGS["workspace-write"].sandbox.network
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Mode consistency — read-only is the same for task/review/adversarial
// ---------------------------------------------------------------------------

describe("mode consistency", () => {
  it("SANDBOX_READ_ONLY_TOOLS includes the explicit read-only git Bash subset", () => {
    for (const pattern of SANDBOX_READ_ONLY_BASH_TOOLS) {
      assert.ok(SANDBOX_READ_ONLY_TOOLS.includes(pattern));
    }
  });

  it("read-only tools are read-only (no Write, Edit, Bash full)", () => {
    const writeTools = ["Write", "Edit", "Bash", "NotebookEdit", "Skill"];
    for (const t of writeTools) {
      assert.ok(
        !SANDBOX_READ_ONLY_TOOLS.includes(t),
        `${t} should not be in read-only tools`
      );
    }
  });

  it("workspace-write mode uses no allowedTools (verified via buildArgs)", () => {
    const args = buildArgs("p", { permissionMode: "bypassPermissions" });
    assert.equal(argsAllowedTools(args).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 6. Review tool surface — MCP-only git access, no Bash
// ---------------------------------------------------------------------------

describe("SANDBOX_REVIEW_TOOLS", () => {
  it("includes Read, Glob, Grep, WebSearch, WebFetch", () => {
    for (const t of ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]) {
      assert.ok(SANDBOX_REVIEW_TOOLS.includes(t), `missing ${t}`);
    }
  });

  it("does NOT include any Bash entry (Bash patterns are not strictly enforced)", () => {
    for (const t of SANDBOX_REVIEW_TOOLS) {
      assert.ok(
        !/^Bash(\(|$)/.test(t),
        `review allowlist must not contain Bash: ${t}`
      );
    }
  });

  it("does NOT include Write/Edit/MultiEdit/NotebookEdit/Task", () => {
    for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Task"]) {
      assert.ok(!SANDBOX_REVIEW_TOOLS.includes(t), `${t} must not be allowed`);
    }
  });

  it("exposes the bundled git MCP tools as mcp__<server>__<tool> entries", () => {
    for (const name of REVIEW_MCP_TOOL_NAMES) {
      const expected = `mcp__${REVIEW_MCP_SERVER_NAME}__${name}`;
      assert.ok(
        SANDBOX_REVIEW_TOOLS.includes(expected),
        `missing MCP tool entry: ${expected}`
      );
      assert.ok(REVIEW_MCP_ALLOWED_TOOLS.includes(expected));
    }
  });

  it("REVIEW_MCP_TOOL_NAMES covers diff, log, show, blame, status, grep, ls_files", () => {
    for (const expected of ["diff", "log", "show", "blame", "status", "grep", "ls_files"]) {
      assert.ok(REVIEW_MCP_TOOL_NAMES.includes(expected), `missing ${expected}`);
    }
  });
});

describe("SANDBOX_STOP_REVIEW_TOOLS", () => {
  it("uses read tools plus bundled git MCP tools without Bash", () => {
    for (const t of ["Read", "Glob", "Grep"]) {
      assert.ok(SANDBOX_STOP_REVIEW_TOOLS.includes(t), `missing ${t}`);
    }
    for (const t of SANDBOX_STOP_REVIEW_TOOLS) {
      assert.ok(
        !/^Bash(\(|$)/.test(t),
        `stop review allowlist must not contain Bash: ${t}`
      );
    }
    for (const expected of REVIEW_MCP_ALLOWED_TOOLS) {
      assert.ok(
        SANDBOX_STOP_REVIEW_TOOLS.includes(expected),
        `missing MCP tool entry: ${expected}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 7. createReviewMcpConfig
// ---------------------------------------------------------------------------

describe("createReviewMcpConfig", () => {
  it("writes a JSON file that registers the gitReview MCP server", () => {
    withTempCodexHome(() => {
      const filePath = createReviewMcpConfig("/tmp/cc-review-fake-root");
      try {
        const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
        assert.ok(content.mcpServers);
        const server = content.mcpServers[REVIEW_MCP_SERVER_NAME];
        assert.ok(server, "gitReview server must be present");
        assert.equal(typeof server.command, "string");
        assert.ok(Array.isArray(server.args));
        assert.ok(server.args.some((a) => a.endsWith("claude-companion.mjs")));
        assert.ok(server.args.includes("mcp-git"));
        assert.equal(server.env.CC_GIT_ROOT, "/tmp/cc-review-fake-root");
      } finally {
        cleanupReviewMcpConfig(filePath);
      }
    });
  });

  it("rejects missing/blank gitRoot", () => {
    withTempCodexHome(() => {
      assert.throws(() => createReviewMcpConfig(""), /gitRoot is required/);
      assert.throws(() => createReviewMcpConfig(null), /gitRoot is required/);
      assert.throws(() => createReviewMcpConfig(undefined), /gitRoot is required/);
    });
  });
});

// ---------------------------------------------------------------------------
// 8. buildArgs — review mode (mcpConfigFile + strictMcpConfig + new allowlist)
// ---------------------------------------------------------------------------

describe("buildArgs review mode", () => {
  it("emits --mcp-config when mcpConfigFile is provided", () => {
    const args = buildArgs("p", { mcpConfigFile: "/tmp/mcp.json" });
    assert.ok(argsHas(args, "--mcp-config", "/tmp/mcp.json"));
  });

  it("emits --strict-mcp-config when strictMcpConfig is set", () => {
    const args = buildArgs("p", { strictMcpConfig: true });
    assert.ok(args.includes("--strict-mcp-config"));
  });

  it("can express the review allowlist via --allowedTools per entry", () => {
    const args = buildArgs("p", { allowedTools: SANDBOX_REVIEW_TOOLS });
    const allowed = argsAllowedTools(args);
    assert.deepEqual([...allowed].sort(), [...SANDBOX_REVIEW_TOOLS].sort());
  });
});
