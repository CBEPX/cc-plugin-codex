/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const COMPANION = path.join(PROJECT_ROOT, "scripts", "claude-companion.mjs");

function runCompanion(args, env = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, ...env },
  });
}

describe("claude-companion --guest", () => {
  it("documents --guest on review, adversarial-review, task, and setup", () => {
    const result = runCompanion(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--guest <claude\|grok>/);
    assert.match(result.stdout, /setup \[.*--guest/);
    assert.match(result.stdout, /review \[.*--guest/);
    assert.match(result.stdout, /adversarial-review \[.*--guest/);
    assert.match(result.stdout, /task \[.*--guest/);
  });

  it("rejects an unknown --guest before touching git or Claude", () => {
    const result = runCompanion(["review", "--guest", "chatgpt", "--json"]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /Unsupported guest "chatgpt"/);
    assert.doesNotMatch(`${result.stderr}${result.stdout}`, /not a git repository/i);
  });

  it("does not treat grok as the default guest", () => {
    const skill = fs.readFileSync(
      path.join(PROJECT_ROOT, "skills", "review", "SKILL.md"),
      "utf8"
    );
    assert.match(skill, /--guest <claude\|grok>/);
    assert.match(skill, /Defaults to.*claude/i);
  });
});
