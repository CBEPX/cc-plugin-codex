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

import * as cli from "../scripts/lib/claude-cli.mjs";
import { isProcessAlive } from "../scripts/lib/process.mjs";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION = path.join(PROJECT_ROOT, "scripts", "claude-companion.mjs");
const STOP_HOOK = path.join(PROJECT_ROOT, "hooks", "stop-review-gate-hook.mjs");
const DISABLE = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL";
const cleanups = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

// The fake CLI records every "-p" turn (argv, prompt, advisor env) in FAKE_LOG
// and every invocation in FAKE_INVOKE_LOG, so tests prove behavior at the process boundary.
function writeFakeClaude(binDir) {
  const filePath = path.join(binDir, "claude");
  fs.writeFileSync(filePath, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_INVOKE_LOG) fs.appendFileSync(process.env.FAKE_INVOKE_LOG, JSON.stringify(args) + "\\n");
async function main() {
  if (args[0] === "--version") return void process.stdout.write((process.env.FAKE_VERSION ?? "2.1.296 (Claude Code)") + "\\n");
  if (args[0] === "auth") return void process.stdout.write('{"loggedIn":true}\\n');
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  const resumeAt = args.indexOf("--resume");
  const sid = resumeAt >= 0 ? args[resumeAt + 1] : "sess-" + process.pid + "-" + Date.now();
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
    args, prompt, cwd: process.cwd(),
    disable: process.env.${DISABLE} ?? null,
    other: process.env.CC76_OTHER ?? null,
  }) + "\\n");
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sid, model: "claude-sonnet-5-5" }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: sid, result: process.env.FAKE_RESULT ?? "ALLOW: ok", model: "claude-sonnet-5-5" }));
}
main();
`, { mode: 0o755 });
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function createEnvironment() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-advisor-controls-"));
  cleanups.push(() => fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
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
  const promptFile = path.join(rootDir, "prompt.txt");
  fs.writeFileSync(promptFile, "/simplify preserve this prompt exactly");
  return {
    rootDir,
    workspaceDir,
    promptFile,
    log: path.join(rootDir, "turns.jsonl"),
    invokeLog: path.join(rootDir, "invocations.jsonl"),
    env: {
      PATH: `${binDir}${path.delimiter}${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODEX_HOME: path.join(homeDir, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(homeDir, ".claude"),
      CLAUDE_COMPANION_SESSION_ID: "advisor-owner-a",
      FAKE_LOG: path.join(rootDir, "turns.jsonl"),
      FAKE_INVOKE_LOG: path.join(rootDir, "invocations.jsonl"),
      CC76_OTHER: "unchanged",
    },
  };
}

function readLines(file) {
  return fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

const turnsOf = (testEnv) => readLines(testEnv.log);
const advisorArg = (turn) => {
  const index = turn.args.indexOf("--advisor");
  return index < 0 ? null : turn.args[index + 1];
};

function runCompanion(testEnv, args, extraEnv = {}, input = undefined) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: testEnv.workspaceDir,
    env: { ...testEnv.env, ...extraEnv },
    encoding: "utf8",
    input,
    timeout: 60_000,
  });
}

const taskArgs = (testEnv, flags = []) => [
  "task", ...flags, "--model", "claude-sonnet-5-5", "--effort", "high",
  "--poll-interval-ms", "100", "--wait-timeout-ms", "20000", "--prompt-file", testEnv.promptFile,
];

// Runs one companion task and returns the single native turn it produced.
function task(testEnv, flags = [], extraEnv = {}) {
  const before = turnsOf(testEnv).length;
  const result = runCompanion(testEnv, taskArgs(testEnv, flags), extraEnv);
  assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-1500));
  const added = turnsOf(testEnv).slice(before);
  assert.equal(added.length, 1, "exactly one native turn");
  return added[0];
}

function expectRefusal(testEnv, args, extraEnv, pattern) {
  const before = turnsOf(testEnv).length;
  const result = runCompanion(testEnv, args, extraEnv);
  assert.notEqual(result.status, 0, "the request must be refused");
  assert.equal(turnsOf(testEnv).length, before, "a refusal must precede any model turn");
  assert.match(result.stdout + result.stderr, pattern);
  return result;
}

function stateDir(testEnv) {
  const hash = createHash("sha256")
    .update(fs.realpathSync.native(testEnv.workspaceDir))
    .digest("hex")
    .slice(0, 12);
  return path.join(testEnv.env.CODEX_HOME, "plugins", "data", "cc", "state", hash);
}

function storedJobs(testEnv) {
  const jobsDir = path.join(stateDir(testEnv), "jobs");
  return fs.readdirSync(jobsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ file: path.join(jobsDir, name), job: JSON.parse(fs.readFileSync(path.join(jobsDir, name), "utf8")) }))
    .sort((a, b) => String(a.job.createdAt).localeCompare(String(b.job.createdAt)));
}

function waitForDetachedJob(testEnv, launch) {
  const { jobId } = JSON.parse(launch.stdout);
  const workerPid = storedJobs(testEnv).find(({ job }) => job.id === jobId)?.job.workerPid;
  const terminal = runCompanion(testEnv, ["status", jobId, "--wait", "--wait-timeout-ms", "30000", "--json"]);
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.equal(JSON.parse(terminal.stdout).job.status, "completed");
  // Terminal state can precede the detached worker's final log close.
  const deadline = Date.now() + 30_000;
  while (Number.isInteger(workerPid) && workerPid > 0 && isProcessAlive(workerPid)) {
    assert.ok(Date.now() < deadline, "detached worker did not exit before cleanup");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

describe("advisor policy primitives", () => {
  it("normalizes omission, keywords, aliases, and model ids", () => {
    assert.equal(cli.normalizeAdvisorPolicy(undefined), undefined);
    assert.equal(cli.normalizeAdvisorPolicy(null), undefined);
    assert.equal(cli.normalizeAdvisorPolicy("inherit"), "inherit");
    assert.equal(cli.normalizeAdvisorPolicy(" INHERIT "), "inherit");
    assert.equal(cli.normalizeAdvisorPolicy("Off"), "off");
    assert.equal(cli.normalizeAdvisorPolicy("Fable"), "fable");
    assert.equal(cli.normalizeAdvisorPolicy("claude-fable-5-1"), "claude-fable-5-1");
    assert.equal(cli.normalizeAdvisorPolicy("claude-opus-5-5[1m]"), "claude-opus-5-5[1m]");
  });

  for (const bad of ["", "   ", "--help", "-x", "two words", "fable;rm", "a".repeat(101), "fa\nble", "$(x)"]) {
    it(`rejects ${JSON.stringify(bad.slice(0, 20))} as an advisor value`, () => {
      assert.throws(
        () => cli.normalizeAdvisorPolicy(bad),
        (/** @type {any} */ error) => error.code === "CLAUDE_ADVISOR_INVALID" && /advisor/i.test(error.message)
      );
    });
  }

  it("adds --advisor to argv only for an explicit model", () => {
    const argsFor = (advisor) => cli.buildArgs("p", { advisor });
    assert.equal(argsFor(undefined).includes("--advisor"), false);
    assert.equal(argsFor("inherit").includes("--advisor"), false);
    assert.equal(argsFor("off").includes("--advisor"), false);
    const args = argsFor("fable");
    assert.equal(args[args.indexOf("--advisor") + 1], "fable");
    assert.throws(() => argsFor("bad value"), { code: "CLAUDE_ADVISOR_INVALID" });
  });

  it("states the stable-version floor for an explicit advisor", () => {
    assert.equal(cli.MIN_ADVISOR_CLAUDE_VERSION, "2.1.293");
  });
});

describe("runClaudeTurn advisor environment", () => {
  function withFakeClaude(env, run) {
    const testEnv = createEnvironment();
    const saved = { ...process.env };
    Object.assign(process.env, testEnv.env, env);
    return Promise.resolve(run(testEnv)).finally(() => {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    });
  }

  it("omission and inherit leave the child environment and the parent environment unchanged", () =>
    withFakeClaude({}, async (testEnv) => {
      for (const advisor of [undefined, "inherit"]) {
        await cli.runClaudeTurn(testEnv.workspaceDir, "hello", { advisor });
      }
      assert.deepEqual(turnsOf(testEnv).map((turn) => turn.disable), [null, null]);
      assert.equal(process.env[DISABLE], undefined);
    }));

  it("off sets the disable variable only in the child and keeps unrelated variables", () =>
    withFakeClaude({}, async (testEnv) => {
      await cli.runClaudeTurn(testEnv.workspaceDir, "hello", { advisor: "off" });
      const [turn] = turnsOf(testEnv);
      assert.equal(turn.disable, "1");
      assert.equal(turn.other, "unchanged");
      assert.equal(turn.args.includes("--advisor"), false);
      assert.equal(process.env[DISABLE], undefined, "the parent environment must not change");
    }));

  it("keeps an inherited global disable for inherit and for an explicit model", () =>
    withFakeClaude({ [DISABLE]: "1" }, async (testEnv) => {
      await cli.runClaudeTurn(testEnv.workspaceDir, "hello", { advisor: "inherit" });
      await cli.runClaudeTurn(testEnv.workspaceDir, "hello", { advisor: "fable" });
      const turns = turnsOf(testEnv);
      assert.deepEqual(turns.map((turn) => turn.disable), ["1", "1"]);
      assert.equal(advisorArg(turns[1]), "fable");
      assert.equal(process.env[DISABLE], "1");
    }));

  it("rejects an unsupported or unverifiable CLI before it spawns Claude", async () => {
    // Sequential: each scenario swaps the shared process environment.
    for (const version of ["2.1.292 (Claude Code)", "2.1.293-rc.1 (Claude Code)", "not a version"]) {
      await withFakeClaude({ FAKE_VERSION: version }, async (testEnv) => {
        let spawned = false;
        await assert.rejects(
          cli.runClaudeTurn(testEnv.workspaceDir, "hello", { advisor: "fable", onSpawn: () => { spawned = true; } }),
          (/** @type {any} */ error) => error.code === "CLAUDE_ADVISOR_UNSUPPORTED" && /2\.1\.293/.test(error.message)
        );
        assert.equal(spawned, false);
        assert.equal(turnsOf(testEnv).length, 0);
        assert.equal(
          readLines(testEnv.invokeLog).some((args) => args.includes("--help")),
          false,
          "the hidden flag must not be discovered through --help"
        );
        // Without an explicit model the same old CLI still works.
        await cli.runClaudeTurn(testEnv.workspaceDir, "hello", { advisor: "off" });
        assert.equal(turnsOf(testEnv).length, 1);
      });
    }
  });

  it("accepts the exact floor version", () =>
    withFakeClaude({ FAKE_VERSION: "2.1.293 (Claude Code)" }, async (testEnv) => {
      await cli.runClaudeTurn(testEnv.workspaceDir, "hello", { advisor: "fable" });
      assert.equal(advisorArg(turnsOf(testEnv)[0]), "fable");
    }));
});

describe("task advisor policy", () => {
  it("forwards no advisor argument or disable variable when the flag is omitted", () => {
    const testEnv = createEnvironment();
    const turn = task(testEnv, ["--fresh"]);
    assert.equal(advisorArg(turn), null);
    assert.equal(turn.disable, null);
    assert.equal(turn.other, "unchanged");
    assert.equal(turn.prompt, "/simplify preserve this prompt exactly");
  });

  it("forwards an alias or id through native --advisor and keeps the prompt exact", () => {
    const testEnv = createEnvironment();
    assert.equal(advisorArg(task(testEnv, ["--fresh", "--advisor", "Fable"])), "fable");
    const turn = task(testEnv, ["--fresh", "--advisor=claude-fable-5-1"]);
    assert.equal(advisorArg(turn), "claude-fable-5-1");
    assert.equal(turn.prompt, "/simplify preserve this prompt exactly");
  });

  it("turns the advisor off only for the child and does not unset an inherited disable", () => {
    const testEnv = createEnvironment();
    const off = task(testEnv, ["--fresh", "--advisor", "off"]);
    assert.equal(off.disable, "1");
    assert.equal(advisorArg(off), null);
    assert.equal(off.other, "unchanged");
    const inherited = task(testEnv, ["--fresh", "--advisor", "inherit"], { [DISABLE]: "1" });
    assert.equal(inherited.disable, "1");
    const explicit = task(testEnv, ["--fresh", "--advisor", "fable"], { [DISABLE]: "1" });
    assert.equal(advisorArg(explicit), "fable");
    assert.equal(explicit.disable, "1");
  });

  for (const [name, value] of [["empty", ""], ["blank", " "], ["flag-like", "--bad"], ["spaced", "two words"], ["shell", "fable;x"]]) {
    it(`refuses a ${name} advisor value before any model turn`, () => {
      const testEnv = createEnvironment();
      expectRefusal(testEnv, taskArgs(testEnv, ["--fresh", `--advisor=${value}`]), {}, /advisor/i);
      assert.equal(readLines(testEnv.invokeLog).some((args) => args[0] === "-p"), false);
    });
  }

  it("refuses a missing advisor value", () => {
    const testEnv = createEnvironment();
    expectRefusal(testEnv, [...taskArgs(testEnv, ["--fresh"]), "--advisor"], {}, /Missing value for --advisor/);
  });

  it("refuses an explicit advisor on an unsupported CLI without retrying, discovering, or unsetting", () => {
    const testEnv = createEnvironment();
    for (const version of ["2.1.292 (Claude Code)", "2.1.293-beta.1 (Claude Code)", "garbage"]) {
      expectRefusal(testEnv, taskArgs(testEnv, ["--fresh", "--advisor", "fable"]), { FAKE_VERSION: version }, /advisor.*2\.1\.293|2\.1\.293.*advisor/is);
    }
    assert.equal(readLines(testEnv.invokeLog).some((args) => args.includes("--help")), false);
    assert.equal(turnsOf(testEnv).length, 0);
    // Keyword policies need no capability, so an old CLI still runs them.
    assert.equal(task(testEnv, ["--fresh", "--advisor", "off"], { FAKE_VERSION: "2.1.100 (Claude Code)" }).disable, "1");
  });

  it("releases an explicit job reservation when the advisor is refused", () => {
    const testEnv = createEnvironment();
    const reserved = runCompanion(testEnv, ["task-reserve-job", "--cwd", testEnv.workspaceDir, "--json"]);
    assert.equal(reserved.status, 0, reserved.stderr);
    const jobId = JSON.parse(reserved.stdout).jobId;
    assert.ok(jobId, "reservation output must expose the job id");
    expectRefusal(testEnv, taskArgs(testEnv, ["--fresh", "--job-id", jobId, "--advisor", "bad value"]), {}, /advisor/i);
    const jobsDir = path.join(stateDir(testEnv), "jobs");
    assert.equal(fs.existsSync(path.join(jobsDir, `${jobId}.reserve`)), false);
  });

  it("persists the normalized policy in the foreground request and the detached request", () => {
    const testEnv = createEnvironment();
    task(testEnv, ["--fresh", "--advisor", "Fable"]);
    const background = runCompanion(testEnv, [...taskArgs(testEnv, ["--fresh", "--background", "--advisor", "off"]), "--json"]);
    assert.equal(background.status, 0, background.stderr);
    waitForDetachedJob(testEnv, background);
    const requests = storedJobs(testEnv).map(({ job }) => job.request?.advisor);
    assert.deepEqual(requests, ["fable", "off"]);
    assert.equal(turnsOf(testEnv)[1].disable, "1", "the detached worker must forward the stored policy");
  });
});

describe("resume policy", () => {
  it("preserves the originating policy when the flag is omitted and resets on explicit inherit", () => {
    const testEnv = createEnvironment();
    task(testEnv, ["--fresh", "--advisor", "fable"]);
    const kept = task(testEnv, ["--resume"]);
    assert.ok(kept.args.includes("--resume"));
    assert.equal(advisorArg(kept), "fable");
    const reset = task(testEnv, ["--resume", "--advisor", "inherit"]);
    assert.ok(reset.args.includes("--resume"));
    assert.equal(advisorArg(reset), null);
    assert.equal(reset.disable, null);
    const afterReset = task(testEnv, ["--resume"]);
    assert.equal(advisorArg(afterReset), null, "inherit is the new originating policy");
    assert.equal(storedJobs(testEnv).at(-1).job.request.advisor, undefined, "inherit is stored as no policy");
  });

  it("preserves off on resume and lets a new explicit value replace it", () => {
    const testEnv = createEnvironment();
    task(testEnv, ["--fresh", "--advisor", "off"]);
    assert.equal(task(testEnv, ["--resume"]).disable, "1");
    const replaced = task(testEnv, ["--resume", "--advisor", "fable"]);
    assert.equal(advisorArg(replaced), "fable");
    assert.equal(replaced.disable, null);
    assert.equal(advisorArg(task(testEnv, ["--resume"])), "fable");
  });

  it("does not carry a previous override into a fresh task", () => {
    const testEnv = createEnvironment();
    task(testEnv, ["--fresh", "--advisor", "fable"]);
    const fresh = task(testEnv, ["--fresh"]);
    assert.equal(advisorArg(fresh), null);
    assert.equal(fresh.disable, null);
  });

  it("selects the policy from the resuming owner, never from another owner's newer task", () => {
    const testEnv = createEnvironment();
    const ownerB = { CLAUDE_COMPANION_SESSION_ID: "advisor-owner-b" };
    task(testEnv, ["--fresh", "--advisor", "off"], ownerB);
    task(testEnv, ["--fresh", "--advisor", "fable"]);
    task(testEnv, ["--fresh", "--advisor", "fable"], { CLAUDE_COMPANION_SESSION_ID: "advisor-owner-c" });
    const resumed = task(testEnv, ["--resume"], ownerB);
    assert.equal(resumed.disable, "1");
    assert.equal(advisorArg(resumed), null);
    const ownerA = task(testEnv, ["--resume"]);
    assert.equal(advisorArg(ownerA), "fable");
    expectRefusal(testEnv, taskArgs(testEnv, ["--resume"]), { CLAUDE_COMPANION_SESSION_ID: "advisor-owner-d" }, /No previous Claude Code task session/);
  });

  it("reads records written before the field existed as inherit", () => {
    const testEnv = createEnvironment();
    task(testEnv, ["--fresh", "--advisor", "fable"]);
    const { file, job } = storedJobs(testEnv)[0];
    delete job.request.advisor;
    fs.writeFileSync(file, JSON.stringify(job));
    const resumed = task(testEnv, ["--resume"]);
    assert.equal(advisorArg(resumed), null);
    assert.equal(resumed.disable, null);
    delete job.request;
    fs.writeFileSync(file, JSON.stringify(job));
    const noRequest = task(testEnv, ["--resume"]);
    assert.equal(advisorArg(noRequest), null);
  });

  it("fails closed before a turn when a stored policy is corrupt", () => {
    const testEnv = createEnvironment();
    task(testEnv, ["--fresh"]);
    const { file, job } = storedJobs(testEnv)[0];
    job.request.advisor = "bad value!";
    fs.writeFileSync(file, JSON.stringify(job));
    expectRefusal(testEnv, taskArgs(testEnv, ["--resume"]), {}, /advisor/i);
  });

  it("requires the preserved explicit model to pass the version check on resume", () => {
    const testEnv = createEnvironment();
    task(testEnv, ["--fresh", "--advisor", "fable"]);
    expectRefusal(testEnv, taskArgs(testEnv, ["--resume"]), { FAKE_VERSION: "2.1.292 (Claude Code)" }, /2\.1\.293/);
    // The operator can reset the policy explicitly on the same old CLI.
    assert.equal(advisorArg(task(testEnv, ["--resume", "--advisor", "inherit"], { FAKE_VERSION: "2.1.292 (Claude Code)" })), null);
  });
});

describe("review advisor policy", () => {
  const reviews = [
    ["review", ["review", "--scope", "working-tree"]],
    ["adversarial-review", ["adversarial-review", "--scope", "working-tree"]],
  ];

  for (const [name, base] of reviews) {
    it(`${name} forwards an explicit model next to the isolation flags`, () => {
      const testEnv = createEnvironment();
      const result = runCompanion(testEnv, [...base, "--model", "claude-sonnet-5-5", "--advisor", "fable"]);
      assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-1500));
      const [turn] = turnsOf(testEnv);
      assert.equal(advisorArg(turn), "fable");
      assert.equal(turn.disable, null);
      assert.ok(turn.args.includes("--strict-mcp-config"));
      assert.equal(turn.args[turn.args.indexOf("--setting-sources") + 1], "user");
    });

    it(`${name} supports off, inherit and an inherited global disable`, () => {
      const testEnv = createEnvironment();
      const flagged = (value, extra = {}) => {
        const before = turnsOf(testEnv).length;
        const result = runCompanion(testEnv, [...base, "--model", "claude-sonnet-5-5", ...(value ? ["--advisor", value] : [])], extra);
        assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-1500));
        return turnsOf(testEnv)[before];
      };
      assert.equal(flagged("off").disable, "1");
      assert.equal(flagged("inherit").disable, null);
      assert.equal(flagged(null).disable, null);
      const inherited = flagged("fable", { [DISABLE]: "1" });
      assert.equal(inherited.disable, "1");
      assert.equal(advisorArg(inherited), "fable");
    });

    it(`${name} refuses an unsupported CLI or invalid value before a model turn`, () => {
      const testEnv = createEnvironment();
      expectRefusal(testEnv, [...base, "--advisor", "fable"], { FAKE_VERSION: "2.1.292 (Claude Code)" }, /2\.1\.293/);
      expectRefusal(testEnv, [...base, "--advisor", "bad value"], {}, /advisor/i);
    });
  }

  it("adversarial review keeps focus text next to the advisor routing option", () => {
    const testEnv = createEnvironment();
    const result = runCompanion(testEnv, ["adversarial-review", "--scope", "working-tree", "--advisor", "fable", "check", "auth", "paths"]);
    assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-1500));
    const [turn] = turnsOf(testEnv);
    assert.match(turn.prompt, /check auth paths/);
    assert.doesNotMatch(turn.prompt, /--advisor|fable/);
  });

  it("persists the policy for a detached review worker and forwards it", () => {
    const testEnv = createEnvironment();
    const result = runCompanion(testEnv, ["adversarial-review", "--scope", "working-tree", "--background", "--advisor", "off", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    waitForDetachedJob(testEnv, result);
    assert.equal(storedJobs(testEnv)[0].job.request.advisor, "off");
    assert.equal(turnsOf(testEnv)[0].disable, "1");
  });
});

describe("stop-review advisor configuration", () => {
  const configFile = (testEnv) => path.join(stateDir(testEnv), "config.json");
  const readConfig = (testEnv) => JSON.parse(fs.readFileSync(configFile(testEnv), "utf8"));
  const runtimeDir = (testEnv) => path.join(testEnv.env.CODEX_HOME, "plugins", "data", "cc", "runtime");

  it("stores, reports, resets, and preserves stopReviewAdvisor", () => {
    const testEnv = createEnvironment();
    const set = runCompanion(testEnv, ["setup", "--stop-review-advisor", "Fable", "--json"]);
    assert.equal(set.status, 0, set.stderr || set.stdout);
    assert.equal(readConfig(testEnv).stopReviewAdvisor, "fable");
    assert.equal(JSON.parse(set.stdout).stopReviewAdvisor, "fable");
    assert.equal(readConfig(testEnv).stopReviewGate, false);
    runCompanion(testEnv, ["setup", "--enable-review-gate", "--json"]);
    assert.equal(readConfig(testEnv).stopReviewAdvisor, "fable", "other setup actions preserve the policy");
    const off = runCompanion(testEnv, ["setup", "--stop-review-advisor", "off", "--json"]);
    assert.equal(JSON.parse(off.stdout).stopReviewAdvisor, "off");
    runCompanion(testEnv, ["setup", "--stop-review-advisor", "inherit", "--json"]);
    assert.equal(readConfig(testEnv).stopReviewAdvisor, "inherit");
    assert.equal(JSON.parse(runCompanion(testEnv, ["setup", "--check", "--json"]).stdout).stopReviewAdvisor, "inherit");
  });

  it("reports inherit for configuration written before the field existed", () => {
    const testEnv = createEnvironment();
    fs.mkdirSync(stateDir(testEnv), { recursive: true });
    fs.writeFileSync(configFile(testEnv), JSON.stringify({ version: 1, stopReviewGate: true }));
    assert.equal(JSON.parse(runCompanion(testEnv, ["setup", "--check", "--json"]).stdout).stopReviewAdvisor, "inherit");
  });

  it("rejects --check with a configuration change before any setup side effect", () => {
    const testEnv = createEnvironment();
    const result = runCompanion(testEnv, ["setup", "--check", "--stop-review-advisor", "fable", "--json"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /--check cannot be combined/);
    assert.equal(fs.existsSync(configFile(testEnv)), false);
    assert.equal(fs.existsSync(runtimeDir(testEnv)), false, "no hook launcher may be installed");
    assert.equal(fs.existsSync(path.join(testEnv.env.CODEX_HOME, "config.toml")), false);
  });

  it("rejects an invalid value or a missing value before any setup side effect", () => {
    const testEnv = createEnvironment();
    for (const args of [["--stop-review-advisor", "bad value"], ["--stop-review-advisor="], ["--stop-review-advisor"]]) {
      const result = runCompanion(testEnv, ["setup", ...args, "--json"]);
      assert.notEqual(result.status, 0, args.join(" "));
      assert.match(result.stdout + result.stderr, /advisor/i);
    }
    assert.equal(fs.existsSync(configFile(testEnv)), false);
    assert.equal(fs.existsSync(runtimeDir(testEnv)), false);
  });
});

describe("stop-review gate advisor policy", () => {
  function prepare(config) {
    const testEnv = createEnvironment();
    fs.mkdirSync(stateDir(testEnv), { recursive: true });
    fs.writeFileSync(path.join(stateDir(testEnv), "config.json"), JSON.stringify({ version: 1, stopReviewGate: true, ...config }));
    fs.writeFileSync(
      path.join(stateDir(testEnv), "turn-baseline.hook-session.json"),
      JSON.stringify({ sessionId: "hook-session", cwd: testEnv.workspaceDir, workspaceRoot: testEnv.workspaceDir, capturedAt: "2026-04-04T01:00:00Z", fingerprint: { signature: "stale-baseline" } })
    );
    return testEnv;
  }
  const stop = (testEnv, extraEnv = {}) => spawnSync(process.execPath, [STOP_HOOK], {
    cwd: PROJECT_ROOT,
    env: { ...testEnv.env, ...extraEnv },
    input: JSON.stringify({ cwd: testEnv.workspaceDir, session_id: "hook-session", last_assistant_message: "review me" }),
    encoding: "utf8",
    timeout: 60_000,
  });
  const snapshot = (testEnv) => JSON.parse(fs.readFileSync(path.join(stateDir(testEnv), "stop-review-last.json"), "utf8"));

  it("treats old configuration without the field as inherit", () => {
    const testEnv = prepare({});
    assert.equal(stop(testEnv).status, 0);
    const [turn] = turnsOf(testEnv);
    assert.equal(advisorArg(turn), null);
    assert.equal(turn.disable, null);
    assert.equal(snapshot(testEnv).status, "allow");
  });

  it("forwards an explicit model with the isolation flags", () => {
    const testEnv = prepare({ stopReviewAdvisor: "fable" });
    assert.equal(stop(testEnv).status, 0);
    const [turn] = turnsOf(testEnv);
    assert.equal(advisorArg(turn), "fable");
    assert.equal(turn.args[turn.args.indexOf("--setting-sources") + 1], "user");
    assert.ok(turn.args.includes("--strict-mcp-config"));
    assert.equal(snapshot(testEnv).claudeInvoked, true);
  });

  it("applies off to the child only and keeps an inherited disable for inherit", () => {
    const off = prepare({ stopReviewAdvisor: "off" });
    stop(off);
    assert.equal(turnsOf(off)[0].disable, "1");
    const inherit = prepare({ stopReviewAdvisor: "inherit" });
    stop(inherit, { [DISABLE]: "1" });
    assert.equal(turnsOf(inherit)[0].disable, "1");
    assert.equal(advisorArg(turnsOf(inherit)[0]), null);
  });

  /** @type {Array<[string, Record<string, string>, Record<string, string>, string, RegExp]>} */
  const refusals = [
    ["an unsupported CLI", { stopReviewAdvisor: "fable" }, { FAKE_VERSION: "2.1.292 (Claude Code)" }, "CLAUDE_ADVISOR_UNSUPPORTED", /2\.1\.293/],
    ["a corrupt configured value", { stopReviewAdvisor: "bad value!" }, {}, "CLAUDE_ADVISOR_INVALID", /advisor/i],
  ];
  for (const [name, config, env, code, pattern] of refusals) {
    it(`blocks with an operator handoff and claudeInvoked=false for ${name}`, () => {
      const testEnv = prepare(config);
      const first = stop(testEnv, env);
      assert.equal(first.status, 0, first.stderr);
      const decision = JSON.parse(first.stdout);
      assert.equal(decision.decision, "block");
      assert.match(decision.reason, pattern);
      assert.match(decision.reason, /Retrying the unchanged request cannot resolve this/);
      assert.match(decision.reason, /report this exact blocker to the user/);
      assert.match(decision.reason, /stop-review-advisor/);
      const record = snapshot(testEnv);
      assert.equal(record.status, "blocked_protection_refused");
      assert.equal(record.protectionCode, code);
      assert.equal(record.claudeInvoked, false);
      assert.equal(turnsOf(testEnv).length, 0);
      assert.equal(readLines(testEnv.invokeLog).some((args) => args.includes("--help")), false);
    });
  }
});

// ---------------------------------------------------------------------------
// Fix round 1 (Fable review): workflow-bound resume, non-string values, setup feedback
// ---------------------------------------------------------------------------

const OWNER_B = { CLAUDE_COMPANION_SESSION_ID: "advisor-owner-b" };

function companionJson(testEnv, args, extraEnv = {}, input = undefined) {
  const result = runCompanion(testEnv, args, extraEnv, input);
  assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-1500));
  return JSON.parse(result.stdout);
}

// Creates a generic workflow owned by owner A, runs one bound task under `flags`,
// and records that task's Claude session on the workflow.
function boundWorkflowTask(testEnv, id, flags) {
  const created = companionJson(testEnv, ["workflow-create", "--cwd", testEnv.workspaceDir, "--json"], {}, JSON.stringify({
    id, mode: "design", brief: `Workflow ${id}.`, originSessionId: "advisor-owner-a", stages: ["memo"], branches: ["alpha"],
  }));
  const turn = task(testEnv, ["--fresh", "--workflow-id", id, "--workflow-stage", "memo", ...flags]);
  const job = storedJobs(testEnv).map(({ job: stored }) => stored).filter((stored) => stored.workflowId === id).at(-1);
  const sessionId = job.result?.sessionId ?? job.threadId;
  assert.ok(sessionId, "the bound task must report its Claude session");
  const submitted = companionJson(testEnv, [
    "workflow-submit-stage", id, "--cwd", testEnv.workspaceDir, "--stage", "memo",
    "--revision", String(created.revision), "--epoch", String(created.epoch),
    "--claude-session-id", sessionId, "--json",
  ], {}, JSON.stringify({ note: "memo" }));
  return { turn, sessionId, workflow: submitted };
}

function rebind(testEnv, id, workflow, owner = "advisor-owner-b") {
  return companionJson(testEnv, [
    "workflow-rebind", id, "--cwd", testEnv.workspaceDir, "--revision", String(workflow.revision),
    "--epoch", String(workflow.epoch), "--owner-session-id", owner, "--json",
  ]);
}

const boundResume = (testEnv, id, flags = [], extraEnv = OWNER_B) =>
  task(testEnv, ["--resume", "--workflow-id", id, "--workflow-stage", "memo", ...flags], extraEnv);

describe("workflow-bound resume policy", () => {
  it("keeps off after an explicit owner rebind", () => {
    const testEnv = createEnvironment();
    const { workflow } = boundWorkflowTask(testEnv, "wf-off", ["--advisor", "off"]);
    rebind(testEnv, "wf-off", workflow);
    const resumed = boundResume(testEnv, "wf-off");
    assert.ok(resumed.args.includes("--resume"));
    assert.equal(resumed.disable, "1");
    assert.equal(advisorArg(resumed), null);
  });

  it("keeps an explicit model after an explicit owner rebind and stores it for the next resume", () => {
    const testEnv = createEnvironment();
    const { workflow } = boundWorkflowTask(testEnv, "wf-model", ["--advisor", "fable"]);
    rebind(testEnv, "wf-model", workflow);
    assert.equal(advisorArg(boundResume(testEnv, "wf-model")), "fable");
    assert.equal(advisorArg(boundResume(testEnv, "wf-model")), "fable");
  });

  it("resets on explicit inherit and keeps that reset", () => {
    const testEnv = createEnvironment();
    const { workflow } = boundWorkflowTask(testEnv, "wf-reset", ["--advisor", "fable"]);
    rebind(testEnv, "wf-reset", workflow);
    assert.equal(advisorArg(boundResume(testEnv, "wf-reset", ["--advisor", "inherit"])), null);
    assert.equal(advisorArg(boundResume(testEnv, "wf-reset")), null);
  });

  it("never takes the policy of an unrelated workflow or an unrelated owner", () => {
    const testEnv = createEnvironment();
    const { workflow } = boundWorkflowTask(testEnv, "wf-main", ["--advisor", "off"]);
    boundWorkflowTask(testEnv, "wf-other", ["--advisor", "fable"]);
    task(testEnv, ["--fresh", "--advisor", "fable"], OWNER_B);
    rebind(testEnv, "wf-main", workflow);
    const resumed = boundResume(testEnv, "wf-main");
    assert.equal(resumed.disable, "1");
    assert.equal(advisorArg(resumed), null);
  });

  it("still refuses a workflow that was not rebound to the resuming owner", () => {
    const testEnv = createEnvironment();
    boundWorkflowTask(testEnv, "wf-guard", ["--advisor", "off"]);
    expectRefusal(
      testEnv,
      taskArgs(testEnv, ["--resume", "--workflow-id", "wf-guard", "--workflow-stage", "memo"]),
      OWNER_B,
      /WORKFLOW_OWNER_MISMATCH/
    );
  });

  it("reads a bound task written before the field existed as inherit", () => {
    const testEnv = createEnvironment();
    const { workflow } = boundWorkflowTask(testEnv, "wf-old", ["--advisor", "fable"]);
    for (const { file, job } of storedJobs(testEnv)) {
      if (job.workflowId !== "wf-old") continue;
      delete job.request.advisor;
      fs.writeFileSync(file, JSON.stringify(job));
    }
    rebind(testEnv, "wf-old", workflow);
    const resumed = boundResume(testEnv, "wf-old");
    assert.equal(advisorArg(resumed), null);
    assert.equal(resumed.disable, null);
  });
});

describe("non-string persisted advisor values", () => {
  const malformed = [true, false, 7, ["fable"], {}];

  for (const value of malformed) {
    it(`normalizeAdvisorPolicy refuses ${JSON.stringify(value)} with a bounded message`, () => {
      assert.throws(
        () => cli.normalizeAdvisorPolicy(value),
        (/** @type {any} */ error) => error.code === "CLAUDE_ADVISOR_INVALID" && error.message.length < 200 && !error.message.includes("fable")
      );
    });
  }

  it("keeps absence and strings compatible", () => {
    assert.equal(cli.normalizeAdvisorPolicy(null), undefined);
    assert.equal(cli.normalizeAdvisorPolicy(undefined), undefined);
    assert.equal(cli.normalizeAdvisorPolicy("fable"), "fable");
  });

  for (const value of malformed) {
    it(`refuses task history holding ${JSON.stringify(value)} before a native turn`, () => {
      const testEnv = createEnvironment();
      task(testEnv, ["--fresh"]);
      const { file, job } = storedJobs(testEnv)[0];
      job.request.advisor = value;
      fs.writeFileSync(file, JSON.stringify(job));
      expectRefusal(testEnv, taskArgs(testEnv, ["--resume"]), {}, /CLAUDE_ADVISOR_INVALID|advisor/i);
    });

    it(`blocks the Stop gate for configuration holding ${JSON.stringify(value)} with claudeInvoked=false`, () => {
      const testEnv = createEnvironment();
      fs.mkdirSync(stateDir(testEnv), { recursive: true });
      fs.writeFileSync(path.join(stateDir(testEnv), "config.json"), JSON.stringify({ version: 1, stopReviewGate: true, stopReviewAdvisor: value }));
      fs.writeFileSync(
        path.join(stateDir(testEnv), "turn-baseline.hook-session.json"),
        JSON.stringify({ sessionId: "hook-session", cwd: testEnv.workspaceDir, workspaceRoot: testEnv.workspaceDir, capturedAt: "2026-04-04T01:00:00Z", fingerprint: { signature: "stale-baseline" } })
      );
      const result = spawnSync(process.execPath, [STOP_HOOK], {
        cwd: PROJECT_ROOT,
        env: testEnv.env,
        input: JSON.stringify({ cwd: testEnv.workspaceDir, session_id: "hook-session", last_assistant_message: "review me" }),
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).decision, "block");
      const record = JSON.parse(fs.readFileSync(path.join(stateDir(testEnv), "stop-review-last.json"), "utf8"));
      assert.equal(record.status, "blocked_protection_refused");
      assert.equal(record.protectionCode, "CLAUDE_ADVISOR_INVALID");
      assert.equal(record.claudeInvoked, false);
      assert.equal(turnsOf(testEnv).length, 0);
    });
  }
});

describe("setup advisor diagnostics", () => {
  const configFile = (testEnv) => path.join(stateDir(testEnv), "config.json");
  const writeConfig = (testEnv, extra) => {
    fs.mkdirSync(stateDir(testEnv), { recursive: true });
    fs.writeFileSync(configFile(testEnv), JSON.stringify({ version: 1, stopReviewGate: false, ...extra }));
  };
  const setup = (testEnv, args, extraEnv = {}) => runCompanion(testEnv, ["setup", ...args, "--json"], extraEnv);
  const steps = (report) => report.nextSteps.join("\n");

  for (const value of [true, 7, ["fable"], "bad value!"]) {
    it(`reports ${JSON.stringify(value)} as invalid, not inherit, with a repair step`, () => {
      const testEnv = createEnvironment();
      writeConfig(testEnv, { stopReviewAdvisor: value });
      const result = setup(testEnv, ["--check"]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const report = JSON.parse(result.stdout);
      assert.equal(report.stopReviewAdvisor, "invalid");
      assert.match(report.stopReviewAdvisorProblem, /advisor/i);
      assert.ok(report.stopReviewAdvisorProblem.length < 200);
      assert.match(steps(report), /--stop-review-advisor inherit/);
      const text = runCompanion(testEnv, ["setup", "--check"]).stdout;
      assert.match(text, /stop-review advisor: invalid/);
    });

    it(`lets setup --stop-review-advisor repair a configuration holding ${JSON.stringify(value)}`, () => {
      const testEnv = createEnvironment();
      writeConfig(testEnv, { stopReviewAdvisor: value });
      for (const repair of ["inherit", "off"]) {
        writeConfig(testEnv, { stopReviewAdvisor: value });
        const result = setup(testEnv, ["--stop-review-advisor", repair]);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const report = JSON.parse(result.stdout);
        assert.equal(report.stopReviewAdvisor, repair);
        assert.equal(report.stopReviewAdvisorProblem, undefined);
        assert.equal(JSON.parse(fs.readFileSync(configFile(testEnv), "utf8")).stopReviewAdvisor, repair);
      }
    });
  }

  it("explains the 2.1.293 prerequisite for a configured explicit model on an older CLI, and still writes it", () => {
    const testEnv = createEnvironment();
    const result = setup(testEnv, ["--stop-review-advisor", "fable"], { FAKE_VERSION: "2.1.292 (Claude Code)" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.stopReviewAdvisor, "fable");
    assert.match(steps(report), /2\.1\.293/);
    assert.match(steps(report), /fable/);
    assert.match(steps(report), /--stop-review-advisor inherit/);
    assert.equal(JSON.parse(fs.readFileSync(configFile(testEnv), "utf8")).stopReviewAdvisor, "fable");
    const check = JSON.parse(setup(testEnv, ["--check"], { FAKE_VERSION: "2.1.292 (Claude Code)" }).stdout);
    assert.match(steps(check), /2\.1\.293/);
    assert.match(runCompanion(testEnv, ["setup", "--check"], { FAKE_VERSION: "2.1.292 (Claude Code)" }).stdout, /2\.1\.293/);
  });

  it("treats an unverifiable version as not meeting the floor", () => {
    const testEnv = createEnvironment();
    writeConfig(testEnv, { stopReviewAdvisor: "fable" });
    assert.match(steps(JSON.parse(setup(testEnv, ["--check"], { FAKE_VERSION: "2.1.293-rc.1 (Claude Code)" }).stdout)), /2\.1\.293/);
  });

  it("gives no capability warning for inherit, off, absence, or a supported CLI", () => {
    const testEnv = createEnvironment();
    for (const [extra, version] of [
      [{ stopReviewAdvisor: "inherit" }, "2.1.292 (Claude Code)"],
      [{ stopReviewAdvisor: "off" }, "2.1.292 (Claude Code)"],
      [{}, "2.1.292 (Claude Code)"],
      [{ stopReviewAdvisor: "fable" }, "2.1.293 (Claude Code)"],
    ]) {
      writeConfig(testEnv, extra);
      const report = JSON.parse(setup(testEnv, ["--check"], { FAKE_VERSION: version }).stdout);
      assert.doesNotMatch(steps(report), /2\.1\.293/, JSON.stringify(extra) + version);
    }
  });
});
