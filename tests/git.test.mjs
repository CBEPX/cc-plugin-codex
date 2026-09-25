/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  REVIEW_MCP_SERVER_NAME,
  SANDBOX_REVIEW_TOOLS,
  SANDBOX_STOP_REVIEW_TOOLS,
} from "../scripts/lib/claude-cli.mjs";
import { collectReviewContext, getWorkingTreeFingerprint } from "../scripts/lib/git.mjs";

const tempRepos = [];
const MCP_DIFF_TOOL = `mcp__${REVIEW_MCP_SERVER_NAME}__diff`;
const MCP_STATUS_TOOL = `mcp__${REVIEW_MCP_SERVER_NAME}__status`;

function extractSection(content, title) {
  const match = content.match(new RegExp(`## ${title}\\n\\n([\\s\\S]*?)(?:\\n## |$)`));
  assert.ok(match, `missing section ${title}`);
  return match[1];
}

// Review runs expose no Bash built-in, so omitted-context guidance must only name
// tools that review and stop-review runs actually receive.
function assertNoShellFallback(content) {
  assert.doesNotMatch(content, /read-only git commands/);
  assert.doesNotMatch(content, /`git (?:diff|ls-files)\b/);
  assert.doesNotMatch(content, /\bls_files\b/);
  assert.doesNotMatch(content, /\bBash\b/);
  for (const tool of [MCP_DIFF_TOOL, MCP_STATUS_TOOL, "Read"]) {
    assert.ok(SANDBOX_REVIEW_TOOLS.includes(tool), `${tool} missing from review tools`);
    assert.ok(SANDBOX_STOP_REVIEW_TOOLS.includes(tool), `${tool} missing from stop-review tools`);
  }
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-git-test-"));
  tempRepos.push(dir);
  runGit(dir, ["init", "--initial-branch=main"]);
  runGit(dir, ["config", "user.name", "Codex Test"]);
  runGit(dir, ["config", "user.email", "codex@example.com"]);
  return dir;
}

afterEach(() => {
  while (tempRepos.length > 0) {
    fs.rmSync(tempRepos.pop(), { recursive: true, force: true });
  }
});

function assertWorkingTreeMcpFallback(content) {
  const staged = extractSection(content, "Staged Diff");
  const unstaged = extractSection(content, "Unstaged Diff");
  assert.match(staged, /^Large diff omitted\./);
  assert.match(unstaged, /^Large diff omitted\./);
  assert.ok(staged.includes(`\`${MCP_DIFF_TOOL}\` with \`{ "cached": true, "stat": true }\``));
  assert.ok(staged.includes('`{ "cached": true, "paths": [...] }`'));
  assert.ok(unstaged.includes(`\`${MCP_DIFF_TOOL}\` with \`{ "stat": true }\``));
  assert.ok(unstaged.includes('`{ "paths": [...] }`'));
  assert.doesNotMatch(unstaged, /cached/);
  assertNoShellFallback(content);
}

describe("collectReviewContext", () => {
  it("avoids embedding full binary patches for working-tree diffs", () => {
    const repo = createRepo();
    const binaryPath = path.join(repo, "asset.bin");

    fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3]));
    runGit(repo, ["add", "asset.bin"]);
    runGit(repo, ["commit", "-m", "initial"]);

    fs.writeFileSync(binaryPath, Buffer.from([4, 5, 6, 7, 8, 9]));

    const context = collectReviewContext(repo, {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    });

    assert.ok(context.content.includes("asset.bin"));
    assert.ok(!context.content.includes("GIT binary patch"));
  });

  it("avoids embedding full binary patches for branch diffs", () => {
    const repo = createRepo();
    const binaryPath = path.join(repo, "asset.bin");

    fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3]));
    runGit(repo, ["add", "asset.bin"]);
    runGit(repo, ["commit", "-m", "initial"]);
    runGit(repo, ["checkout", "-b", "feature"]);

    fs.writeFileSync(binaryPath, Buffer.from([7, 8, 9, 10, 11]));
    runGit(repo, ["add", "asset.bin"]);
    runGit(repo, ["commit", "-m", "update binary"]);

    const context = collectReviewContext(repo, {
      mode: "branch",
      label: "branch diff against main",
      baseRef: "main",
      explicit: true,
    });

    assert.ok(context.content.includes("asset.bin"));
    assert.ok(!context.content.includes("GIT binary patch"));
  });

  it("gracefully handles untracked directory contents and symlinks in working-tree review context", () => {
    const repo = createRepo();

    fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n", "utf8");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "-m", "tracked"]);

    fs.mkdirSync(path.join(repo, "notes"), { recursive: true });
    fs.writeFileSync(path.join(repo, "notes", "todo.md"), "todo\n", "utf8");
    fs.symlinkSync("tracked.txt", path.join(repo, "tracked-link"));

    const context = collectReviewContext(repo, {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    });

    assert.match(context.content, /notes\/todo\.md[\s\S]*```/);
    assert.match(context.content, /tracked-link[\s\S]*skipped: symlink/);
  });

  it("bounds aggregate untracked file context for large dirty trees", () => {
    const repo = createRepo();
    const body = "x".repeat(6 * 1024);

    fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n", "utf8");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "-m", "tracked"]);

    for (let index = 0; index < 220; index += 1) {
      fs.writeFileSync(
        path.join(repo, `untracked-${String(index).padStart(3, "0")}.txt`),
        body,
        "utf8"
      );
    }

    const context = collectReviewContext(repo, {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    });

    assert.ok(Buffer.byteLength(context.content, "utf8") < 128 * 1024);
    assert.match(context.content, /Omitted untracked files/);
    const omitted = context.content.slice(context.content.indexOf("### Omitted untracked files"));
    assert.ok(omitted.includes(`\`${MCP_STATUS_TOOL}\` with \`{ "porcelain": true }\``));
    assert.match(omitted, /`\?\?` paths/);
    assert.match(omitted, /`Read`/);
    assertNoShellFallback(context.content);
  });

  it("continues inlining small untracked files after skipping a large untracked file", () => {
    const repo = createRepo();

    fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n", "utf8");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "-m", "tracked"]);

    fs.writeFileSync(path.join(repo, "aaa-large.txt"), "x".repeat(30 * 1024), "utf8");
    fs.writeFileSync(
      path.join(repo, "zzz-small.js"),
      "export const reviewed = true;\n",
      "utf8"
    );

    const context = collectReviewContext(repo, {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    });

    assert.match(context.content, /### zzz-small\.js[\s\S]*export const reviewed = true;/);
    assert.match(context.content, /aaa-large\.txt/);
    assert.match(context.content, /skipped: 30720 bytes exceeds 24576 byte limit/);
  });

  it("inlines a single medium-sized untracked file up to the per-file cap", () => {
    const repo = createRepo();

    fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n", "utf8");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "-m", "tracked"]);

    fs.writeFileSync(
      path.join(repo, "new-module.js"),
      `export const body = "${"x".repeat(18 * 1024)}";\n`,
      "utf8"
    );

    const context = collectReviewContext(repo, {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    });

    assert.match(context.content, /### new-module\.js/);
    assert.match(context.content, /export const body =/);
    assert.doesNotMatch(context.content, /Omitted untracked files/);
  });

  it("inlines a single untracked file exactly at the per-file cap despite markdown overhead", () => {
    const repo = createRepo();

    fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n", "utf8");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "-m", "tracked"]);

    fs.writeFileSync(
      path.join(repo, "boundary.js"),
      "x".repeat(24 * 1024),
      "utf8"
    );

    const context = collectReviewContext(repo, {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    });

    assert.match(context.content, /### boundary\.js/);
    assert.doesNotMatch(context.content, /Omitted untracked files/);
  });

  it("omits very large working-tree diffs and tells the reviewer to inspect git directly", () => {
    const repo = createRepo();
    const largeText = `${"x".repeat(200)}\n`.repeat(500);

    fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n", "utf8");
    runGit(repo, ["add", "app.js"]);
    runGit(repo, ["commit", "-m", "initial"]);

    fs.writeFileSync(path.join(repo, "app.js"), largeText, "utf8");

    const context = collectReviewContext(repo, {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    });

    assertWorkingTreeMcpFallback(context.content);
  });

  it("omits very large branch diffs and tells the reviewer to inspect git directly", () => {
    const repo = createRepo();
    const largeText = `${"y".repeat(200)}\n`.repeat(500);

    fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n", "utf8");
    runGit(repo, ["add", "app.js"]);
    runGit(repo, ["commit", "-m", "initial"]);
    runGit(repo, ["checkout", "-b", "feature"]);

    fs.writeFileSync(path.join(repo, "app.js"), largeText, "utf8");
    runGit(repo, ["add", "app.js"]);
    runGit(repo, ["commit", "-m", "large change"]);

    const context = collectReviewContext(repo, {
      mode: "branch",
      label: "branch diff against main",
      baseRef: "main",
      explicit: true,
    });

    const mergeBase = runGit(repo, ["merge-base", "HEAD", "main"]);
    const branchDiff = extractSection(context.content, "Branch Diff");
    assert.match(branchDiff, /^Large diff omitted\./);
    assert.ok(branchDiff.includes(`\`${MCP_DIFF_TOOL}\` with \`{ "refs": "${mergeBase}..HEAD", "stat": true }\``));
    assert.ok(branchDiff.includes(`\`{ "refs": "${mergeBase}..HEAD", "paths": [...] }\``));
    assertNoShellFallback(context.content);
    assert.doesNotMatch(context.content, /@@/);
  });

  it("points staged-only large changes at the cached MCP diff when the worktree differs from the index", () => {
    const repo = createRepo();
    const stagedText = `${"s".repeat(200)}\n`.repeat(500);

    fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n", "utf8");
    runGit(repo, ["add", "app.js"]);
    runGit(repo, ["commit", "-m", "initial"]);

    fs.writeFileSync(path.join(repo, "app.js"), stagedText, "utf8");
    runGit(repo, ["add", "app.js"]);
    fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n", "utf8");

    const context = collectReviewContext(repo, {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    });

    assert.match(context.summary, /1 staged, 1 unstaged/);
    assertWorkingTreeMcpFallback(context.content);
    assert.match(
      extractSection(context.content, "Staged Diff"),
      /`Read` shows the working tree, not the index/
    );
    assert.doesNotMatch(context.content, /s{200}/);
  });

  it("degrades gracefully when working-tree diff output exceeds the process buffer", () => {
    const repo = createRepo();
    const hugeText = `${"z".repeat(2048)}\n`.repeat(700);

    fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n", "utf8");
    runGit(repo, ["add", "app.js"]);
    runGit(repo, ["commit", "-m", "initial"]);

    fs.writeFileSync(path.join(repo, "app.js"), hugeText, "utf8");

    const context = collectReviewContext(repo, {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    });

    assertWorkingTreeMcpFallback(context.content);
  });

  it("computes a working-tree fingerprint without buffering the full diff text", () => {
    const repo = createRepo();
    const hugeText = `${"w".repeat(2048)}\n`.repeat(700);

    fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n", "utf8");
    runGit(repo, ["add", "app.js"]);
    runGit(repo, ["commit", "-m", "initial"]);

    fs.writeFileSync(path.join(repo, "app.js"), hugeText, "utf8");

    const fingerprint = getWorkingTreeFingerprint(repo);

    assert.equal(typeof fingerprint.signature, "string");
    assert.equal(fingerprint.signature.length > 0, true);
    assert.equal(typeof fingerprint.stagedDiffHash, "string");
    assert.equal(typeof fingerprint.unstagedDiffHash, "string");
  });

  it("fingerprints an index whose staged path list exceeds the default process buffer", () => {
    const repo = createRepo();
    for (let index = 0; index < 6_000; index += 1) {
      fs.writeFileSync(
        path.join(repo, `${String(index).padStart(5, "0")}-${"x".repeat(160)}.txt`),
        "",
        "utf8"
      );
    }
    runGit(repo, ["add", "."]);
    const staged = spawnSync("git", ["ls-files", "--stage", "-z"], {
      cwd: repo,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(staged.status, 0, staged.stderr?.toString());
    assert.ok(staged.stdout.length > 1024 * 1024);

    const fingerprint = getWorkingTreeFingerprint(repo);
    assert.equal(fingerprint.stagedDiffHash, runGit(repo, ["write-tree"]));
  });

  it("marks a working-tree FIFO without opening or blocking on it", async (context) => {
    if (process.platform === "win32") {
      context.skip("FIFOs are not available on Windows");
      return;
    }
    const repo = createRepo();
    const fifo = path.join(repo, "peer-events.fifo");
    fs.writeFileSync(fifo, "regular before replacement\n", "utf8");
    runGit(repo, ["add", "peer-events.fifo"]);
    runGit(repo, ["commit", "-m", "track fifo path"]);
    fs.unlinkSync(fifo);
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const probe = `
      import { getWorkingTreeFingerprint } from ${JSON.stringify(
        new URL("../scripts/lib/git.mjs", import.meta.url).href
      )};
      const result = getWorkingTreeFingerprint(process.argv[1]);
      process.stdout.write(JSON.stringify(result));
    `;
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", probe, repo], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => {
        process.kill(-child.pid, "SIGKILL");
      }, 1_000);
      child.once("close", (status, signal) => {
        clearTimeout(timer);
        resolve({ status, signal, stdout, stderr });
      });
    });
    assert.equal(result.status, 0, result.stderr || `terminated by ${result.signal}`);
    const before = JSON.parse(result.stdout);
    assert.equal(before.untrackedCount, 0);
    fs.chmodSync(fifo, 0o600);
    const after = getWorkingTreeFingerprint(repo);
    assert.notEqual(after.unstagedDiffHash, before.unstagedDiffHash);
  });

  it("fingerprints HEAD and untracked file contents rather than metadata alone", () => {
    const repo = createRepo();
    const untrackedPath = path.join(repo, "notes.txt");

    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n", "utf8");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "-m", "initial"]);
    fs.writeFileSync(untrackedPath, "alpha\n", "utf8");

    const before = getWorkingTreeFingerprint(repo);
    const originalTimes = fs.statSync(untrackedPath);
    fs.writeFileSync(untrackedPath, "bravo\n", "utf8");
    fs.utimesSync(untrackedPath, originalTimes.atime, originalTimes.mtime);
    const after = getWorkingTreeFingerprint(repo);

    assert.equal(before.head, runGit(repo, ["rev-parse", "HEAD"]));
    assert.notEqual(after.untrackedFingerprintHash, before.untrackedFingerprintHash);
    assert.notEqual(after.signature, before.signature);
  });

  it("changes the staged fingerprint when staged file content changes", () => {
    const repo = createRepo();
    const trackedPath = path.join(repo, "tracked.txt");

    fs.writeFileSync(trackedPath, "base\n", "utf8");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "-m", "initial"]);
    fs.writeFileSync(trackedPath, "staged one\n", "utf8");
    runGit(repo, ["add", "tracked.txt"]);
    const before = getWorkingTreeFingerprint(repo);

    fs.writeFileSync(trackedPath, "staged two\n", "utf8");
    runGit(repo, ["add", "tracked.txt"]);
    const after = getWorkingTreeFingerprint(repo);

    assert.equal(after.head, before.head);
    assert.notEqual(after.stagedDiffHash, before.stagedDiffHash);
    assert.notEqual(after.signature, before.signature);
  });

  it("fingerprints untracked contents when a Git path contains a newline", () => {
    const repo = createRepo();
    const unusualPath = path.join(repo, "line\nbreak.txt");

    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n", "utf8");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "-m", "initial"]);
    fs.writeFileSync(unusualPath, "first\n", "utf8");
    const before = getWorkingTreeFingerprint(repo);

    fs.writeFileSync(unusualPath, "second\n", "utf8");
    const after = getWorkingTreeFingerprint(repo);

    assert.equal(before.untrackedCount, 1);
    assert.notEqual(after.untrackedFingerprintHash, before.untrackedFingerprintHash);
  });

  it("keeps HEAD as metadata without invalidating an identical index and worktree", () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n", "utf8");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "-m", "initial"]);
    const before = getWorkingTreeFingerprint(repo);

    runGit(repo, ["commit", "--allow-empty", "-m", "metadata only"]);
    const after = getWorkingTreeFingerprint(repo);

    assert.notEqual(after.head, before.head);
    assert.equal(after.stagedDiffHash, before.stagedDiffHash);
    assert.equal(after.unstagedDiffHash, before.unstagedDiffHash);
    assert.equal(after.untrackedFingerprintHash, before.untrackedFingerprintHash);
    assert.equal(after.signature, before.signature);
  });

  it("uses a stable unborn HEAD sentinel before the first commit", () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "draft.txt"), "draft\n", "utf8");

    const first = getWorkingTreeFingerprint(repo);
    const second = getWorkingTreeFingerprint(repo);

    assert.equal(first.head, "unborn");
    assert.equal(second.head, "unborn");
    assert.equal(second.signature, first.signature);
  });

  it("content-hashes a large untracked file independently of metadata", () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n", "utf8");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "-m", "initial"]);
    const large = path.join(repo, "large.bin");
    fs.writeFileSync(large, Buffer.alloc(5 * 1024 * 1024, 0x61));
    const before = getWorkingTreeFingerprint(repo);
    const times = fs.statSync(large);
    fs.writeFileSync(large, Buffer.alloc(5 * 1024 * 1024, 0x62));
    fs.utimesSync(large, times.atime, times.mtime);

    const after = getWorkingTreeFingerprint(repo);
    assert.notEqual(after.untrackedFingerprintHash, before.untrackedFingerprintHash);
    assert.notEqual(after.signature, before.signature);
  });
});
