/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

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
