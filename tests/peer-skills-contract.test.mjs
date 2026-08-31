/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), "utf8");
}

function includesAll(source, values, label) {
  for (const value of values) {
    assert.ok(source.includes(value), `${label}: missing ${value}`);
  }
}

test("design and research skills expose the peer workflow syntax and mode-specific result contract", () => {
  for (const [mode, emphasis] of [
    ["design", ["alternatives", "trade-offs", "decision drivers", "recommendation"]],
    ["research", ["findings", "source quality", "contradictions", "confidence", "gaps"]],
  ]) {
    const skill = read(`skills/${mode}/SKILL.md`);
    assert.match(skill, new RegExp(`^name: ${mode}$`, "m"));
    assert.match(skill, /^description: Use when /m);
    includesAll(skill, [
      "Resolve `<plugin-root>` as two directories above this `SKILL.md` file",
      "Keep the shell tool in the active Codex user workspace",
      "$ARGUMENTS",
      "--model",
      "--fallback-model",
      "--effort",
      "--codex-model",
      "--codex-effort",
      "--user-mcp-tool",
      "--allow-project-mcp-servers",
      "--no-auto-tools",
      "--continue <workflow-id>",
      "--retry <workflow-id>",
      "../../internal-skills/peer-runtime/runtime.md",
    ], mode);
    includesAll(skill.toLowerCase(), emphasis, `${mode} emphasis`);
  }
});

test("peer runtime keeps preflight live, initial children independent, and Claude forwarding pure", () => {
  const runtime = read("internal-skills/peer-runtime/runtime.md");

  includesAll(runtime, [
    "tools and skills actually exposed to this Codex turn",
    "Do not infer availability from installed files",
    "before `peer-create`",
    "at most three",
    "explicit installation confirmation",
    "rerun preflight after installation or restart",
    "spawn exactly two",
    '`fork_turns: "none"`',
    '`reasoning_effort: "xhigh"`',
    "Omit `model` when `--codex-model` was not supplied",
    "identical normalized brief bytes and SHA-256 hash",
    "cannot read the sibling memo before submitting its own",
    "pure Claude forwarder",
    "run exactly one companion command",
    "return stdout unchanged",
    "Never use shell backgrounding",
    "Never invoke `codex exec`",
    "Initial execution is always background",
    "Continue is foreground",
  ], "peer runtime");

  assert.doesNotMatch(runtime, /fork_context/);
});

test("peer runtime preserves stdin, evidence, strict tool, continuation, and retry boundaries", () => {
  const runtime = read("internal-skills/peer-runtime/runtime.md");

  includesAll(runtime, [
    "peer-submit-memo",
    "accepts only the Codex memo",
    "peer-wait",
    "redacts the sibling payload until the Codex memo is sealed",
    "JSON on stdin",
    "peer-claude-turn",
    "Read, Glob, Grep",
    "WebSearch, WebFetch",
    "no Bash",
    "no Agent",
    "permission-mode=dontAsk",
    "strict MCP config",
    "canonical in-workspace repository citation",
    "direct `https://` citation",
    "actual repository and web tool events",
    "non-empty structured critique content",
    "unchanged workspace fingerprint",
    "peer-checkpoint",
    "separate frozen memos",
    "agreements",
    "disagreements",
    "decisions needed",
    "--resume",
    "--fork-session",
    "retry only the missing stage",
    "A failed or unresolved linked cancellation leaves the target `cancel_failed` with no retry work",
    "peer-final",
  ], "peer runtime");
});
