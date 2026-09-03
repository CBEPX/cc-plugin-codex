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
  GROK_READ_ONLY_TOOLS,
  GROK_REVIEW_TOOLS,
  buildGrokArgs,
  classifyGrokFailure,
  getGrokAuthStatus,
  getGrokAvailability,
  parseGrokJsonResult,
  resolveGrokCommand,
  resolveGrokEffort,
  resolveGrokModel,
  runGrokReview,
  runGrokTurn,
} from "../scripts/lib/grok-cli.mjs";

function createFakeGrokCommand(tmpDir, source) {
  const fakeGrok = path.join(tmpDir, "grok.js");
  fs.writeFileSync(fakeGrok, source);
  const launcher = path.join(tmpDir, process.platform === "win32" ? "grok.cmd" : "grok");
  if (process.platform === "win32") {
    fs.writeFileSync(
      launcher,
      `@ECHO off\r\n"${process.execPath}" "${fakeGrok}" %*\r\n`
    );
  } else {
    fs.writeFileSync(
      launcher,
      `#!/bin/sh\nexec "${process.execPath}" "${fakeGrok}" "$@"\n`
    );
    fs.chmodSync(launcher, 0o755);
  }
  return { fakeGrok, launcher };
}

describe("resolveGrokModel / resolveGrokEffort", () => {
  it("omits empty models instead of defaulting to Claude aliases", () => {
    assert.equal(resolveGrokModel(undefined), undefined);
    assert.equal(resolveGrokModel("  "), undefined);
    assert.equal(resolveGrokModel("grok-4.6"), "grok-4.6");
  });

  it("passes Grok effort values through without Claude remapping", () => {
    assert.equal(resolveGrokEffort(undefined), undefined);
    assert.equal(resolveGrokEffort("none"), "none");
    assert.equal(resolveGrokEffort("minimal"), "minimal");
    assert.equal(resolveGrokEffort("xhigh"), "xhigh");
    assert.throws(() => resolveGrokEffort("ludicrous"), /Unsupported effort/);
  });
});

describe("buildGrokArgs", () => {
  it("uses --prompt-file and json output instead of claude -p stdin flags", () => {
    const args = buildGrokArgs({
      promptFile: "/tmp/prompt.txt",
      model: "grok-4.6",
      effort: "high",
      tools: GROK_REVIEW_TOOLS,
    });

    assert.equal(args.includes("-p"), false);
    assert.deepEqual(args.slice(0, 4), [
      "--prompt-file",
      "/tmp/prompt.txt",
      "--output-format",
      "json",
    ]);
    assert.ok(args.includes("--always-approve"));
    assert.ok(args.includes("--model"));
    assert.equal(args[args.indexOf("--model") + 1], "grok-4.6");
    assert.equal(args[args.indexOf("--effort") + 1], "high");
    assert.equal(
      args[args.indexOf("--tools") + 1],
      GROK_REVIEW_TOOLS.join(",")
    );
    assert.equal(args.includes("--output-format") && args.includes("stream-json"), false);
    assert.equal(args.includes("--allowedTools"), false);
    assert.equal(args.includes("--verbose"), false);
  });

  it("forwards resume, schema, and max-turns when provided", () => {
    const args = buildGrokArgs({
      promptFile: "/tmp/prompt.txt",
      resumeSessionId: "sess-1",
      jsonSchema: { type: "object" },
      maxTurns: 8,
      alwaysApprove: false,
    });

    assert.equal(args[args.indexOf("--resume") + 1], "sess-1");
    assert.equal(args[args.indexOf("--max-turns") + 1], "8");
    assert.equal(
      args[args.indexOf("--json-schema") + 1],
      JSON.stringify({ type: "object" })
    );
    assert.equal(args.includes("--always-approve"), false);
  });
});

describe("parseGrokJsonResult", () => {
  it("reads text, sessionId, and a single modelUsage key", () => {
    const parsed = parseGrokJsonResult(
      JSON.stringify({
        text: "looks good",
        sessionId: "abc",
        stopReason: "end_turn",
        modelUsage: {
          "grok-4.6": { inputTokens: 10, outputTokens: 4, contextWindow: 2000000 },
        },
      })
    );

    assert.equal(parsed.text, "looks good");
    assert.equal(parsed.sessionId, "abc");
    assert.equal(parsed.finalModel, "grok-4.6");
    assert.equal(parsed.contextWindow, 2000000);
    assert.equal(parsed.structuredOutput, null);
  });

  it("prefers structured JSON text as structuredOutput when parseable", () => {
    const parsed = parseGrokJsonResult(
      JSON.stringify({
        text: '{"summary":"risk"}',
        sessionId: "s2",
      })
    );
    assert.deepEqual(parsed.structuredOutput, { summary: "risk" });
  });

  it("throws on empty or non-JSON stdout", () => {
    assert.throws(() => parseGrokJsonResult(""), /Grok JSON output/);
    assert.throws(() => parseGrokJsonResult("not json"), /Grok JSON output/);
  });
});

describe("classifyGrokFailure", () => {
  it("classifies authentication and rate-limit stderr", () => {
    assert.equal(
      classifyGrokFailure({ stderr: "Not logged in. Run grok login.", exitCode: 1 })
        ?.kind,
      "grok_auth"
    );
    assert.equal(
      classifyGrokFailure({ stderr: "HTTP 429 rate limit", exitCode: 1 })?.kind,
      "grok_rate_limit"
    );
    assert.equal(classifyGrokFailure({ stderr: "boom", exitCode: 1 }), null);
  });
});

describe("resolveGrokCommand / availability", () => {
  it("resolves grok on non-Windows without searching PATH", () => {
    assert.deepEqual(resolveGrokCommand("linux", { PATH: "/missing" }), {
      executable: "grok",
      prefixArgs: [],
    });
  });

  it("resolves a native grok.exe on Windows PATH", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-grok-native-"));
    try {
      const nativeExecutable = path.join(tmpDir, "grok.exe");
      fs.writeFileSync(nativeExecutable, "");
      assert.deepEqual(resolveGrokCommand("win32", { PATH: tmpDir }), {
        executable: nativeExecutable,
        prefixArgs: [],
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports availability and API-key auth from the same PATH-resolved command", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-grok-status-"));
    const oldPath = process.env.PATH ?? "";
    const oldKey = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      createFakeGrokCommand(
        tmpDir,
        `const args = process.argv.slice(2);\nif (args[0] === "--version") process.stdout.write("1.0.13\\n");\nprocess.exit(args[0] === "--version" ? 0 : 1);\n`
      );
      process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;

      assert.deepEqual(getGrokAvailability(process.cwd()), {
        available: true,
        detail: "1.0.13",
      });
      assert.deepEqual(
        getGrokAuthStatus(process.cwd(), { XAI_API_KEY: "test-key" }),
        { available: true, loggedIn: true, detail: "API key configured" }
      );
      const grokHome = path.join(tmpDir, "home");
      fs.mkdirSync(grokHome);
      fs.writeFileSync(path.join(grokHome, "auth.json"), "{}");
      assert.deepEqual(getGrokAuthStatus(process.cwd(), {}, { grokHome }), {
        available: true,
        loggedIn: true,
        detail: "authenticated",
      });
      assert.equal(
        getGrokAuthStatus(process.cwd(), {}, { grokHome: path.join(tmpDir, "empty") })
          .loggedIn,
        false
      );
    } finally {
      process.env.PATH = oldPath;
      if (oldKey === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = oldKey;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("runGrokTurn", () => {
  it("writes the prompt to a file and parses Grok json stdout", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-grok-run-"));
    const oldPath = process.env.PATH ?? "";
    const argvFile = path.join(tmpDir, "argv.json");
    try {
      createFakeGrokCommand(
        tmpDir,
        `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));
const promptFile = args[args.indexOf("--prompt-file") + 1];
const prompt = fs.readFileSync(promptFile, "utf8");
process.stdout.write(JSON.stringify({
  text: "echo:" + prompt,
  sessionId: "grok-sess-1",
  modelUsage: { "grok-4.6": { inputTokens: 1, outputTokens: 2 } },
}));
`
      );
      process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;

      const result = await runGrokTurn(process.cwd(), "review this diff", {
        model: "grok-4.6",
        tools: GROK_REVIEW_TOOLS,
      });
      const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));

      assert.equal(result.status, "completed");
      assert.equal(result.sessionId, "grok-sess-1");
      assert.equal(result.finalMessage, "echo:review this diff");
      assert.equal(result.finalModel, "grok-4.6");
      assert.equal(result.requestedModel, "grok-4.6");
      assert.equal(typeof result.pid, "number");
      assert.equal(argv.includes("-p"), false);
      assert.equal(argv[argv.indexOf("--prompt-file") + 1].includes("cc-grok-"), true);
      assert.equal(argv.includes("--always-approve"), true);
      assert.equal(argv[argv.indexOf("--tools") + 1], GROK_REVIEW_TOOLS.join(","));
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("maps a review turn onto the Grok read-only tool allowlist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-grok-review-"));
    const oldPath = process.env.PATH ?? "";
    const argvFile = path.join(tmpDir, "argv.json");
    try {
      createFakeGrokCommand(
        tmpDir,
        `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));
process.stdout.write(JSON.stringify({ text: "ok", sessionId: "rev-1" }));
`
      );
      process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;

      const result = await runGrokReview(process.cwd(), "review");
      const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));

      assert.equal(result.status, "completed");
      assert.equal(result.result, "ok");
      assert.equal(result.sessionId, "rev-1");
      assert.equal(argv[argv.indexOf("--tools") + 1], GROK_REVIEW_TOOLS.join(","));
      assert.deepEqual(GROK_REVIEW_TOOLS, [
        "read_file",
        "grep",
        "list_dir",
        "web_search",
        "web_fetch",
      ]);
      assert.deepEqual(GROK_READ_ONLY_TOOLS, GROK_REVIEW_TOOLS);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails closed when Grok prints non-JSON stdout", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-grok-badjson-"));
    const oldPath = process.env.PATH ?? "";
    try {
      createFakeGrokCommand(
        tmpDir,
        `process.stdout.write("plain text");\nprocess.exit(0);\n`
      );
      process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;

      const result = await runGrokTurn(process.cwd(), "prompt");
      assert.equal(result.status, "failed");
      assert.match(result.stderr, /Grok JSON output/);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

