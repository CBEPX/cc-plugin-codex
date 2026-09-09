/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import "./test-env.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  resolveStateDir,
  saveConfig,
} from "../scripts/lib/state.mjs";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const DIRECT_ENTRYPOINTS = [
  [
    "tests/read-views.test.mjs",
    "keeps small default result delivery complete",
  ],
  [
    "tests/integration/claude-companion.test.mjs",
    "setup toggles the review gate on and off",
  ],
  [
    "tests/e2e/peer-workflow-e2e.test.mjs",
    "peer workflow accepts selected Brave MCP evidence",
  ],
];

function createChildProbe() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-env-child-"));
  const originalHome = path.join(rootDir, "original-home");
  const tempDir = path.join(rootDir, "tmp");
  const sentinel = path.join(originalHome, "sentinel.txt");
  fs.mkdirSync(originalHome);
  fs.mkdirSync(tempDir);
  fs.writeFileSync(sentinel, "keep\n", "utf8");
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    HOME: originalHome,
    USERPROFILE: originalHome,
    CODEX_HOME: originalHome,
    CC_TEST_ORIGINAL_CODEX_HOME: originalHome,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
  };
  delete env.NODE_TEST_CONTEXT;
  return { rootDir, originalHome, tempDir, sentinel, env };
}

function assertChildProbeClean(probe) {
  assert.equal(fs.readFileSync(probe.sentinel, "utf8"), "keep\n");
  assert.deepEqual(fs.readdirSync(probe.originalHome), ["sentinel.txt"]);
  assert.deepEqual(fs.readdirSync(probe.tempDir), []);
}

it("routes state writes away from the original CODEX_HOME", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-env-repo-"));
  const init = spawnSync("git", ["init", "-q"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);

  try {
    const isolatedStateDir = resolveStateDir(repoDir);
    const originalStateDir = isolatedStateDir.replace(
      process.env.CODEX_HOME,
      process.env.CC_TEST_ORIGINAL_CODEX_HOME
    );

    assert.notEqual(process.env.CODEX_HOME, process.env.CC_TEST_ORIGINAL_CODEX_HOME);
    assert.ok(isolatedStateDir.startsWith(`${process.env.CODEX_HOME}${path.sep}`));
    assert.equal(fs.existsSync(originalStateDir), false);

    saveConfig(repoDir, { stopReviewGate: true });

    assert.equal(fs.existsSync(path.join(isolatedStateDir, "config.json")), true);
    assert.equal(fs.existsSync(originalStateDir), false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

it("preload lets a Claude-hosted integration task terminate and reap its Claude child", () => {
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
  };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./tests/test-env.mjs",
      "--test",
      "--test-name-pattern=reaps its Claude child after a foreground task",
      "tests/integration/claude-companion.test.mjs",
    ],
    {
      cwd: PROJECT_ROOT,
      env,
      encoding: "utf8",
      timeout: 30_000,
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /reaps its Claude child after a foreground task/);
  assert.match(result.stdout, /pass 1/);
});

it("isolates direct and preloaded stateful unit, integration, and E2E entrypoints", () => {
  for (const [entrypoint, pattern] of DIRECT_ENTRYPOINTS) {
    for (const preload of [false, true]) {
      const probe = createChildProbe();
      try {
        const result = spawnSync(
          process.execPath,
          [
            ...(preload ? ["--import", "./tests/test-env.mjs"] : []),
            "--test",
            `--test-name-pattern=${pattern}`,
            entrypoint,
          ],
          {
            cwd: PROJECT_ROOT,
            env: probe.env,
            encoding: "utf8",
            timeout: 30_000,
          }
        );

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assertChildProbeClean(probe);
      } finally {
        fs.rmSync(probe.rootDir, { recursive: true, force: true });
      }
    }
  }
});

it("keeps the preload idempotent and cleans isolated state after an ordinary failure", () => {
  for (const preload of [false, true]) {
    const probe = createChildProbe();
    const source = `
      await import(${JSON.stringify(new URL("./test-env.mjs", import.meta.url).href)});
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { test } = await import("node:test");
      fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
      fs.writeFileSync(path.join(process.env.CODEX_HOME, "failure-state"), "isolated");
      test("expected failure", () => { throw new Error("expected failure"); });
    `;
    const args = [
      ...(preload ? ["--import", "./tests/test-env.mjs"] : []),
      "--input-type=module",
      "--eval",
      source,
    ];

    try {
      const result = spawnSync(process.execPath, args, {
        cwd: PROJECT_ROOT,
        env: probe.env,
        encoding: "utf8",
        timeout: 10_000,
      });

      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stdout, /expected failure/);
      assertChildProbeClean(probe);
    } finally {
      fs.rmSync(probe.rootDir, { recursive: true, force: true });
    }
  }
});
