/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MODEL_ALIASES } from "../scripts/lib/claude-cli.mjs";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const SKILL_NAMES = [
  "adversarial-review",
  "cancel",
  "mcp-diagnose",
  "rescue",
  "result",
  "review",
  "setup",
  "status",
  "transfer",
];

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), "utf8");
}

function frontmatter(text, label) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, `${label}: missing frontmatter`);
  return match[1];
}

function assertIncludesAll(text, expected, label) {
  for (const value of expected) {
    assert.ok(text.includes(value), `${label}: missing ${value}`);
  }
}

test("public skills expose stable frontmatter and keep workspace roots separate", () => {
  for (const name of SKILL_NAMES) {
    const label = `skills/${name}/SKILL.md`;
    const skill = read(label);
    const metadata = frontmatter(skill, label);

    assert.match(metadata, new RegExp(`^name: ${name}$`, "m"), label);
    assert.match(metadata, /^description:\s+.+$/m, label);
    assertIncludesAll(
      skill,
      [
        "Resolve `<plugin-root>` as two directories above this `SKILL.md` file",
        '<plugin-root>/scripts/claude-companion.mjs',
        "Keep the shell tool in the active Codex user workspace",
        "never set its working directory to `<plugin-root>`",
      ],
      label
    );
    assert.doesNotMatch(skill, /--cwd "<plugin-root>"|--cwd "\$PWD"|<workspace-root>/i, label);
  }
});

test("README model documentation follows runtime aliases", () => {
  const readme = read("README.md");

  for (const alias of MODEL_ALIASES.keys()) {
    assert.ok(readme.includes(`\`${alias}\``), alias);
  }
  assertIncludesAll(
    readme,
    [
      "--model <model>",
      "a full ID pins a version",
      "requestedModel",
      "finalModel",
      "contextWindow",
    ],
    "README.md"
  );
});

test("simple skills keep their executable companion commands", () => {
  const commands = {
    cancel: "cancel $ARGUMENTS",
    "mcp-diagnose": "mcp-diagnose $ARGUMENTS",
    result: "result $ARGUMENTS",
    status: "status $ARGUMENTS",
    transfer: "transfer $ARGUMENTS",
  };

  for (const [name, command] of Object.entries(commands)) {
    const skill = read(`skills/${name}/SKILL.md`);
    assert.ok(
      skill.includes(`node "<plugin-root>/scripts/claude-companion.mjs" ${command}`),
      name
    );
  }

  const transfer = read("skills/transfer/SKILL.md");
  assertIncludesAll(transfer, ["--source <claude-jsonl>", "codex resume <session-id>"], "transfer");
  assert.match(
    read("skills/mcp-diagnose/SKILL.md"),
    /Do not print raw MCP server configs or secrets/i
  );
});

test("review skills preserve foreground/background routing contracts", () => {
  const variants = [
    {
      name: "review",
      notification:
        "Background Claude Code review finished. Open it with $cc:result <reserved-job-id>.",
    },
    {
      name: "adversarial-review",
      notification:
        "Background Claude Code adversarial review finished. Open it with $cc:result <reserved-job-id>.",
    },
  ];

  for (const { name, notification } of variants) {
    const skill = read(`skills/${name}/SKILL.md`);
    assertIncludesAll(
      skill,
      [
        `claude-companion.mjs" ${name} ...`,
        `${name} --view-state on-success`,
        "background-routing-context --kind review --json",
        `${name} --cwd "<workspaceRoot>" --view-state defer`,
        "--owner-session-id <owner-session-id>",
        "--job-id <reserved-job-id>",
        "spawn_agent",
        "`fork_context: false`",
        '`reasoning_effort: "medium"`',
        "Omit `model` so the forwarding child inherits the current Codex runtime model.",
        "If the shell tool returns a session id, keep polling that same session until the companion command exits.",
        "Exit code 0 is the only successful completion.",
        "Exit code 124 means the job is still running; return the companion output without claiming it finished.",
        "For any other non-zero exit code or shell-tool error, return the raw companion output or diagnostic without a success notification.",
        "never leave an empty routing placeholder such as `--owner-session-id  --job-id`",
        "send_input({ target: <parent-thread-id>, message: <steering-message> })",
        notification,
      ],
      name
    );
    assert.doesNotMatch(
      skill,
      new RegExp(`claude-companion\\.mjs" ${name} --background`, "i"),
      name
    );
    assert.doesNotMatch(skill, /gpt-5\.\d+/i, name);
  }
});

test("review and rescue skills retain negative routing guards", () => {
  for (const name of ["review", "adversarial-review"]) {
    assertIncludesAll(
      read(`skills/${name}/SKILL.md`),
      [
        "Do not spawn a review subagent",
        "do not invoke a generic review-runner role",
        "Do not fall back to raw `claude`",
        "generic `claude_review_runner`-style helper role",
        "shell backgrounding such as `&`, `nohup`, detached `spawn`",
        "Only consider `fork_context: true` as a last resort",
        "Do not retry with an explicit model override if spawning fails",
      ],
      name
    );
  }

  assertIncludesAll(
    read("skills/review/SKILL.md"),
    [
      "Use `$cc:review` as the default",
      "route to `$cc:adversarial-review` instead",
      "route to `$cc:rescue` instead",
    ],
    "review routing"
  );
  assertIncludesAll(
    read("skills/adversarial-review/SKILL.md"),
    [
      "Do not treat `$cc:adversarial-review` as the default",
      "route to `$cc:rescue` instead",
      "keep the delegated Claude portion on `$cc:review`",
    ],
    "adversarial routing"
  );
  assertIncludesAll(
    read("skills/rescue/SKILL.md"),
    [
      "This size-and-scope heuristic belongs to the main Codex thread",
      "If the user task text itself begins with a slash command",
      "Never satisfy background rescue by launching",
      "Prefer `fork_context: false`",
      "Only consider `fork_context: true` as a last resort",
      "Do not retry with an explicit model override if spawning fails",
    ],
    "rescue routing"
  );
});

test("rescue keeps host execution controls out of the companion task", () => {
  const rescue = read("skills/rescue/SKILL.md");
  const metadata = frontmatter(rescue, "rescue");
  const agentMetadata = read("skills/rescue/agents/openai.yaml");

  assertIncludesAll(
    rescue,
    [
      "session-routing-context --json",
      "task-resume-candidate --owner-session-id <owner-session-id> --json",
      "background-routing-context --kind task --json",
      '--cwd "<workspaceRoot>"',
      "--view-state on-success",
      "--view-state defer",
      "--owner-session-id <owner-session-id>",
      "--job-id <reserved-job-id>",
      "--prompt-file",
      "send_input({ target: <parent-thread-id>, message: <steering-message> })",
      "Background Claude Code rescue finished. Open it with $cc:result <reserved-job-id>.",
      "If the shell tool returns a session id, keep polling that same session until the companion command exits.",
      "Exit code 0 is the only successful completion.",
      "Exit code 124 means the job is still running; return the companion output without claiming it finished.",
      "For any other non-zero exit code or shell-tool error, return the raw companion output or diagnostic without a success notification.",
      "../../internal-skills/cli-runtime/runtime.md",
      "../../internal-skills/task-prompt-shaping/prompt-shaping.md",
    ],
    "rescue"
  );
  assert.ok(
    rescue.indexOf("session-routing-context --json") <
      rescue.indexOf("task-resume-candidate --owner-session-id <owner-session-id> --json"),
    "rescue must resolve owner routing before probing for a resume candidate"
  );
  assert.match(rescue, /Never forward either flag to `claude-companion\.mjs task`/i);
  assert.doesNotMatch(rescue, /claude-companion\.mjs" task --(?:background|wait)/i);
  assert.doesNotMatch(rescue, /gpt-5\.\d+/i);

  for (const legacyFlag of ["--builtin-agent", "--notify-parent-on-complete"]) {
    assert.ok(!metadata.includes(legacyFlag), legacyFlag);
    assert.ok(!agentMetadata.includes(legacyFlag), legacyFlag);
  }
});

test("internal runtime references preserve executable routing invariants", () => {
  const reviewRuntime = read("internal-skills/review-runtime/runtime.md");
  const rescueRuntime = read("internal-skills/cli-runtime/runtime.md");

  assertIncludesAll(
    reviewRuntime,
    [
      'node "<plugin-root>/scripts/claude-companion.mjs" review ...',
      'node "<plugin-root>/scripts/claude-companion.mjs" adversarial-review ...',
      "review --view-state on-success",
      "adversarial-review --view-state on-success",
      "background-routing-context --kind review --json",
      "Never derive the workspace from the plugin root",
      "Never emit an empty routing placeholder such as `--owner-session-id  --job-id`",
      'review --cwd "<workspaceRoot>" --view-state defer',
      'adversarial-review --cwd "<workspaceRoot>" --view-state defer',
      "If the shell tool returns a session id, keep polling that same session until the companion command exits.",
      "Exit code 0 is the only successful completion.",
      "Exit code 124 means the job is still running; return the companion output without claiming it finished.",
      "For any other non-zero exit code or shell-tool error, return the raw companion output or diagnostic without a success notification.",
      "Omit `model` so the child inherits the current Codex runtime model.",
      "Do not add a fixed-version model fallback.",
      "send_input({ target: <parent-thread-id>, message: <steering-message> })",
      "Background Claude Code review finished. Open it with $cc:result <reserved-job-id>.",
      "Background Claude Code adversarial review finished. Open it with $cc:result <reserved-job-id>.",
    ],
    "review runtime"
  );
  assert.doesNotMatch(reviewRuntime, /gpt-5\.\d+/i);

  assertIncludesAll(
    rescueRuntime,
    [
      'node "<plugin-root>/scripts/claude-companion.mjs" task --cwd "<workspaceRoot>"',
      "Never derive the workspace from the plugin root",
      "Never emit an empty routing placeholder such as `--owner-session-id  --job-id`",
      "If the shell tool returns a session id, keep polling that same session until the companion command exits.",
      "Exit code 0 is the only successful completion.",
      "Exit code 124 means the job is still running; return the companion output without claiming it finished.",
      "For any other non-zero exit code or shell-tool error, return the raw companion output or diagnostic without a success notification.",
      "Never call `task --background` or invent `task --wait`.",
      "--owner-session-id <session-id>",
      "--job-id",
      "--prompt-file",
      "Never call `task-resume-candidate` from the rescue forwarder.",
      "send_input({ target: <parent-thread-id>, message: <steering-message> })",
    ],
    "rescue runtime"
  );
});

test("setup keeps native hook repair in the companion flow", () => {
  const setup = read("skills/setup/SKILL.md");

  assertIncludesAll(
    setup,
    [
      'claude-companion.mjs" setup --check --json',
      "`--check` is read-only",
      "[features].hooks",
      "[features].plugin_hooks",
      "native hook trust hashes",
    ],
    "setup"
  );
  assert.doesNotMatch(setup, /install-hooks\.mjs/i);
});
