/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import "./test-env.mjs";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SANDBOX_STOP_REVIEW_TOOLS } from "../scripts/lib/claude-cli.mjs";
import { getWorkingTreeFingerprint } from "../scripts/lib/git.mjs";
import { getProcessIdentity } from "../scripts/lib/process.mjs";
import { SESSION_ID_ENV } from "../scripts/lib/tracked-jobs.mjs";

const PROJECT_ROOT = path.resolve(
  fileURLToPath(new URL("../", import.meta.url))
);
const SESSION_HOOK = path.join(
  PROJECT_ROOT,
  "hooks",
  "session-lifecycle-hook.mjs"
);
const HOOKS_MANIFEST = path.join(PROJECT_ROOT, "hooks", "hooks.json");
const STOP_HOOK = path.join(
  PROJECT_ROOT,
  "hooks",
  "stop-review-gate-hook.mjs"
);
const UNREAD_HOOK = path.join(
  PROJECT_ROOT,
  "hooks",
  "unread-result-hook.mjs"
);
const PLUGIN_CONFIG_BLOCK = '[plugins."cc@local-plugins"]\nenabled = true\n';

function createFakeClaudeBinary(binDir) {
  const claudePath = path.join(binDir, "claude");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);

if (process.env.CLAUDE_ARGS_FILE) {
  fs.writeFileSync(process.env.CLAUDE_ARGS_FILE, JSON.stringify(args, null, 2) + "\\n", "utf8");
}
if (process.env.CLAUDE_MCP_CONFIG_FILE) {
  const mcpConfigIndex = args.indexOf("--mcp-config");
  if (mcpConfigIndex >= 0 && args[mcpConfigIndex + 1]) {
    fs.copyFileSync(args[mcpConfigIndex + 1], process.env.CLAUDE_MCP_CONFIG_FILE);
  }
}

  if (args[0] === "-p") {
  if (process.env.CLAUDE_SILENT_FAIL === "1") {
    process.exit(7);
  }
  if (process.env.CLAUDE_UNAUTHENTICATED === "1") {
    process.stderr.write("Not logged in. Run claude auth login.\\n");
    process.exit(1);
  }
  if (process.env.CLAUDE_EMPTY_RESULT === "1") {
    process.stdout.write(JSON.stringify({
      type: "result",
      session_id: "hook-session-result",
      subtype: "success",
      is_error: false,
      result: ""
    }) + "\\n");
    process.exit(0);
  }
  if (process.env.CLAUDE_BLOCK_RESULT === "1") {
    process.stdout.write(JSON.stringify({
      type: "result",
      session_id: "hook-session-result",
      subtype: "success",
      is_error: false,
      result: "BLOCK: fix the failing regression"
    }) + "\\n");
    process.exit(0);
  }
  if (process.env.CLAUDE_BLOCK_REASON_FILE) {
    process.stdout.write(JSON.stringify({
      type: "result",
      session_id: "hook-session-result",
      subtype: "success",
      is_error: false,
      result: "BLOCK: " + fs.readFileSync(process.env.CLAUDE_BLOCK_REASON_FILE, "utf8")
    }) + "\\n");
    process.exit(0);
  }
  if (process.env.CLAUDE_FAIL_STDERR_FILE) {
    process.stderr.write(fs.readFileSync(process.env.CLAUDE_FAIL_STDERR_FILE, "utf8"));
    process.exit(3);
  }
  if (process.env.CLAUDE_PREFIXED_BLOCK_RESULT === "1") {
    process.stdout.write(JSON.stringify({
      type: "result",
      session_id: "hook-session-result",
      subtype: "success",
      is_error: false,
      result: "Review complete.\\nBLOCK: fix the failing regression"
    }) + "\\n");
    process.exit(0);
  }
  if (process.env.CLAUDE_PREFIXED_ALLOW_RESULT === "1") {
    process.stdout.write(JSON.stringify({
      type: "stream_event",
      session_id: "hook-session-result",
      event: {
        delta: {
          type: "text_delta",
          text: "Let me verify the actual code changes from that turn.ALLOW: hook ok"
        }
      }
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "result",
      session_id: "hook-session-result",
      subtype: "success",
      is_error: false,
      result: "ALLOW: hook ok"
    }) + "\\n");
    process.exit(0);
  }
  if (process.env.CLAUDE_UNEXPECTED_RESULT === "1") {
    process.stdout.write(JSON.stringify({
      type: "result",
      session_id: "hook-session-result",
      subtype: "success",
      is_error: false,
      result: "MAYBE: hook unsure"
    }) + "\\n");
    process.exit(0);
  }
  if (process.env.CLAUDE_UNKNOWN_NO_TERMINAL === "1") {
    process.stdout.write(JSON.stringify({
      type: "stream_event",
      session_id: "hook-session-result",
      event: {
        delta: {
          type: "text_delta",
          text: "ALLOW: partial"
        }
      }
    }) + "\\n");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    type: "result",
    session_id: "hook-session-result",
    subtype: "success",
    is_error: false,
    result: "ALLOW: hook ok"
  }) + "\\n");
  process.exit(0);
}

if (args[0] === "--version") {
  process.stdout.write("2.1.220 (Claude Code)\\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write("authenticated\\n");
  process.exit(0);
}

process.stderr.write("unexpected args: " + JSON.stringify(args) + "\\n");
process.exit(2);
`;

  fs.writeFileSync(claudePath, source, "utf8");
  fs.chmodSync(claudePath, 0o755);
}

function runGitChecked(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function initGitRepo(workspaceDir) {
  runGitChecked(["init"], workspaceDir);
  runGitChecked(["config", "user.name", "Codex Test"], workspaceDir);
  runGitChecked(["config", "user.email", "codex@example.com"], workspaceDir);
  fs.writeFileSync(path.join(workspaceDir, "tracked.txt"), "base\n", "utf8");
  runGitChecked(["add", "tracked.txt"], workspaceDir);
  runGitChecked(["commit", "-m", "init"], workspaceDir);
}

function createHookEnvironment(options = {}) {
  const {
    createClaude = true,
    initGit = true,
  } = options;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-hooks-test-"));
  const homeDir = path.join(rootDir, "home");
  const binDir = path.join(rootDir, "bin");
  const workspaceDir = path.join(rootDir, "workspace");

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".codex", "plugins", "cache", "local-plugins", "cc", "local"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), PLUGIN_CONFIG_BLOCK, "utf8");
  if (createClaude) {
    createFakeClaudeBinary(binDir);
  }
  if (initGit) {
    initGitRepo(workspaceDir);
  }

  return {
    rootDir,
    binDir,
    homeDir,
    workspaceDir,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODEX_HOME: path.join(homeDir, ".codex"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      [SESSION_ID_ENV]: "",
    },
  };
}

function cleanupHookEnvironment(testEnv) {
  fs.rmSync(testEnv.rootDir, { recursive: true, force: true });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stateDirFor(homeDir, workspaceDir) {
  const realWorkspace = fs.realpathSync.native(workspaceDir);
  const workspaceHash = createHash("sha256")
    .update(realWorkspace)
    .digest("hex")
    .slice(0, 12);
  return path.join(
    homeDir,
    ".codex",
    "plugins",
    "data",
    "cc",
    "state",
    workspaceHash
  );
}

function writePeerWorkflow(testEnv, workflow) {
  const workflowsDir = path.join(
    stateDirFor(testEnv.homeDir, testEnv.workspaceDir),
    "workflows"
  );
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowsDir, `${workflow.id}.json`),
    `${JSON.stringify(workflow, null, 2)}\n`,
    "utf8"
  );
}

function readPeerWorkflow(testEnv, workflowId) {
  return JSON.parse(fs.readFileSync(path.join(
    stateDirFor(testEnv.homeDir, testEnv.workspaceDir),
    "workflows",
    `${workflowId}.json`
  ), "utf8"));
}

function unfinishedPeerWorkflow(testEnv, id, sessionId, options = {}) {
  const workspaceRoot = fs.realpathSync.native(testEnv.workspaceDir);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const fingerprint = getWorkingTreeFingerprint(workspaceRoot);
  return {
    version: 1,
    id,
    mode: "design",
    status: options.status ?? "running",
    phase: "memo",
    revision: 1,
    epoch: 0,
    workspaceRoot,
    fingerprint,
    brief: `Lifecycle cleanup for ${id}.`,
    briefHash: createHash("sha256").update(`Lifecycle cleanup for ${id}.`).digest("hex"),
    originSessionId: sessionId,
    currentOwnerSessionId: sessionId,
    modelManifest: [],
    toolManifest: [],
    stages: {},
    branches: {
      codex: {
        status: "running",
        payload: null,
        failureReason: null,
        attempts: 1,
        stage: "memo",
        startFingerprint: fingerprint,
        startedAt: timestamp,
      },
    },
    branchAttempts: [],
    claudeSessionId: null,
    checkpoint: null,
    feedback: null,
    critique: null,
    finalResult: options.status === "completed" ? { summary: "sealed" } : null,
    failureReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function runHook(scriptPath, args, input, env, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: PROJECT_ROOT,
    env,
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: options.timeout,
  });
  assert.equal(
    result.signal,
    null,
    result.error?.message || result.stderr || result.stdout
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function enableReviewGate(testEnv) {
  const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "config.json"),
    `${JSON.stringify({ version: 1, stopReviewGate: true }, null, 2)}\n`,
    "utf8"
  );
  writeStaleTurnBaseline(testEnv, "hook-session");
}

function readCurrentSessionMarker(testEnv) {
  return JSON.parse(
    fs.readFileSync(
      path.join(stateDirFor(testEnv.homeDir, testEnv.workspaceDir), "current-session.json"),
      "utf8"
    )
  );
}

function writeStateJob(testEnv, jobId, payload) {
  const jobsDir = path.join(stateDirFor(testEnv.homeDir, testEnv.workspaceDir), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobsDir, `${jobId}.json`),
    JSON.stringify({ ...payload, updatedAt: payload.updatedAt ?? payload.createdAt }, null, 2) + "\n",
    "utf8"
  );
}

function writePendingSessionCleanup(testEnv, sessionId) {
  const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, `session-cleanup-pending-${sessionId}.json`),
    JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }),
    "utf8"
  );
}

function readStateJob(testEnv, jobId) {
  return JSON.parse(
    fs.readFileSync(
      path.join(stateDirFor(testEnv.homeDir, testEnv.workspaceDir), "jobs", `${jobId}.json`),
      "utf8"
    )
  );
}

function readStopReviewSnapshot(testEnv) {
  return JSON.parse(
    fs.readFileSync(
      path.join(stateDirFor(testEnv.homeDir, testEnv.workspaceDir), "stop-review-last.json"),
      "utf8"
    )
  );
}

function writeTurnBaselineSnapshot(testEnv, sessionId, fingerprint) {
  const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, `turn-baseline.${sessionId}.json`),
    JSON.stringify(
      {
        sessionId,
        cwd: testEnv.workspaceDir,
        workspaceRoot: testEnv.workspaceDir,
        capturedAt: "2026-04-04T01:00:00Z",
        fingerprint,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

function writeStaleTurnBaseline(testEnv, sessionId) {
  writeTurnBaselineSnapshot(testEnv, sessionId, {
    signature: "stale-baseline",
  });
}

// Literal expectations keep these tests independent of the production constant.
const EXPECTED_STOP_REVIEW_MCP_SERVER = "gitReview";
const EXPECTED_STOP_REVIEW_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "mcp__gitReview__diff",
  "mcp__gitReview__log",
  "mcp__gitReview__show",
  "mcp__gitReview__blame",
  "mcp__gitReview__status",
  "mcp__gitReview__grep",
  "mcp__gitReview__ls_files",
];

function readAllowedTools(claudeArgs) {
  const allowedTools = [];
  for (let i = 0; i < claudeArgs.length; i++) {
    if (claudeArgs[i] === "--allowedTools") {
      allowedTools.push(claudeArgs[i + 1]);
    }
  }
  return allowedTools;
}

function runStopHookCapturingClaude(testEnv, cwd, extraEnv = {}) {
  const argsFile = path.join(testEnv.rootDir, "claude-args.json");
  const mcpConfigCaptureFile = path.join(testEnv.rootDir, "claude-mcp-config.json");
  const result = runHook(
    STOP_HOOK,
    [],
    {
      cwd,
      session_id: "hook-session",
      last_assistant_message: "review me",
    },
    {
      ...testEnv.env,
      CLAUDE_ARGS_FILE: argsFile,
      CLAUDE_MCP_CONFIG_FILE: mcpConfigCaptureFile,
      ...extraEnv,
    }
  );
  const claudeArgs = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  return { result, claudeArgs, mcpConfigCaptureFile };
}

function assertStrictGitMcpDeliveredAndCleaned(testEnv, claudeArgs, mcpConfigCaptureFile, expectedGitRoot) {
  const mcpConfigIndex = claudeArgs.indexOf("--mcp-config");
  assert.ok(mcpConfigIndex >= 0, "stop review must pass --mcp-config");
  assert.ok(claudeArgs.includes("--strict-mcp-config"), "stop review must pass --strict-mcp-config");
  assert.ok(fs.existsSync(mcpConfigCaptureFile), "Claude must receive a readable MCP config");

  const capturedMcpConfig = JSON.parse(fs.readFileSync(mcpConfigCaptureFile, "utf8"));
  assert.deepEqual(Object.keys(capturedMcpConfig.mcpServers), [EXPECTED_STOP_REVIEW_MCP_SERVER]);
  const server = capturedMcpConfig.mcpServers[EXPECTED_STOP_REVIEW_MCP_SERVER];
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args, [
    path.join(PROJECT_ROOT, "scripts", "claude-companion.mjs"),
    "mcp-git",
  ]);
  assert.equal(
    fs.realpathSync.native(server.env.CC_GIT_ROOT),
    fs.realpathSync.native(expectedGitRoot)
  );

  assert.equal(fs.existsSync(claudeArgs[mcpConfigIndex + 1]), false);
  const mcpRuntimeDir = path.join(testEnv.homeDir, ".codex", "plugins", "data", "cc", "runtime", "mcp");
  const leftovers = fs.existsSync(mcpRuntimeDir) ? fs.readdirSync(mcpRuntimeDir) : [];
  assert.deepEqual(leftovers, []);
}

describe("hooks", () => {
  it("stop-review hook uses read-only sandbox and strict git MCP when review gate is enabled", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );

      const argsFile = path.join(testEnv.rootDir, "claude-args.json");
      const mcpConfigCaptureFile = path.join(testEnv.rootDir, "claude-mcp-config.json");
      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_ARGS_FILE: argsFile,
          CLAUDE_MCP_CONFIG_FILE: mcpConfigCaptureFile,
        }
      );

      assert.equal(result.stdout.trim(), "");
      assert.match(result.stderr, /stop-time review passed/i);
      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "allow");
      assert.equal(snapshot.claudeInvoked, true);
      assert.equal(snapshot.sessionId, null);
      assert.equal(snapshot.hasLastAssistantMessage, true);
      const claudeArgs = JSON.parse(fs.readFileSync(argsFile, "utf8"));
      const permissionModeIndex = claudeArgs.indexOf("--permission-mode");
      assert.ok(permissionModeIndex >= 0);
      assert.equal(claudeArgs[permissionModeIndex + 1], "dontAsk");
      assert.ok(claudeArgs.includes("--settings"));

      const allowedTools = readAllowedTools(claudeArgs);
      assert.deepEqual(allowedTools, EXPECTED_STOP_REVIEW_TOOLS);
      assert.deepEqual(allowedTools, SANDBOX_STOP_REVIEW_TOOLS);
      for (const allowedTool of allowedTools) {
        assert.ok(
          !/^Bash(\(|$)/.test(allowedTool),
          `stop review allowlist must not contain Bash: ${allowedTool}`
        );
      }
      // --allowedTools alone leaves every built-in exposed to inherited user
      // permission rules; --tools must restrict the built-in set itself.
      assert.equal(claudeArgs.filter((arg) => arg === "--tools").length, 1);
      assert.equal(claudeArgs[claudeArgs.indexOf("--tools") + 1], "Read,Glob,Grep");

      // The gate inherits the user's Claude model and effort.
      for (const forcedFlag of ["--model", "--fallback-model", "--effort"]) {
        assert.equal(claudeArgs.includes(forcedFlag), false, `unexpected ${forcedFlag}`);
      }

      assertStrictGitMcpDeliveredAndCleaned(
        testEnv,
        claudeArgs,
        mcpConfigCaptureFile,
        testEnv.workspaceDir
      );
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook removes the git MCP config after ALLOW, BLOCK and failed reviews", async (t) => {
    for (const scenario of [
      { name: "allow", env: {}, decision: null },
      { name: "block", env: { CLAUDE_BLOCK_RESULT: "1" }, decision: "block" },
      { name: "failed", env: { CLAUDE_SILENT_FAIL: "1" }, decision: "block" },
    ]) {
      await t.test(scenario.name, () => {
        const testEnv = createHookEnvironment();
        try {
          enableReviewGate(testEnv);
          const { result, claudeArgs, mcpConfigCaptureFile } = runStopHookCapturingClaude(
            testEnv,
            testEnv.workspaceDir,
            scenario.env
          );

          if (scenario.decision) {
            assert.equal(JSON.parse(result.stdout).decision, scenario.decision);
          } else {
            assert.equal(result.stdout.trim(), "");
          }
          assertStrictGitMcpDeliveredAndCleaned(
            testEnv,
            claudeArgs,
            mcpConfigCaptureFile,
            testEnv.workspaceDir
          );
        } finally {
          cleanupHookEnvironment(testEnv);
        }
      });
    }
  });

  it("stop-review hook scopes git MCP to the linked worktree that contains cwd", () => {
    const testEnv = createHookEnvironment();

    try {
      const linkedWorktreeDir = path.join(testEnv.rootDir, "linked-worktree");
      runGitChecked(["worktree", "add", "-b", "linked", linkedWorktreeDir], testEnv.workspaceDir);
      const nestedCwd = path.join(linkedWorktreeDir, "nested");
      fs.mkdirSync(nestedCwd);
      enableReviewGate({ ...testEnv, workspaceDir: linkedWorktreeDir });

      const { claudeArgs, mcpConfigCaptureFile } = runStopHookCapturingClaude(testEnv, nestedCwd);

      assertStrictGitMcpDeliveredAndCleaned(
        testEnv,
        claudeArgs,
        mcpConfigCaptureFile,
        linkedWorktreeDir
      );
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook records a skipped snapshot when the review gate is disabled", () => {
    const testEnv = createHookEnvironment({
      createClaude: false,
      initGit: false,
    });

    try {
      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        testEnv.env
      );

      assert.equal(result.stdout.trim(), "");
      assert.equal(result.stderr.trim(), "");

      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "skipped_config_disabled");
      assert.equal(snapshot.claudeInvoked, false);
      assert.equal(snapshot.sessionId, "hook-session");
      assert.equal(snapshot.hasLastAssistantMessage, true);
      assert.match(snapshot.reason ?? "", /disabled/i);
      assert.equal(snapshot.runningTaskNote, undefined);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook skips Claude when the latest turn made no net edits", async () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );

      const { getWorkingTreeFingerprint } = await import("../scripts/lib/git.mjs");
      const fingerprint = getWorkingTreeFingerprint(testEnv.workspaceDir);
      writeTurnBaselineSnapshot(testEnv, "hook-session", fingerprint);

      const argsFile = path.join(testEnv.rootDir, "claude-args.json");
      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_ARGS_FILE: argsFile,
        }
      );

      assert.equal(result.stdout.trim(), "");
      assert.match(result.stderr, /most recent turn made no net edits/i);
      assert.ok(!fs.existsSync(argsFile), "no-edit turn should skip Claude invocation");

      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "skipped_no_turn_edits");
      assert.equal(snapshot.claudeInvoked, false);
      assert.equal(
        snapshot.baselineFingerprint?.signature,
        snapshot.currentFingerprint?.signature
      );
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook skips Claude when no user turn was recorded", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );
      const argsFile = path.join(testEnv.rootDir, "claude-args.json");

      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "headless-session",
          last_assistant_message: "review me",
        },
        { ...testEnv.env, CLAUDE_ARGS_FILE: argsFile }
      );

      assert.equal(result.stdout.trim(), "");
      assert.match(result.stderr, /no user turn was recorded/i);
      assert.equal(fs.existsSync(argsFile), false);
      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "skipped_no_turn_baseline");
      assert.equal(snapshot.claudeInvoked, false);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("records baseline capture failures and lets Stop run the review", () => {
    const testEnv = createHookEnvironment();

    try {
      enableReviewGate(testEnv);
      runHook(
        UNREAD_HOOK,
        [],
        {
          hook_event_name: "UserPromptSubmit",
          cwd: testEnv.workspaceDir,
          session_id: "capture-failed-session",
          prompt: "edit something",
        },
        {
          ...testEnv.env,
          PATH: testEnv.binDir,
        }
      );

      const baseline = JSON.parse(
        fs.readFileSync(
          path.join(
            stateDirFor(testEnv.homeDir, testEnv.workspaceDir),
            "turn-baseline.capture-failed-session.json"
          ),
          "utf8"
        )
      );
      assert.equal(baseline.fingerprint, null);
      assert.match(baseline.captureError, /git/i);

      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "capture-failed-session",
          last_assistant_message: "review me",
        },
        testEnv.env
      );
      assert.equal(result.stdout.trim(), "");
      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "allow");
      assert.equal(snapshot.claudeInvoked, true);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session lifecycle hook resolves queued session jobs on SessionEnd", () => {
    const testEnv = createHookEnvironment();

    try {
      writeStateJob(testEnv, "queued-hook-job", {
        id: "queued-hook-job",
        status: "queued",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
      });

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
        },
        testEnv.env
      );

      const job = readStateJob(testEnv, "queued-hook-job");
      assert.equal(job.status, "cancelled");
      assert.equal(job.phase, "cancelled");
      assert.equal(job.pid, null);
      assert.match(job.errorMessage ?? "", /session ended/i);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("SessionEnd marks only unfinished owned peer work retryable", () => {
    const testEnv = createHookEnvironment();
    try {
      const workspaceRoot = fs.realpathSync.native(testEnv.workspaceDir);
      const fingerprint = getWorkingTreeFingerprint(workspaceRoot);
      const timestamp = new Date().toISOString();
      writePeerWorkflow(testEnv, {
        version: 1,
        id: "workflow-session-end",
        mode: "design",
        status: "running",
        phase: "memo",
        revision: 1,
        epoch: 0,
        workspaceRoot,
        fingerprint,
        brief: "Keep completed peer evidence.",
        briefHash: createHash("sha256").update("Keep completed peer evidence.").digest("hex"),
        originSessionId: "hook-session",
        currentOwnerSessionId: "hook-session",
        modelManifest: [],
        toolManifest: [],
        stages: {
          checkpoint: {
            status: "running",
            payload: null,
            failureReason: null,
            attempts: 1,
            stage: "checkpoint",
            startFingerprint: fingerprint,
            startedAt: timestamp,
          },
        },
        branches: {
          codex: {
            status: "running",
            payload: null,
            failureReason: null,
            attempts: 1,
            stage: "memo",
            startFingerprint: fingerprint,
            startedAt: timestamp,
          },
          claude: {
            status: "completed",
            payload: { content: { finding: "frozen" } },
            failureReason: null,
            attempts: 1,
            completedAt: timestamp,
          },
        },
        branchAttempts: [],
        claudeSessionId: "claude-owned",
        checkpoint: null,
        feedback: null,
        critique: null,
        finalResult: null,
        failureReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        { cwd: testEnv.workspaceDir, session_id: "hook-session" },
        testEnv.env
      );

      const workflow = readPeerWorkflow(testEnv, "workflow-session-end");
      assert.equal(workflow.status, "incomplete");
      assert.equal(workflow.branches.codex.status, "retryable_failed");
      assert.equal(workflow.branches.codex.failureReason, "SESSION_ENDED");
      assert.equal(workflow.branches.claude.status, "completed");
      assert.equal(workflow.stages.checkpoint.status, "retryable_failed");
      assert.equal(workflow.stages.checkpoint.failureReason, "SESSION_ENDED");
      assert.deepEqual(workflow.branches.claude.payload, {
        content: { finding: "frozen" },
      });
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("SessionEnd invalidates peer reservations whose workers never started", () => {
    const testEnv = createHookEnvironment();
    try {
      const workspaceRoot = fs.realpathSync.native(testEnv.workspaceDir);
      const fingerprint = getWorkingTreeFingerprint(workspaceRoot);
      const timestamp = new Date().toISOString();
      const reserved = (label) => ({
        status: "pending",
        payload: null,
        failureReason: null,
        attempts: 0,
        attemptReservation: {
          epoch: 0,
          leaseDigest: createHash("sha256").update(label).digest("hex"),
          reservedAt: timestamp,
        },
      });
      writePeerWorkflow(testEnv, {
        version: 1,
        id: "workflow-session-end-never-started",
        mode: "design",
        status: "queued",
        phase: "queued",
        revision: 1,
        epoch: 0,
        workspaceRoot,
        fingerprint,
        brief: "Invalidate never-started workers.",
        briefHash: createHash("sha256").update("Invalidate never-started workers.").digest("hex"),
        originSessionId: "hook-session",
        currentOwnerSessionId: "hook-session",
        modelManifest: [],
        toolManifest: [],
        stages: { checkpoint: reserved("checkpoint") },
        branches: { codex: reserved("codex"), claude: reserved("claude") },
        branchAttempts: [],
        claudeSessionId: null,
        checkpoint: null,
        feedback: null,
        critique: null,
        finalResult: null,
        failureReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        { cwd: testEnv.workspaceDir, session_id: "hook-session" },
        testEnv.env
      );

      const workflow = readPeerWorkflow(testEnv, "workflow-session-end-never-started");
      assert.equal(workflow.epoch, 1);
      assert.equal(workflow.status, "incomplete");
      for (const target of [
        workflow.branches.codex,
        workflow.branches.claude,
        workflow.stages.checkpoint,
      ]) {
        assert.equal(target.status, "retryable_failed");
        assert.equal(target.failureReason, "SESSION_ENDED");
        assert.equal(Object.hasOwn(target, "attemptReservation"), false);
      }
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("retains a cleanup marker when the workflow budget expires and SessionStart replays it", () => {
    const testEnv = createHookEnvironment();
    try {
      writePeerWorkflow(testEnv, unfinishedPeerWorkflow(
        testEnv, "workflow-deadline-replay", "old-session"
      ));
      const preload = path.join(testEnv.rootDir, "workflow-deadline.mjs");
      fs.writeFileSync(preload, `
        import { performance } from "node:perf_hooks";
        Object.defineProperty(performance, "now", {
          configurable: true,
          value() {
            return new Error().stack.includes("finalizeSessionWorkflows") ? 3_000 : 1_000;
          },
        });
      `, "utf8");
      const marker = path.join(
        stateDirFor(testEnv.homeDir, testEnv.workspaceDir),
        "session-cleanup-pending-old-session.json"
      );

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        { cwd: testEnv.workspaceDir, session_id: "old-session" },
        {
          ...testEnv.env,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`]
            .filter(Boolean).join(" "),
        }
      );

      assert.equal(fs.existsSync(marker), true);
      assert.equal(readPeerWorkflow(testEnv, "workflow-deadline-replay").branches.codex.status, "running");

      runHook(
        SESSION_HOOK,
        [],
        { cwd: testEnv.workspaceDir, session_id: "new-session" },
        testEnv.env
      );
      const recovered = readPeerWorkflow(testEnv, "workflow-deadline-replay");
      assert.equal(recovered.branches.codex.status, "retryable_failed");
      assert.equal(recovered.branches.codex.failureReason, "SESSION_ENDED");
      assert.equal(fs.existsSync(marker), false);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("continues workflow cleanup when one reserved record disappears", () => {
    const testEnv = createHookEnvironment();
    try {
      const missingId = "workflow-a-missing";
      const survivingId = "workflow-b-surviving";
      writePeerWorkflow(testEnv, unfinishedPeerWorkflow(
        testEnv, missingId, "hook-session", { timestamp: "2026-04-04T02:00:00.000Z" }
      ));
      writePeerWorkflow(testEnv, unfinishedPeerWorkflow(
        testEnv, survivingId, "hook-session", { timestamp: "2026-04-04T01:00:00.000Z" }
      ));
      const preload = path.join(testEnv.rootDir, "remove-reserved-workflow.mjs");
      fs.writeFileSync(preload, `
        import fs from "node:fs";
        const originalRenameSync = fs.renameSync.bind(fs);
        let removed = false;
        fs.renameSync = (source, destination) => {
          originalRenameSync(source, destination);
          if (!removed && String(destination).endsWith("/${missingId}.json")) {
            try {
              const stored = JSON.parse(fs.readFileSync(destination, "utf8"));
              if (stored.cancellation?.leaseDigest) {
                fs.unlinkSync(destination);
                removed = true;
              }
            } catch {}
          }
        };
      `, "utf8");

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        { cwd: testEnv.workspaceDir, session_id: "hook-session" },
        {
          ...testEnv.env,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`]
            .filter(Boolean).join(" "),
        }
      );

      assert.equal(fs.existsSync(path.join(
        stateDirFor(testEnv.homeDir, testEnv.workspaceDir), "workflows", `${missingId}.json`
      )), false);
      const surviving = readPeerWorkflow(testEnv, survivingId);
      assert.equal(surviving.branches.codex.status, "retryable_failed");
      assert.equal(surviving.branches.codex.failureReason, "SESSION_ENDED");
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("retains recovery for a locked workflow while finalizing later workflows", () => {
    const testEnv = createHookEnvironment();
    try {
      const lockedId = "workflow-a-locked";
      const laterId = "workflow-b-after-lock";
      writePeerWorkflow(testEnv, unfinishedPeerWorkflow(
        testEnv, lockedId, "hook-session", { timestamp: "2026-04-04T02:00:00.000Z" }
      ));
      writePeerWorkflow(testEnv, unfinishedPeerWorkflow(
        testEnv, laterId, "hook-session", { timestamp: "2026-04-04T01:00:00.000Z" }
      ));
      const lockedFile = path.join(
        stateDirFor(testEnv.homeDir, testEnv.workspaceDir),
        "workflows", `${lockedId}.json`
      );
      fs.writeFileSync(`${lockedFile}.lock`, JSON.stringify({
        pid: process.pid,
        timestamp: Date.now(),
        token: "held-workflow-cleanup",
      }), "utf8");
      const marker = path.join(
        stateDirFor(testEnv.homeDir, testEnv.workspaceDir),
        "session-cleanup-pending-hook-session.json"
      );

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        { cwd: testEnv.workspaceDir, session_id: "hook-session" },
        testEnv.env
      );

      assert.equal(readPeerWorkflow(testEnv, lockedId).branches.codex.status, "running");
      assert.equal(readPeerWorkflow(testEnv, laterId).branches.codex.status, "retryable_failed");
      assert.equal(fs.existsSync(marker), true);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("does not reserve or mutate terminal workflows during SessionEnd", () => {
    const testEnv = createHookEnvironment();
    try {
      const terminal = unfinishedPeerWorkflow(
        testEnv, "workflow-terminal-session-end", "hook-session", { status: "completed" }
      );
      writePeerWorkflow(testEnv, terminal);
      const workflowFile = path.join(
        stateDirFor(testEnv.homeDir, testEnv.workspaceDir),
        "workflows", `${terminal.id}.json`
      );
      const before = fs.readFileSync(workflowFile);

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        { cwd: testEnv.workspaceDir, session_id: "hook-session" },
        testEnv.env
      );

      assert.deepEqual(fs.readFileSync(workflowFile), before);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("SessionEnd fails closed when a pending reserved peer launch cannot be cancelled", () => {
    const testEnv = createHookEnvironment();
    try {
      const workspaceRoot = fs.realpathSync.native(testEnv.workspaceDir);
      const fingerprint = getWorkingTreeFingerprint(workspaceRoot);
      const timestamp = new Date().toISOString();
      writePeerWorkflow(testEnv, {
        version: 1,
        id: "workflow-pending-linked-cancel-failure",
        mode: "design",
        status: "queued",
        phase: "queued",
        revision: 1,
        epoch: 0,
        workspaceRoot,
        fingerprint,
        brief: "Fail closed during the pending launch race.",
        briefHash: createHash("sha256")
          .update("Fail closed during the pending launch race.")
          .digest("hex"),
        originSessionId: "hook-session",
        currentOwnerSessionId: "hook-session",
        modelManifest: [],
        toolManifest: [],
        stages: {
          checkpoint: {
            status: "pending",
            payload: null,
            failureReason: null,
            attempts: 0,
          },
        },
        branches: {
          codex: {
            status: "completed",
            payload: { content: { finding: "frozen" } },
            failureReason: null,
            attempts: 1,
            completedAt: timestamp,
          },
          claude: {
            status: "pending",
            payload: null,
            failureReason: null,
            attempts: 0,
            attemptReservation: {
              epoch: 0,
              leaseDigest: createHash("sha256").update("pending-claude").digest("hex"),
              reservedAt: timestamp,
            },
          },
        },
        branchAttempts: [],
        claudeSessionId: null,
        checkpoint: null,
        feedback: null,
        critique: null,
        finalResult: null,
        failureReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      writeStateJob(testEnv, "pending-linked-cancel-failure", {
        id: "pending-linked-cancel-failure",
        status: "running",
        phase: "running",
        sessionId: "hook-session",
        workspaceRoot,
        workflowId: "workflow-pending-linked-cancel-failure",
        workflowStage: "memo",
        createdAt: timestamp,
        startedAt: timestamp,
        pid: process.pid,
      });

      const hook = runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        { cwd: testEnv.workspaceDir, session_id: "hook-session" },
        testEnv.env
      );

      const job = readStateJob(testEnv, "pending-linked-cancel-failure");
      const workflow = readPeerWorkflow(testEnv, "workflow-pending-linked-cancel-failure");
      assert.equal(job.status, "cancel_failed", hook.stderr);
      assert.equal(workflow.epoch, 1);
      assert.equal(workflow.status, "cancel_failed");
      assert.equal(workflow.branches.claude.status, "cancel_failed");
      assert.equal(workflow.branches.claude.failureReason, "SESSION_END_CANCEL_FAILED");
      assert.equal(Object.hasOwn(workflow.branches.claude, "attemptReservation"), false);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("SessionEnd keeps peer work cancel_failed when its linked process cannot be cancelled", async (t) => {
    if (process.platform !== "darwin") {
      t.skip("Darwin ps identity lookup behavior");
      return;
    }

    const testEnv = createHookEnvironment();
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    try {
      const workspaceRoot = fs.realpathSync.native(testEnv.workspaceDir);
      const fingerprint = getWorkingTreeFingerprint(workspaceRoot);
      const identity = getProcessIdentity(child.pid);
      const timestamp = new Date().toISOString();
      writePeerWorkflow(testEnv, {
        version: 1,
        id: "workflow-linked-cancel-failure",
        mode: "design",
        status: "running",
        phase: "memo",
        revision: 1,
        epoch: 0,
        workspaceRoot,
        fingerprint,
        brief: "Do not retry while the old Claude process survives.",
        briefHash: createHash("sha256")
          .update("Do not retry while the old Claude process survives.")
          .digest("hex"),
        originSessionId: "hook-session",
        currentOwnerSessionId: "hook-session",
        modelManifest: [],
        toolManifest: [],
        stages: {
          checkpoint: {
            status: "running",
            payload: null,
            failureReason: null,
            attempts: 1,
            stage: "checkpoint",
            startFingerprint: fingerprint,
            startedAt: timestamp,
          },
        },
        branches: {
          codex: { status: "completed", payload: { content: { finding: "frozen" } }, attempts: 1 },
          claude: {
            status: "running",
            payload: null,
            failureReason: null,
            attempts: 1,
            stage: "memo",
            startFingerprint: fingerprint,
            startedAt: timestamp,
          },
        },
        branchAttempts: [],
        claudeSessionId: null,
        checkpoint: null,
        feedback: null,
        critique: null,
        finalResult: null,
        failureReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      writeStateJob(testEnv, "peer-linked-cancel-failure", {
        id: "peer-linked-cancel-failure",
        status: "running",
        sessionId: "hook-session",
        workspaceRoot,
        workflowId: "workflow-linked-cancel-failure",
        workflowStage: "memo",
        createdAt: timestamp,
        startedAt: timestamp,
        pid: child.pid,
        pidIdentity: identity,
      });
      const failingBin = path.join(testEnv.rootDir, "peer-failing-ps");
      fs.mkdirSync(failingBin);
      const fakePs = path.join(failingBin, "ps");
      fs.writeFileSync(fakePs, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.at(-1) === process.env.CC_TEST_TARGET_PID) process.exit(2);
const result = spawnSync("/bin/ps", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`, "utf8");
      fs.chmodSync(fakePs, 0o755);

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        { cwd: testEnv.workspaceDir, session_id: "hook-session" },
        {
          ...testEnv.env,
          PATH: `${failingBin}${path.delimiter}${testEnv.env.PATH}`,
          CC_TEST_TARGET_PID: String(child.pid),
        }
      );

      const job = readStateJob(testEnv, "peer-linked-cancel-failure");
      const workflow = readPeerWorkflow(testEnv, "workflow-linked-cancel-failure");
      assert.equal(job.status, "cancel_failed");
      assert.equal(workflow.branches.claude.status, "cancel_failed");
      assert.equal(workflow.branches.claude.failureReason, "SESSION_END_CANCEL_FAILED");
      assert.equal(workflow.stages.checkpoint.status, "retryable_failed");
      assert.equal(workflow.stages.checkpoint.failureReason, "SESSION_ENDED");
      assert.doesNotThrow(() => process.kill(child.pid, 0));
    } finally {
      child.kill();
      cleanupHookEnvironment(testEnv);
    }
  });

  it("SessionEnd does not rescan every job after deadline-bound cleanup", () => {
    const testEnv = createHookEnvironment();

    try {
      writeStateJob(testEnv, "single-scan-job", {
        id: "single-scan-job",
        status: "queued",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: new Date().toISOString(),
      });
      const preload = path.join(testEnv.rootDir, "single-job-scan.mjs");
      fs.writeFileSync(
        preload,
        `import fs from "node:fs";
const originalReaddirSync = fs.readdirSync.bind(fs);
let jobDirectoryReads = 0;
fs.readdirSync = (directory, ...args) => {
  if (String(directory).endsWith("/jobs")) {
    jobDirectoryReads += 1;
    if (jobDirectoryReads > 1) {
      const error = new Error("simulated second jobs-directory scan");
      error.code = "ESECONDREAD";
      throw error;
    }
  }
  return originalReaddirSync(directory, ...args);
};
`,
        "utf8"
      );

      const result = runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        { cwd: testEnv.workspaceDir, session_id: "hook-session" },
        {
          ...testEnv.env,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            `--import=${pathToFileURL(preload).href}`,
          ]
            .filter(Boolean)
            .join(" "),
        }
      );

      assert.equal(result.stderr, "");
      assert.equal(readStateJob(testEnv, "single-scan-job").status, "cancelled");
      assert.equal(
        fs.existsSync(
          path.join(
            stateDirFor(testEnv.homeDir, testEnv.workspaceDir),
            "session-cleanup-pending-hook-session.json"
          )
        ),
        false
      );
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("keeps SessionEnd within the Codex three-second ceiling", () => {
    const manifest = JSON.parse(fs.readFileSync(HOOKS_MANIFEST, "utf8"));
    const sessionStartHandler = manifest.hooks.SessionStart[0].hooks[0];
    const handler = manifest.hooks.SessionEnd[0].hooks[0];

    for (const eventHandlers of Object.values(manifest.hooks)) {
      for (const entry of eventHandlers) {
        for (const hook of entry.hooks) {
          assert.match(hook.command, /\$\{PLUGIN_DATA\}\/runtime\/hook-launcher\.mjs/u);
          assert.doesNotMatch(hook.command, /"\$PLUGIN_DATA/u);
          assert.doesNotMatch(hook.command, /\$PLUGIN_ROOT/u);
        }
      }
    }

    assert.equal(sessionStartHandler.timeout, 5);
    assert.equal(manifest.hooks.UserPromptSubmit[0].hooks[0].timeout, 5);
    assert.equal(handler.timeout, 3);
    assert.match(handler.command, /session-lifecycle SessionEnd/u);
  });

  it("session lifecycle hook refuses to kill a stored PID without a matching identity", () => {
    const testEnv = createHookEnvironment();

    try {
      writeStateJob(testEnv, "untrusted-running-job", {
        id: "untrusted-running-job",
        status: "running",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        startedAt: "2026-04-04T01:00:01Z",
        pid: process.pid,
      });

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
        },
        testEnv.env
      );

      const job = readStateJob(testEnv, "untrusted-running-job");
      assert.equal(job.status, "cancel_failed");
      assert.equal(job.phase, "cancel_failed");
      assert.equal(job.pid, process.pid);
      assert.match(job.errorMessage ?? "", /without a matching PID identity/i);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session lifecycle hook reserves preparation time after a slow process start", () => {
    const testEnv = createHookEnvironment();
    const createdAt = new Date().toISOString();

    try {
      for (const jobId of ["budget-job-one", "budget-job-two"]) {
        writeStateJob(testEnv, jobId, {
          id: jobId,
          status: "running",
          sessionId: "hook-session",
          workspaceRoot: testEnv.workspaceDir,
          createdAt,
          startedAt: createdAt,
          pid: process.pid,
          pidIdentity: `${jobId}-identity`,
        });
      }
      writeStateJob(testEnv, "budget-job-without-pid", {
        id: "budget-job-without-pid",
        status: "queued",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt,
      });

      const clockPreload = path.join(testEnv.rootDir, "cleanup-clock.mjs");
      fs.writeFileSync(
        clockPreload,
        `import { performance } from "node:perf_hooks";
const realNow = performance.now.bind(performance);
Object.defineProperty(performance, "now", { configurable: true, value: () => {
  const stack = new Error().stack ?? "";
  if (stack.includes("createCleanupDeadlineAt")) {
    return 1_600;
  }
  if (stack.includes("transitionWithinCleanupBudget")) {
    return 1_600;
  }
  if (stack.includes("cleanupSessionJobs")) {
    return 2_750;
  }
  return realNow();
} });
`,
        "utf8"
      );

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
        },
        {
          ...testEnv.env,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            `--import=${pathToFileURL(clockPreload).href}`,
          ]
            .filter(Boolean)
            .join(" "),
        }
      );

      for (const jobId of ["budget-job-one", "budget-job-two"]) {
        const job = readStateJob(testEnv, jobId);
        assert.equal(job.status, "cancelling");
        assert.equal(job.phase, "session_cleanup_pending");
        assert.equal(job.pid, process.pid);
        assert.equal(job.pidIdentity, `${jobId}-identity`);
        assert.equal(job.completedAt, null);
        assert.equal(
          job.errorMessage,
          "Automatic cleanup pending; it will retry on the next top-level Codex session."
        );
      }
      const noPidJob = readStateJob(testEnv, "budget-job-without-pid");
      assert.equal(noPidJob.status, "cancelling");
      assert.equal(noPidJob.phase, "session_cleanup_pending");

      runHook(
        SESSION_HOOK,
        [],
        { cwd: testEnv.workspaceDir, session_id: "next-session" },
        testEnv.env
      );
      assert.equal(
        readStateJob(testEnv, "budget-job-without-pid").status,
        "cancelled"
      );
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session cleanup preserves process handles written after its snapshot", () => {
    const testEnv = createHookEnvironment();
    const createdAt = new Date().toISOString();

    try {
      writeStateJob(testEnv, "racing-process-handles", {
        id: "racing-process-handles",
        status: "queued",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt,
        pid: null,
        pidIdentity: null,
        pgid: null,
      });
      const jobFile = path.join(
        stateDirFor(testEnv.homeDir, testEnv.workspaceDir),
        "jobs",
        "racing-process-handles.json"
      );
      const preload = path.join(testEnv.rootDir, "race-process-handles.mjs");
      fs.writeFileSync(
        preload,
        `import fs from "node:fs";
import { performance } from "node:perf_hooks";
const originalLinkSync = fs.linkSync.bind(fs);
let raced = false;
fs.linkSync = (source, destination) => {
  if (!raced && String(destination).endsWith("racing-process-handles.json.lock")) {
    raced = true;
    const job = JSON.parse(fs.readFileSync(process.env.CC_TEST_RACE_JOB_FILE, "utf8"));
    job.pidIdentity = "fresh-identity";
    job.pgid = 4242;
    fs.writeFileSync(process.env.CC_TEST_RACE_JOB_FILE, JSON.stringify(job) + "\\n", "utf8");
  }
  return originalLinkSync(source, destination);
};
const realNow = performance.now.bind(performance);
Object.defineProperty(performance, "now", { configurable: true, value: () => {
  const stack = new Error().stack ?? "";
  if (stack.includes("createCleanupDeadlineAt") || stack.includes("transitionWithinCleanupBudget")) {
    return 0;
  }
  if (stack.includes("cleanupSessionJobs")) {
    return 2_750;
  }
  return realNow();
} });
`,
        "utf8"
      );

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        { cwd: testEnv.workspaceDir, session_id: "hook-session" },
        {
          ...testEnv.env,
          CC_TEST_RACE_JOB_FILE: jobFile,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            `--import=${pathToFileURL(preload).href}`,
          ]
            .filter(Boolean)
            .join(" "),
        }
      );

      const job = readStateJob(testEnv, "racing-process-handles");
      assert.equal(job.status, "cancelling");
      assert.equal(job.phase, "session_cleanup_pending");
      assert.equal(job.pidIdentity, "fresh-identity");
      assert.equal(job.pgid, 4242);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("retains the current-session fallback when its cleanup marker cannot be written", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "current-session.json"),
        JSON.stringify({ sessionId: "hook-session" }) + "\n",
        "utf8"
      );
      writeStateJob(testEnv, "marker-write-failure-job", {
        id: "marker-write-failure-job",
        status: "running",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: new Date().toISOString(),
        pid: 999_999,
        pidIdentity: "stored-identity",
      });
      const preload = path.join(testEnv.rootDir, "fail-cleanup-marker.mjs");
      fs.writeFileSync(
        preload,
        `import fs from "node:fs";
const originalWriteFileSync = fs.writeFileSync.bind(fs);
fs.writeFileSync = (file, ...args) => {
  if (String(file).includes("session-cleanup-pending-hook-session.json")) {
    const error = new Error("simulated cleanup marker ENOSPC");
    error.code = "ENOSPC";
    throw error;
  }
  return originalWriteFileSync(file, ...args);
};
`,
        "utf8"
      );

      const result = runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        { cwd: testEnv.workspaceDir, session_id: "hook-session" },
        {
          ...testEnv.env,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            `--import=${pathToFileURL(preload).href}`,
          ]
            .filter(Boolean)
            .join(" "),
        }
      );

      assert.equal(readCurrentSessionMarker(testEnv).sessionId, "hook-session");
      assert.equal(readStateJob(testEnv, "marker-write-failure-job").status, "running");
      assert.match(result.stderr, /SessionEnd cleanup failed.*ENOSPC/iu);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session lifecycle hook marks an already-exited stored process cancelled", () => {
    const testEnv = createHookEnvironment();

    try {
      writeStateJob(testEnv, "exited-running-job", {
        id: "exited-running-job",
        status: "running",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        startedAt: "2026-04-04T01:00:01Z",
        pid: 99_999_999,
        pidIdentity: "exited-process-identity",
      });

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
        },
        testEnv.env
      );

      const job = readStateJob(testEnv, "exited-running-job");
      assert.equal(job.status, "cancelled");
      assert.equal(job.phase, "cancelled");
      assert.equal(job.pid, null);
      assert.equal(job.pidIdentity, null);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session lifecycle hook preserves a live PID when POSIX identity lookup fails", async (t) => {
    if (process.platform !== "darwin") {
      t.skip("Darwin ps timeout behavior");
      return;
    }

    const testEnv = createHookEnvironment();
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    try {
      const identity = getProcessIdentity(child.pid);
      const failingBin = path.join(testEnv.rootDir, "failing-ps");
      fs.mkdirSync(failingBin);
      const fakePs = path.join(failingBin, "ps");
      const observedStatus = path.join(testEnv.rootDir, "status-before-ps.txt");
      const jobFile = path.join(
        stateDirFor(testEnv.homeDir, testEnv.workspaceDir),
        "jobs",
        "identity-unavailable-job.json"
      );
      fs.writeFileSync(
        fakePs,
        `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.at(-1) === process.env.CC_TEST_TARGET_PID) {
  const job = JSON.parse(fs.readFileSync(process.env.CC_TEST_JOB_FILE, "utf8"));
  fs.writeFileSync(
    process.env.CC_TEST_OBSERVED_STATUS,
    JSON.stringify({ status: job.status, completedAt: job.completedAt ?? null }),
    "utf8"
  );
  process.exit(2);
}
const result = spawnSync("/bin/ps", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
        "utf8"
      );
      fs.chmodSync(fakePs, 0o755);
      writeStateJob(testEnv, "identity-unavailable-job", {
        id: "identity-unavailable-job",
        status: "running",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        startedAt: "2026-04-04T01:00:01Z",
        pid: child.pid,
        pidIdentity: identity,
      });

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
        },
        {
          ...testEnv.env,
          PATH: `${failingBin}${path.delimiter}${testEnv.env.PATH}`,
          CC_TEST_TARGET_PID: String(child.pid),
          CC_TEST_JOB_FILE: jobFile,
          CC_TEST_OBSERVED_STATUS: observedStatus,
        }
      );

      const job = readStateJob(testEnv, "identity-unavailable-job");
      assert.deepEqual(
        JSON.parse(fs.readFileSync(observedStatus, "utf8")),
        { status: "cancelling", completedAt: null }
      );
      assert.equal(job.status, "cancel_failed");
      assert.equal(job.phase, "cancel_failed");
      assert.equal(job.pid, child.pid);
      assert.equal(job.pidIdentity, identity);
      assert.doesNotThrow(() => process.kill(child.pid, 0));
    } finally {
      child.kill();
      cleanupHookEnvironment(testEnv);
    }
  });

  it("SessionEnd stays below its hook ceiling when process identity lookup stalls", async (t) => {
    if (process.platform !== "darwin") {
      t.skip("Darwin ps timeout behavior");
      return;
    }

    const testEnv = createHookEnvironment();
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    try {
      const identity = getProcessIdentity(child.pid);
      const slowBin = path.join(testEnv.rootDir, "slow-ps");
      fs.mkdirSync(slowBin);
      const fakePs = path.join(slowBin, "ps");
      fs.writeFileSync(
        fakePs,
        `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.at(-1) === process.env.CC_TEST_TARGET_PID) {
  setInterval(() => {}, 1000);
} else {
  const result = spawnSync("/bin/ps", args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`,
        "utf8"
      );
      fs.chmodSync(fakePs, 0o755);
      writeStateJob(testEnv, "slow-identity-job", {
        id: "slow-identity-job",
        status: "running",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        pid: child.pid,
        pidIdentity: identity,
      });

      const startedAt = performance.now();
      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        { cwd: testEnv.workspaceDir, session_id: "hook-session" },
        {
          ...testEnv.env,
          PATH: `${slowBin}${path.delimiter}${testEnv.env.PATH}`,
          CC_TEST_TARGET_PID: String(child.pid),
        },
        { timeout: 2_900 }
      );
      const elapsedMs = performance.now() - startedAt;

      const job = readStateJob(testEnv, "slow-identity-job");
      assert.ok(elapsedMs < 2_900, `SessionEnd took ${elapsedMs}ms`);
      assert.equal(job.status, "cancelling");
      assert.equal(job.phase, "session_cleanup_pending");
      assert.equal(job.completedAt, null);
      assert.equal(job.pid, child.pid);
      assert.equal(job.pidIdentity, identity);
      assert.doesNotThrow(() => process.kill(child.pid, 0));
    } finally {
      child.kill();
      cleanupHookEnvironment(testEnv);
    }
  });

  it("SessionEnd shares one deadline across stalled lock recovery attempts", async (t) => {
    if (process.platform !== "darwin") {
      t.skip("Darwin ps timeout behavior");
      return;
    }

    const testEnv = createHookEnvironment();
    const lockOwner = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );
    await new Promise((resolve, reject) => {
      lockOwner.once("spawn", resolve);
      lockOwner.once("error", reject);
    });

    try {
      const jobId = "stalled-lock-job";
      const jobFile = path.join(
        stateDirFor(testEnv.homeDir, testEnv.workspaceDir),
        "jobs",
        `${jobId}.json`
      );
      writeStateJob(testEnv, jobId, {
        id: jobId,
        status: "queued",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
      });
      fs.writeFileSync(
        `${jobFile}.lock`,
        JSON.stringify({
          pid: lockOwner.pid,
          identity: getProcessIdentity(lockOwner.pid),
          timestamp: Date.now() - 31_000,
          token: "stalled-lock-owner",
        }),
        { encoding: "utf8", mode: 0o600 }
      );

      const slowBin = path.join(testEnv.rootDir, "slow-lock-ps");
      fs.mkdirSync(slowBin);
      const fakePs = path.join(slowBin, "ps");
      fs.writeFileSync(
        fakePs,
        `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.at(-1) === process.env.CC_TEST_LOCK_OWNER_PID) {
  setInterval(() => {}, 1000);
} else {
  const result = spawnSync("/bin/ps", args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`,
        "utf8"
      );
      fs.chmodSync(fakePs, 0o755);

      const startedAt = performance.now();
      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        { cwd: testEnv.workspaceDir, session_id: "hook-session" },
        {
          ...testEnv.env,
          PATH: `${slowBin}${path.delimiter}${testEnv.env.PATH}`,
          CC_TEST_LOCK_OWNER_PID: String(lockOwner.pid),
        },
        { timeout: 2_900 }
      );
      const elapsedMs = performance.now() - startedAt;

      assert.ok(elapsedMs < 2_900, `SessionEnd took ${elapsedMs}ms`);
      assert.equal(readStateJob(testEnv, jobId).status, "queued");

      const lockOwnerExit = new Promise((resolve) => {
        lockOwner.once("exit", resolve);
      });
      lockOwner.kill();
      await lockOwnerExit;
      runHook(
        SESSION_HOOK,
        [],
        { cwd: testEnv.workspaceDir, session_id: "new-session" },
        testEnv.env
      );
      assert.equal(readStateJob(testEnv, jobId).status, "cancelled");
    } finally {
      lockOwner.kill();
      cleanupHookEnvironment(testEnv);
    }
  });

  it("SessionEnd resolves a subdirectory workspace without waiting on Git", (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX executable fixture");
      return;
    }

    const testEnv = createHookEnvironment();
    try {
      const slowBin = path.join(testEnv.rootDir, "slow-git");
      fs.mkdirSync(slowBin);
      const fakeGit = path.join(slowBin, "git");
      fs.writeFileSync(
        fakeGit,
        "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n",
        "utf8"
      );
      fs.chmodSync(fakeGit, 0o755);
      writeStateJob(testEnv, "slow-workspace-job", {
        id: "slow-workspace-job",
        status: "queued",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
      });
      const nestedCwd = path.join(testEnv.workspaceDir, "nested", "cwd");
      fs.mkdirSync(nestedCwd, { recursive: true });

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        { cwd: nestedCwd, session_id: "hook-session" },
        {
          ...testEnv.env,
          PATH: `${slowBin}${path.delimiter}${testEnv.env.PATH}`,
        },
        { timeout: 2_000 }
      );
      assert.equal(readStateJob(testEnv, "slow-workspace-job").status, "cancelled");
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("top-level SessionStart retries cancel_failed jobs", () => {
    const testEnv = createHookEnvironment();

    try {
      writePendingSessionCleanup(testEnv, "old-session");
      writeStateJob(testEnv, "retry-cancel-failed", {
        id: "retry-cancel-failed",
        status: "cancel_failed",
        phase: "cancel_failed",
        sessionId: "old-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        pid: 99_999_999,
        pidIdentity: "missing-process-identity",
      });

      runHook(
        SESSION_HOOK,
        [],
        { cwd: testEnv.workspaceDir, session_id: "new-session" },
        testEnv.env
      );

      const job = readStateJob(testEnv, "retry-cancel-failed");
      assert.equal(job.status, "cancelled");
      assert.equal(job.pid, null);
      assert.equal(job.pidIdentity, null);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("top-level SessionStart does not retry unverifiable cancel_failed jobs", () => {
    const testEnv = createHookEnvironment();

    try {
      writePendingSessionCleanup(testEnv, "old-session");
      writeStateJob(testEnv, "unverifiable-cancel-failed", {
        id: "unverifiable-cancel-failed",
        status: "cancel_failed",
        phase: "cancel_failed",
        sessionId: "old-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        updatedAt: "2026-04-04T01:00:01Z",
        completedAt: "2026-04-04T01:00:01Z",
        errorMessage: "Original unverifiable cleanup failure.",
        pid: process.pid,
        pidIdentity: null,
      });

      runHook(
        SESSION_HOOK,
        [],
        { cwd: testEnv.workspaceDir, session_id: "new-session" },
        testEnv.env
      );

      const job = readStateJob(testEnv, "unverifiable-cancel-failed");
      assert.equal(job.errorMessage, "Original unverifiable cleanup failure.");
      assert.equal(job.updatedAt, "2026-04-04T01:00:01Z");
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("top-level SessionStart retries pending SessionEnd cleanup", () => {
    const testEnv = createHookEnvironment();

    try {
      writeStateJob(testEnv, "pending-session-cleanup", {
        id: "pending-session-cleanup",
        status: "cancelling",
        phase: "session_cleanup_pending",
        sessionId: "old-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        pid: 99_999_999,
        pidIdentity: "missing-process-identity",
      });

      runHook(
        SESSION_HOOK,
        [],
        { cwd: testEnv.workspaceDir, session_id: "new-session" },
        testEnv.env
      );

      const job = readStateJob(testEnv, "pending-session-cleanup");
      assert.equal(job.status, "cancelled");
      assert.equal(job.pid, null);
      assert.equal(job.pidIdentity, null);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("top-level SessionStart leaves another live top-level session alone", async () => {
    const testEnv = createHookEnvironment();
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "current-session.json"),
        JSON.stringify({ sessionId: "new-session", updatedAt: "2026-04-04T01:00:00Z" }),
        "utf8"
      );
      writeStateJob(testEnv, "other-live-session-job", {
        id: "other-live-session-job",
        status: "running",
        sessionId: "old-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        pid: child.pid,
        pidIdentity: getProcessIdentity(child.pid),
      });

      runHook(
        SESSION_HOOK,
        [],
        { cwd: testEnv.workspaceDir, session_id: "new-session" },
        testEnv.env
      );

      assert.equal(readStateJob(testEnv, "other-live-session-job").status, "running");
      assert.doesNotThrow(() => process.kill(child.pid, 0));
      assert.equal(readCurrentSessionMarker(testEnv).sessionId, "new-session");
    } finally {
      child.kill();
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session start preserves the parent marker for nested sessions and exports hook suppression", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "current-session.json"),
        JSON.stringify(
          { sessionId: "parent-session", updatedAt: "2026-04-04T01:00:00Z" },
          null,
          2
        ) + "\n",
        "utf8"
      );
      writeStateJob(testEnv, "parent-recovery-job", {
        id: "parent-recovery-job",
        status: "cancel_failed",
        phase: "cancel_failed",
        sessionId: "parent-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        pid: 99_999_999,
        pidIdentity: "missing-process-identity",
      });

      const envFile = path.join(testEnv.rootDir, "child-session.env");
      runHook(
        SESSION_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "child-session",
        },
        {
          ...testEnv.env,
          CLAUDE_ENV_FILE: envFile,
          CLAUDE_COMPANION_SESSION_ID: "parent-session",
        }
      );

      assert.equal(readCurrentSessionMarker(testEnv).sessionId, "parent-session");
      assert.equal(
        readStateJob(testEnv, "parent-recovery-job").status,
        "cancel_failed"
      );

      const exportedEnv = fs.readFileSync(envFile, "utf8");
      assert.match(exportedEnv, /CLAUDE_COMPANION_SESSION_ID='child-session'/);
      assert.match(exportedEnv, /CLAUDE_COMPANION_SKIP_INTERACTIVE_HOOKS='1'/);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session start stamps Claude Code as the external host origin", () => {
    const testEnv = createHookEnvironment();

    try {
      /** @type {NodeJS.ProcessEnv} */
      const env = { ...testEnv.env, CLAUDECODE: "1" };
      delete env[SESSION_ID_ENV];
      runHook(
        SESSION_HOOK,
        [],
        { cwd: testEnv.workspaceDir, session_id: "cc-thread" },
        env
      );

      assert.equal(readCurrentSessionMarker(testEnv).hostOrigin, "claude-code");
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session start leaves external host origin unset for plain Codex", () => {
    const testEnv = createHookEnvironment();

    try {
      /** @type {NodeJS.ProcessEnv} */
      const env = { ...testEnv.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      delete env[SESSION_ID_ENV];
      runHook(
        SESSION_HOOK,
        [],
        { cwd: testEnv.workspaceDir, session_id: "plain-session" },
        env
      );

      const marker = readCurrentSessionMarker(testEnv);
      assert.equal(marker.sessionId, "plain-session");
      assert.equal("hostOrigin" in marker, false);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session start exports the Claude transcript path for transfer", () => {
    const testEnv = createHookEnvironment();

    try {
      const envFile = path.join(testEnv.rootDir, "session.env");
      const transcriptPath = path.join(
        testEnv.homeDir,
        ".claude",
        "projects",
        "-workspace",
        "session.jsonl"
      );

      runHook(
        SESSION_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          transcript_path: transcriptPath,
        },
        {
          ...testEnv.env,
          CLAUDE_ENV_FILE: envFile,
        }
      );

      const exportedEnv = fs.readFileSync(envFile, "utf8");
      assert.match(exportedEnv, /CODEX_COMPANION_TRANSCRIPT_PATH=/);
      assert.match(exportedEnv, new RegExp(escapeRegExp(transcriptPath)));
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session start preserves current-session fallback outside Git", () => {
    const testEnv = createHookEnvironment({ initGit: false });

    try {
      runHook(
        SESSION_HOOK,
        [],
        { cwd: testEnv.workspaceDir, session_id: "non-git-session" },
        testEnv.env
      );

      assert.equal(
        readCurrentSessionMarker(testEnv).sessionId,
        "non-git-session"
      );
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("nested session start does not override the parent Claude transcript path", () => {
    const testEnv = createHookEnvironment();

    try {
      const envFile = path.join(testEnv.rootDir, "nested.env");
      const transcriptPath = path.join(
        testEnv.homeDir,
        ".claude",
        "projects",
        "-workspace",
        "nested.jsonl"
      );

      runHook(
        SESSION_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "child-session",
          transcript_path: transcriptPath,
        },
        {
          ...testEnv.env,
          CLAUDE_ENV_FILE: envFile,
          CLAUDE_COMPANION_SESSION_ID: "parent-session",
        }
      );

      const exportedEnv = fs.readFileSync(envFile, "utf8");
      assert.doesNotMatch(exportedEnv, /CODEX_COMPANION_TRANSCRIPT_PATH=/);
      assert.match(exportedEnv, /CLAUDE_COMPANION_SKIP_INTERACTIVE_HOOKS='1'/);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook blocks unknown Claude completion states even if partial output looks like ALLOW", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );
      writeStaleTurnBaseline(testEnv, "hook-session");

      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_UNKNOWN_NO_TERMINAL: "1",
        }
      );

      const payload = JSON.parse(result.stdout);
      assert.equal(payload.decision, "block");
      assert.match(payload.reason ?? "", /No terminal result event received|unexpected answer|failed/i);
      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "blocked");
      assert.equal(snapshot.claudeInvoked, true);
      assert.equal(snapshot.claudeStatus, "unknown");
      assert.equal(snapshot.claudeExitCode, 0);
      assert.match(snapshot.claudeWarning ?? "", /No terminal result event received/i);
      assert.equal(snapshot.claudeStderr, "");
      assert.equal(snapshot.claudeSessionId, "hook-session-result");
      assert.equal(typeof snapshot.promptBytes, "number");
      assert.ok(snapshot.promptBytes > 0);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook records silent non-zero Claude failures with exit context", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );
      writeStaleTurnBaseline(testEnv, "hook-session");

      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_SILENT_FAIL: "1",
        }
      );

      const payload = JSON.parse(result.stdout);
      assert.equal(payload.decision, "block");
      assert.match(payload.reason ?? "", /stop-time Claude Code review failed/i);

      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "blocked");
      assert.equal(snapshot.claudeInvoked, true);
      assert.equal(snapshot.claudeStatus, "failed");
      assert.equal(snapshot.claudeExitCode, 7);
      assert.equal(snapshot.claudeWarning, null);
      assert.equal(snapshot.claudeStderr, "");
      assert.equal(snapshot.claudeSessionId, null);
      assert.equal(typeof snapshot.lastAssistantMessageChars, "number");
      assert.ok(snapshot.lastAssistantMessageChars > 0);
      assert.equal(typeof snapshot.promptBytes, "number");
      assert.ok(snapshot.promptBytes > 0);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook records the raw Claude output for unexpected answers", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );
      writeStaleTurnBaseline(testEnv, "hook-session");

      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_UNEXPECTED_RESULT: "1",
        }
      );

      const payload = JSON.parse(result.stdout);
      assert.equal(payload.decision, "block");
      assert.match(payload.reason ?? "", /unexpected answer/i);

      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "blocked");
      assert.equal(snapshot.claudeInvoked, true);
      assert.equal(snapshot.firstLine, "MAYBE: hook unsure");
      assert.equal(snapshot.rawOutput, "MAYBE: hook unsure");
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook blocks BLOCK contracts with or without prefix chatter", async (t) => {
    for (const [name, envName] of [
      ["direct", "CLAUDE_BLOCK_RESULT"],
      ["prefixed", "CLAUDE_PREFIXED_BLOCK_RESULT"],
    ]) {
      await t.test(name, () => {
        const testEnv = createHookEnvironment();
        try {
          enableReviewGate(testEnv);
          const result = runHook(
            STOP_HOOK,
            [],
            {
              cwd: testEnv.workspaceDir,
              session_id: "hook-session",
              last_assistant_message: "review me",
            },
            {
              ...testEnv.env,
              [envName]: "1",
            }
          );

          const payload = JSON.parse(result.stdout);
          assert.equal(payload.decision, "block");
          assert.match(payload.reason, /fix the failing regression/);
          const snapshot = readStopReviewSnapshot(testEnv);
          assert.equal(snapshot.firstLine, "BLOCK: fix the failing regression");
          assert.equal(snapshot.status, "blocked");
        } finally {
          cleanupHookEnvironment(testEnv);
        }
      });
    }
  });

  // Literal expectations keep these tests independent of the production constants.
  const EXPECTED_STOP_REASON_LIMIT = 1500;
  const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const STOP_REVIEW_BLOCK_PREFIX =
    "Claude Code stop-time review found issues that still need fixes before this turn can end: ";

  function stopReviewSnapshotPath(testEnv) {
    return path.join(stateDirFor(testEnv.homeDir, testEnv.workspaceDir), "stop-review-last.json");
  }

  function readLastStopReviewHistoryEntry(testEnv) {
    const lines = fs
      .readFileSync(
        path.join(stateDirFor(testEnv.homeDir, testEnv.workspaceDir), "stop-review-history.jsonl"),
        "utf8"
      )
      .split(/\r?\n/)
      .filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }

  function writeQueuedStopJob(testEnv, jobId) {
    const now = new Date().toISOString();
    writeStateJob(testEnv, jobId, {
      id: jobId,
      status: "queued",
      phase: "queued",
      sessionId: "hook-session",
      workspaceRoot: testEnv.workspaceDir,
      createdAt: now,
      updatedAt: now,
    });
  }

  function runStopHookWithFile(testEnv, envName, fileName, content) {
    const filePath = path.join(testEnv.rootDir, fileName);
    fs.writeFileSync(filePath, content, "utf8");
    return runHook(
      STOP_HOOK,
      [],
      {
        cwd: testEnv.workspaceDir,
        session_id: "hook-session",
        last_assistant_message: "review me",
      },
      {
        ...testEnv.env,
        [envName]: filePath,
      }
    );
  }

  function assertBoundedStopReason(testEnv, payload, expectedFullReason) {
    const fullPoints = Array.from(expectedFullReason);
    assert.ok(fullPoints.length > EXPECTED_STOP_REASON_LIMIT);
    const expectedPrefix = fullPoints.slice(0, EXPECTED_STOP_REASON_LIMIT).join("");
    const expectedSuffix = `… [truncated; full reason in ${stopReviewSnapshotPath(testEnv)}]`;
    assert.equal(payload.reason, `${expectedPrefix}${expectedSuffix}`);
    assert.doesNotMatch(payload.reason, LONE_SURROGATE_RE);
    assert.ok(fs.existsSync(stopReviewSnapshotPath(testEnv)));
  }

  it("stop-review hook bounds a long Unicode BLOCK reason and keeps the full snapshot", () => {
    const testEnv = createHookEnvironment();
    try {
      enableReviewGate(testEnv);
      const longReason = `Fix these findings: ${"🧪".repeat(1600)}${"é中".repeat(40)}`;
      const result = runStopHookWithFile(
        testEnv,
        "CLAUDE_BLOCK_REASON_FILE",
        "claude-block-reason.txt",
        longReason
      );

      const payload = JSON.parse(result.stdout);
      assert.equal(payload.decision, "block");
      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "blocked");
      assert.equal(snapshot.runningTaskNote, null);
      assert.equal(snapshot.reason, `${STOP_REVIEW_BLOCK_PREFIX}${longReason}`);
      assert.equal(snapshot.rawOutput, `BLOCK: ${longReason}`);
      assert.equal(snapshot.firstLine, `BLOCK: ${longReason}`);
      assertBoundedStopReason(testEnv, payload, snapshot.reason);
      assert.equal(readLastStopReviewHistoryEntry(testEnv).reason, snapshot.reason);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook bounds a long failure reason and keeps the full stderr", () => {
    const testEnv = createHookEnvironment();
    try {
      enableReviewGate(testEnv);
      const longStderr = `claude exploded: ${"💥".repeat(1800)}\n`;
      const result = runStopHookWithFile(
        testEnv,
        "CLAUDE_FAIL_STDERR_FILE",
        "claude-fail-stderr.txt",
        longStderr
      );

      const payload = JSON.parse(result.stdout);
      assert.equal(payload.decision, "block");
      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "blocked");
      assert.equal(snapshot.claudeStatus, "failed");
      assert.equal(snapshot.claudeExitCode, 3);
      assert.equal(snapshot.claudeStderr, longStderr);
      assert.equal(
        snapshot.reason,
        `The stop-time Claude Code review failed: ${longStderr.trim()}`
      );
      assertBoundedStopReason(testEnv, payload, snapshot.reason);
      assert.equal(readLastStopReviewHistoryEntry(testEnv).claudeStderr, longStderr);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook bounds the combined running-task note and reason", () => {
    const testEnv = createHookEnvironment();
    try {
      enableReviewGate(testEnv);
      writeQueuedStopJob(testEnv, "queued-stop-job");
      const reasonBody = "🧪".repeat(1400);
      const result = runStopHookWithFile(
        testEnv,
        "CLAUDE_BLOCK_REASON_FILE",
        "claude-block-reason.txt",
        reasonBody
      );

      const payload = JSON.parse(result.stdout);
      assert.equal(payload.decision, "block");
      const snapshot = readStopReviewSnapshot(testEnv);
      assert.match(snapshot.runningTaskNote ?? "", /queued-stop-job is still running/);
      assert.equal(snapshot.reason, `${STOP_REVIEW_BLOCK_PREFIX}${reasonBody}`);
      assert.ok(Array.from(snapshot.reason).length <= EXPECTED_STOP_REASON_LIMIT);
      assertBoundedStopReason(testEnv, payload, `${snapshot.runningTaskNote} ${snapshot.reason}`);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook applies the reason limit at exactly 1500 code points", async (t) => {
    for (const length of [1500, 1501]) {
      await t.test(`${length} code points`, () => {
        const testEnv = createHookEnvironment();
        try {
          enableReviewGate(testEnv);
          const body = "🧪".repeat(length - Array.from(STOP_REVIEW_BLOCK_PREFIX).length);
          const result = runStopHookWithFile(
            testEnv, "CLAUDE_BLOCK_REASON_FILE", "boundary-reason.txt", body
          );
          const payload = JSON.parse(result.stdout);
          const fullReason = `${STOP_REVIEW_BLOCK_PREFIX}${body}`;
          assert.equal(readStopReviewSnapshot(testEnv).reason, fullReason);
          if (length === 1500) {
            assert.equal(payload.reason, fullReason);
          } else {
            assertBoundedStopReason(testEnv, payload, fullReason);
          }
        } finally {
          cleanupHookEnvironment(testEnv);
        }
      });
    }
  });

  it("stop-review hook emits short reasons unchanged", async (t) => {
    await t.test("without a running task", () => {
      const testEnv = createHookEnvironment();
      try {
        enableReviewGate(testEnv);
        const result = runStopHookWithFile(
          testEnv,
          "CLAUDE_BLOCK_REASON_FILE",
          "claude-block-reason.txt",
          "short reason 🧪"
        );
        const payload = JSON.parse(result.stdout);
        const snapshot = readStopReviewSnapshot(testEnv);
        assert.equal(snapshot.reason, `${STOP_REVIEW_BLOCK_PREFIX}short reason 🧪`);
        assert.equal(payload.reason, snapshot.reason);
      } finally {
        cleanupHookEnvironment(testEnv);
      }
    });

    await t.test("with a running task", () => {
      const testEnv = createHookEnvironment();
      try {
        enableReviewGate(testEnv);
        writeQueuedStopJob(testEnv, "queued-stop-job");
        const result = runStopHookWithFile(
          testEnv,
          "CLAUDE_BLOCK_REASON_FILE",
          "claude-block-reason.txt",
          "short reason"
        );
        const payload = JSON.parse(result.stdout);
        const snapshot = readStopReviewSnapshot(testEnv);
        assert.match(snapshot.runningTaskNote ?? "", /queued-stop-job is still running/);
        assert.equal(payload.reason, `${snapshot.runningTaskNote} ${snapshot.reason}`);
        assert.doesNotMatch(payload.reason, /…/);
      } finally {
        cleanupHookEnvironment(testEnv);
      }
    });
  });

  it("stop-review hook blocks empty and unauthenticated Claude results", async (t) => {
    for (const scenario of [
      {
        name: "empty result",
        envName: "CLAUDE_EMPTY_RESULT",
        reason: /returned no output/i,
      },
      {
        name: "unauthenticated",
        envName: "CLAUDE_UNAUTHENTICATED",
        reason: /Not logged in|review failed/i,
      },
    ]) {
      await t.test(scenario.name, () => {
        const testEnv = createHookEnvironment();
        try {
          enableReviewGate(testEnv);
          const result = runHook(
            STOP_HOOK,
            [],
            {
              cwd: testEnv.workspaceDir,
              session_id: "hook-session",
              last_assistant_message: "review me",
            },
            {
              ...testEnv.env,
              [scenario.envName]: "1",
            }
          );

          const payload = JSON.parse(result.stdout);
          assert.equal(payload.decision, "block");
          assert.match(payload.reason, scenario.reason);
          assert.equal(readStopReviewSnapshot(testEnv).status, "blocked");
        } finally {
          cleanupHookEnvironment(testEnv);
        }
      });
    }
  });

  it("stop-review hook records a setup-required skip when Claude is missing", () => {
    const testEnv = createHookEnvironment({ createClaude: false });
    try {
      enableReviewGate(testEnv);
      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          PATH: `${testEnv.binDir}${path.delimiter}/usr/bin:/bin`,
        }
      );

      assert.equal(result.stdout, "");
      assert.match(result.stderr, /claude CLI not found in PATH/i);
      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "skipped_claude_not_ready");
      assert.equal(snapshot.claudeInvoked, false);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook accepts an ALLOW contract after streamed prefix chatter", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );
      writeStaleTurnBaseline(testEnv, "hook-session");

      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_PREFIXED_ALLOW_RESULT: "1",
        }
      );

      assert.equal(result.stdout.trim(), "");
      assert.match(result.stderr, /stop-time review passed/i);

      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "allow");
      assert.equal(snapshot.claudeInvoked, true);
      assert.equal(snapshot.firstLine, "ALLOW: hook ok");
      assert.match(snapshot.rawOutput, /^Let me verify the actual code changes/);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook allows stop to continue while noting a running same-session job", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );
      writeStaleTurnBaseline(testEnv, "hook-session");
      writeStateJob(testEnv, "running-review-job", {
        id: "running-review-job",
        status: "running",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        updatedAt: "2026-04-04T01:00:01Z",
      });

      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        testEnv.env
      );

      assert.equal(result.stdout.trim(), "");
      assert.match(result.stderr, /stop-time review passed/i);
      assert.match(result.stderr, /running-review-job/);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook skips nested subagent sessions marked for hook suppression", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );

      const argsFile = path.join(testEnv.rootDir, "claude-args.json");
      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "child-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_ARGS_FILE: argsFile,
          CLAUDE_COMPANION_SKIP_INTERACTIVE_HOOKS: "1",
        }
      );

      assert.equal(result.stdout.trim(), "");
      assert.equal(result.stderr.trim(), "");
      assert.ok(!fs.existsSync(argsFile), "nested stop hook should not invoke Claude");
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("hook input parser rejects oversized JSON payloads", () => {
    const testEnv = createHookEnvironment();

    try {
      const result = spawnSync(process.execPath, [UNREAD_HOOK], {
        cwd: PROJECT_ROOT,
        env: {
          ...testEnv.env,
          CLAUDE_HOOK_INPUT_MAX_BYTES: "128",
        },
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          prompt: "x".repeat(1024),
        }),
        encoding: "utf8",
      });

      assert.equal(result.status, 0);
      assert.match(result.stderr, /Hook input exceeds/i);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("hook input parser accepts empty input and fails open on malformed JSON", () => {
    const testEnv = createHookEnvironment();
    try {
      const empty = spawnSync(process.execPath, [UNREAD_HOOK], {
        cwd: PROJECT_ROOT,
        env: testEnv.env,
        input: "",
        encoding: "utf8",
      });
      assert.equal(empty.status, 0, empty.stderr);
      assert.equal(empty.stdout, "");

      const malformed = spawnSync(process.execPath, [UNREAD_HOOK], {
        cwd: PROJECT_ROOT,
        env: testEnv.env,
        input: "{invalid\n",
        encoding: "utf8",
      });
      assert.equal(malformed.status, 0);
      assert.match(malformed.stderr, /Invalid hook input JSON/i);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session lifecycle hook falls back to the current-session marker on SessionEnd", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "current-session.json"),
        JSON.stringify(
          { sessionId: "hook-session", updatedAt: "2026-04-04T01:00:00Z" },
          null,
          2
        ) + "\n",
        "utf8"
      );
      writeStateJob(testEnv, "queued-hook-job", {
        id: "queued-hook-job",
        status: "queued",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
      });

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        {
          cwd: testEnv.workspaceDir,
        },
        testEnv.env
      );

      const job = readStateJob(testEnv, "queued-hook-job");
      assert.equal(job.status, "cancelled");
      assert.ok(
        !fs.existsSync(path.join(stateDir, "current-session.json")),
        "SessionEnd fallback should clear the current-session marker"
      );
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session lifecycle hook ignores fallback lookup errors on SessionEnd", () => {
    const testEnv = createHookEnvironment();

    try {
      const missingDir = path.join(testEnv.rootDir, "missing-workspace");
      const result = runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        {
          cwd: missingDir,
        },
        testEnv.env
      );

      assert.equal(result.stdout.trim(), "");
      assert.equal(result.stderr.trim(), "");
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("nested SessionEnd does not cancel jobs owned by the parent session", () => {
    const testEnv = createHookEnvironment();

    try {
      writeStateJob(testEnv, "parent-owned-job", {
        id: "parent-owned-job",
        status: "running",
        sessionId: "parent-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        startedAt: "2026-04-04T01:00:01Z",
        pid: 999999,
      });

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        {
          cwd: testEnv.workspaceDir,
          session_id: "child-session",
        },
        {
          ...testEnv.env,
          [SESSION_ID_ENV]: "parent-session",
        }
      );

      const job = readStateJob(testEnv, "parent-owned-job");
      assert.equal(job.status, "running");
      assert.equal(job.sessionId, "parent-session");
      assert.equal(job.pid, 999999);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });
});
