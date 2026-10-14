/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import "./test-env.mjs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { renderJobStatusReport } from "../scripts/lib/render.mjs";
import { enrichJob } from "../scripts/lib/job-control.mjs";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION = path.join(PROJECT_ROOT, "scripts", "claude-companion.mjs");
const STOP_HOOK = path.join(PROJECT_ROOT, "hooks", "stop-review-gate-hook.mjs");
// Synthetic marker only. No fixture holds text from a real advisor conversation.
const MARKER = "SYNTHETIC_ADVISOR_PAYLOAD";
const cleanups = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

// Sanitized native shapes from tests/fixtures/advisor-evidence.json, with synthetic payload markers.
const call = (id) => ({ type: "server_tool_use", id, name: "advisor", input: { question: MARKER } });
const reply = (id) => ({
  type: "advisor_tool_result",
  tool_use_id: id,
  content: { type: "advisor_redacted_result", encrypted_content: MARKER },
});
const full = (blocks, extra = {}) =>
  JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: blocks }, ...extra });
const partial = (block, extra = {}) =>
  JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: block }, ...extra });
const terminal = (extra = {}) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Answer text.", session_id: "sess-advisor", model: "claude-opus-5-5", ...extra });
const MALFORMED = [
  `{"type":"advisor_tool_result","encrypted_content":"${MARKER}",`,
  `{"type":"advisor_tool_result","padding":"${"x".repeat(500)}","encrypted_content":${MARKER}}`,
];

function assertNoPayload(value, where) {
  assert.equal(JSON.stringify(value).includes(MARKER), false, `advisor payload leaked through ${where}`);
}

// ---------------------------------------------------------------------------
// Process boundary
// ---------------------------------------------------------------------------

// The fake CLI prints the JSON lines in FAKE_STREAM_FILE, then exits with FAKE_EXIT.
function writeFakeClaude(binDir) {
  const filePath = path.join(binDir, "claude");
  fs.writeFileSync(filePath, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
async function main() {
  if (args[0] === "--version") return void process.stdout.write("2.1.296 (Claude Code)\\n");
  if (args[0] === "auth") return void process.stdout.write('{"loggedIn":true}\\n');
  for await (const chunk of process.stdin) void chunk;
  const lines = process.env.FAKE_STREAM_FILE ? JSON.parse(fs.readFileSync(process.env.FAKE_STREAM_FILE, "utf8")) : [];
  process.stdout.write(lines.map((line) => line + "\\n").join(""), () => process.exit(Number(process.env.FAKE_EXIT ?? 0)));
}
main();
`, { mode: 0o755 });
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function createEnvironment(lines = []) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-advisor-telemetry-"));
  cleanups.push(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const homeDir = path.join(rootDir, "home");
  const binDir = path.join(rootDir, "bin");
  const workspaceDir = path.join(rootDir, "workspace");
  for (const dir of [homeDir, binDir, workspaceDir]) fs.mkdirSync(dir, { recursive: true });
  writeFakeClaude(binDir);
  git(workspaceDir, "init", "-q", "--initial-branch=main");
  git(workspaceDir, "config", "user.name", "Fixture");
  git(workspaceDir, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(workspaceDir, "sample.txt"), "before\n");
  git(workspaceDir, "add", "sample.txt");
  git(workspaceDir, "commit", "-qm", "fixture");
  fs.writeFileSync(path.join(workspaceDir, "sample.txt"), "after\n");
  const streamFile = path.join(rootDir, "stream.json");
  fs.writeFileSync(streamFile, JSON.stringify(lines));
  return {
    rootDir,
    homeDir,
    workspaceDir,
    streamFile,
    env: {
      PATH: `${binDir}${path.delimiter}${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODEX_HOME: path.join(homeDir, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(homeDir, ".claude"),
      CLAUDE_COMPANION_SESSION_ID: "advisor-telemetry-owner",
      FAKE_STREAM_FILE: streamFile,
    },
  };
}

function stateDir(testEnv) {
  const hash = createHash("sha256")
    .update(fs.realpathSync.native(testEnv.workspaceDir))
    .digest("hex")
    .slice(0, 12);
  return path.join(testEnv.env.CODEX_HOME, "plugins", "data", "cc", "state", hash);
}

function assertTreeHasNoPayload(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) assertTreeHasNoPayload(file);
    else if (entry.isFile()) assert.equal(fs.readFileSync(file, "utf8").includes(MARKER), false, `payload persisted in ${file}`);
  }
}

const ADVISOR_STREAM = [
  partial(call("srvtoolu_a")),
  full([call("srvtoolu_a"), reply("srvtoolu_a")]),
  ...MALFORMED,
  JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-2222-4333-8444-555555555555", model: "claude-opus-5-5" }),
  terminal({ session_id: "11111111-2222-4333-8444-555555555555" }),
];

// ---------------------------------------------------------------------------
// Public outputs
// ---------------------------------------------------------------------------

function runCompanion(testEnv, args, extraEnv = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: testEnv.workspaceDir,
    env: { ...testEnv.env, ...extraEnv },
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("advisor telemetry in public outputs", () => {
  it("reports bounded telemetry through task JSON, status and result without the payload", () => {
    const testEnv = createEnvironment(ADVISOR_STREAM);
    const run = runCompanion(testEnv, [
      "task", "--fresh", "--advisor", "fable", "--model", "claude-opus-5-5", "--effort", "high",
      "--poll-interval-ms", "100", "--wait-timeout-ms", "20000", "--json", "Inspect this synthetic fixture.",
    ]);
    assert.equal(run.status, 0, (run.stdout + run.stderr).slice(-1500));
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.rawOutput, "Answer text.");
    assert.equal(payload.finalModel, "claude-opus-5-5");
    assert.deepEqual(payload.advisor, {
      requested: "fable",
      calls: 1,
      countExact: true,
      observedModel: null,
      status: "observed",
      diagnostics: [],
    });
    assert.equal(payload.unresolvedParseErrors, 2);
    assertNoPayload(run.stdout + run.stderr, "task CLI output");

    const status = runCompanion(testEnv, ["status", "--all"]);
    assert.equal(status.status, 0, status.stderr);
    const jobs = fs.readdirSync(path.join(stateDir(testEnv), "jobs")).filter((name) => name.endsWith(".json"));
    assert.equal(jobs.length, 1);
    const jobId = jobs[0].replace(/\.json$/, "");
    const detail = runCompanion(testEnv, ["status", jobId]);
    assert.equal(detail.status, 0, detail.stderr);
    assert.deepEqual(JSON.parse(detail.stdout).job.advisor, payload.advisor);
    const result = runCompanion(testEnv, ["result", jobId]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).job.rendered,
      "Answer text.\n\nAdvisor: fable requested; 1 call observed; advisor model not reported\n"
    );
    assert.match(renderJobStatusReport(JSON.parse(detail.stdout).job), /\| Advisor \| fable requested; 1 call observed; advisor model not reported \|/);
    for (const output of [status, detail, result]) assertNoPayload(output.stdout + output.stderr, "read views");
    assertTreeHasNoPayload(testEnv.homeDir);
    assertTreeHasNoPayload(testEnv.workspaceDir);
  });

  it("reports telemetry in review JSON without the payload", () => {
    const testEnv = createEnvironment(ADVISOR_STREAM);
    const run = runCompanion(testEnv, ["review", "--scope", "working-tree", "--advisor", "fable", "--json"]);
    assert.equal(run.status, 0, (run.stdout + run.stderr).slice(-1500));
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.codex.advisor.calls, 1);
    assert.equal(payload.codex.advisor.requested, "fable");
    assert.equal(payload.codex.finalModel, "claude-opus-5-5");
    assertNoPayload(run.stdout + run.stderr, "review CLI output");
    assertTreeHasNoPayload(testEnv.homeDir);
  });

  it("keeps old records without advisor telemetry readable", () => {
    const job = enrichJob({ id: "task-old", status: "completed", jobClass: "task", result: { status: "completed", finalModel: "claude-opus-5-5" } });
    assert.equal("advisor" in job, false);
    const report = renderJobStatusReport(job);
    assert.match(report, /\| Final model \| claude-opus-5-5 \|/);
    assert.doesNotMatch(report, /Advisor/);
  });

  it("omits the default inherited, unobserved telemetry from status records", () => {
    const advisor = { requested: "inherit", calls: 0, countExact: true, observedModel: null, status: "not_observed", diagnostics: [] };
    const job = enrichJob({ id: "task-default", status: "completed", jobClass: "task", result: { advisor } });
    assert.equal("advisor" in job, false);
    assert.doesNotMatch(renderJobStatusReport(job), /Advisor/);
  });

  it("states an incomplete count as a lower bound", () => {
    const job = enrichJob({
      id: "task-new",
      status: "completed",
      jobClass: "task",
      result: { advisor: { requested: "inherit", calls: 2, countExact: false, observedModel: null, status: "incomplete", diagnostics: ["CALL_ID_MISSING"] } },
    });
    assert.match(renderJobStatusReport(job), /\| Advisor \| inherit requested; at least 2 calls observed \(count incomplete\); advisor model not reported \|/);
  });
});

describe("stop-review gate advisor telemetry and spawn snapshot failure", () => {
  function prepare(lines) {
    const testEnv = createEnvironment(lines);
    fs.mkdirSync(stateDir(testEnv), { recursive: true });
    fs.writeFileSync(path.join(stateDir(testEnv), "config.json"), JSON.stringify({ version: 1, stopReviewGate: true, stopReviewAdvisor: "fable" }));
    fs.writeFileSync(
      path.join(stateDir(testEnv), "turn-baseline.hook-session.json"),
      JSON.stringify({ sessionId: "hook-session", cwd: testEnv.workspaceDir, workspaceRoot: testEnv.workspaceDir, capturedAt: "2026-04-04T01:00:00Z", fingerprint: { signature: "stale-baseline" } })
    );
    return testEnv;
  }
  const stop = (testEnv, nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, STOP_HOOK], {
    cwd: PROJECT_ROOT,
    env: testEnv.env,
    input: JSON.stringify({ cwd: testEnv.workspaceDir, session_id: "hook-session", last_assistant_message: "review me" }),
    encoding: "utf8",
    timeout: 60_000,
  });
  const snapshot = (testEnv) => JSON.parse(fs.readFileSync(path.join(stateDir(testEnv), "stop-review-last.json"), "utf8"));
  const history = (testEnv) => fs.readFileSync(path.join(stateDir(testEnv), "stop-review-history.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const allowStream = [
    partial(call("srvtoolu_a")),
    full([call("srvtoolu_a"), reply("srvtoolu_a")]),
    ...MALFORMED,
    terminal({ result: "ALLOW: fixture" }),
  ];

  it("stores bounded telemetry in the snapshot and history without the payload", () => {
    const testEnv = prepare(allowStream);
    const result = stop(testEnv);
    assert.equal(result.status, 0, result.stderr);
    const record = snapshot(testEnv);
    assert.equal(record.status, "allow");
    assert.equal(record.claudeInvoked, true);
    assert.equal(record.advisor.requested, "fable");
    assert.equal(record.advisor.calls, 1);
    assert.equal(history(testEnv).at(-1).advisor.calls, 1);
    assertNoPayload(result.stdout + result.stderr, "Stop hook output");
    assertTreeHasNoPayload(testEnv.homeDir);
  });

  it("completes the review when the spawn-time diagnostic snapshot cannot be written", () => {
    const testEnv = prepare([terminal({ result: "ALLOW: fixture" })]);
    const preload = path.join(testEnv.rootDir, "fault.mjs");
    fs.writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const write = fs.writeFileSync;
let thrown = false;
fs.writeFileSync = function (file, data, ...rest) {
  if (!thrown && String(file).includes("stop-review-last.json.tmp.")) {
    let record = null;
    try { record = JSON.parse(data); } catch {}
    if (record?.status === "running_claude_review" && record.claudeInvoked === true) {
      thrown = true;
      throw Object.assign(new Error("fixture ENOSPC snapshot"), { code: "ENOSPC" });
    }
  }
  return write.call(this, file, data, ...rest);
};
syncBuiltinESMExports();
`);
    const result = stop(testEnv, ["--import", preload]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "", "the gate allows the stop");
    const record = snapshot(testEnv);
    assert.equal(record.status, "allow");
    assert.equal(record.claudeInvoked, true);
    assert.equal(history(testEnv).at(-1).status, "allow");
    assert.match(result.stderr, /could not record the running Stop review snapshot/i);
  });
});
