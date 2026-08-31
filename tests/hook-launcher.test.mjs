/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const LAUNCHER = path.join(PROJECT_ROOT, "scripts", "hook-launcher.mjs");
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("hook-launcher.mjs", () => {
  it("recovers from a deleted plugin root and preserves hook arguments", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-hook-launcher-"));
    tempDirs.push(tempDir);
    const cacheRoot = path.join(tempDir, "plugins", "cache", "cbepx", "cc");
    const staleRoot = path.join(cacheRoot, "1.5.4");
    const currentRoot = path.join(cacheRoot, "1.6.1");
    const hooksDir = path.join(currentRoot, "hooks");
    const resultFile = path.join(tempDir, "hook-result.json");
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(currentRoot, "package.json"),
      JSON.stringify({ name: "cc-plugin-codex", version: "1.6.1" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(hooksDir, "session-lifecycle-hook.mjs"),
      `import fs from "node:fs";\nfs.writeFileSync(process.env.RESULT_FILE, JSON.stringify({ pluginRoot: process.env.PLUGIN_ROOT, args: process.argv.slice(2) }));\n`,
      "utf8"
    );

    const result = spawnSync(
      process.execPath,
      [LAUNCHER, "session-lifecycle", "SessionEnd"],
      {
        env: { ...process.env, PLUGIN_ROOT: staleRoot, RESULT_FILE: resultFile },
        encoding: "utf8",
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, "utf8")), {
      pluginRoot: currentRoot,
      args: ["SessionEnd"],
    });
  });

  it("rejects unknown hook names", () => {
    const result = spawnSync(process.execPath, [LAUNCHER, "../../arbitrary"], {
      env: { ...process.env, PLUGIN_ROOT: PROJECT_ROOT },
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown cc hook/u);
  });

  it("does not search the hook working directory when PLUGIN_ROOT is missing", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-hook-launcher-cwd-"));
    tempDirs.push(tempDir);
    const attackerRoot = path.join(tempDir, "attacker");
    const hooksDir = path.join(attackerRoot, "hooks");
    const resultFile = path.join(tempDir, "executed");
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(attackerRoot, "package.json"),
      JSON.stringify({ name: "cc-plugin-codex" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(hooksDir, "session-lifecycle-hook.mjs"),
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(resultFile)}, "bad");\n`,
      "utf8"
    );

    const result = spawnSync(process.execPath, [LAUNCHER, "session-lifecycle"], {
      cwd: tempDir,
      env: { ...process.env, PLUGIN_ROOT: "" },
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(resultFile), false);
  });
});
