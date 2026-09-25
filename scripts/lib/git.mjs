/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = MAX_UNTRACKED_BYTES + 4 * 1024;
const MAX_INLINE_REVIEW_DIFF_BYTES = 64 * 1024;
const REVIEW_DIFF_READ_MAX_BUFFER = MAX_INLINE_REVIEW_DIFF_BYTES + 8 * 1024;
const HASH_OBJECT_BATCH_SIZE = 128;
const FINGERPRINT_GIT_TIMEOUT_MS = 30_000;
const FINGERPRINT_SMALL_MAX_BUFFER = 64 * 1024;
const FINGERPRINT_PATH_LIST_MAX_BUFFER = 64 * 1024 * 1024;
const FINGERPRINT_WRITE_TREE_RETRIES = 8;
// Review runs have no Bash; omitted-context guidance names the bundled git MCP
// tools instead. Keep in sync with REVIEW_MCP_SERVER_NAME in claude-cli.mjs.
const REVIEW_MCP_TOOL_PREFIX = "mcp__gitReview__";

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

export function ensureGitRepository(cwd, options = {}) {
  try {
    return gitChecked(
      cwd,
      ["rev-parse", "--show-toplevel"],
      options
    ).stdout.trim();
  } catch (error) {
    if (error?.code === "ETIMEDOUT") throw error;
    if (error?.code === "ENOENT") {
      throw new Error("git is not installed. Install Git and retry.");
    }
    throw new Error("This command must run inside a Git repository.");
  }
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

function hashText(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

export function getWorkingTreeFingerprint(cwd, options = {}) {
  const fingerprintGitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const smallGitOptions = {
    timeout: options.timeout ?? FINGERPRINT_GIT_TIMEOUT_MS,
    maxBuffer: FINGERPRINT_SMALL_MAX_BUFFER,
    env: fingerprintGitEnv,
  };
  const pathListGitOptions = {
    timeout: options.timeout ?? FINGERPRINT_GIT_TIMEOUT_MS,
    maxBuffer: FINGERPRINT_PATH_LIST_MAX_BUFFER,
    env: fingerprintGitEnv,
  };
  const repoRoot = gitChecked(cwd, ["rev-parse", "--show-toplevel"], smallGitOptions)
    .stdout.trim();
  const headResult = git(repoRoot, ["rev-parse", "--verify", "HEAD"], smallGitOptions);
  const head = headResult.status === 0 ? headResult.stdout.trim() : "unborn";
  const stagedDiffHash = readIndexTree(repoRoot, smallGitOptions);
  const unstaged = gitChecked(repoRoot, [
    "diff",
    "--name-only",
    "--no-ext-diff",
    "-z",
  ], pathListGitOptions).stdout
    .split("\0")
    .filter(Boolean)
    .sort();
  const untracked = gitChecked(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ], pathListGitOptions).stdout
    .split("\0")
    .filter(Boolean)
    .sort();

  const unstagedDiffHash = hashWorkingTreePaths(repoRoot, unstaged, smallGitOptions);
  const untrackedFingerprintHash = hashWorkingTreePaths(repoRoot, untracked, smallGitOptions);
  const signature = hashText(
    [
      stagedDiffHash,
      unstagedDiffHash,
      untrackedFingerprintHash,
      String(untracked.length),
    ].join("\0")
  );

  return {
    repoRoot,
    head,
    stagedDiffHash,
    unstagedDiffHash,
    untrackedFingerprintHash,
    untrackedCount: untracked.length,
    signature,
  };
}

function readIndexTree(repoRoot, gitOptions) {
  for (let attempt = 0; attempt < FINGERPRINT_WRITE_TREE_RETRIES; attempt += 1) {
    const result = git(repoRoot, ["write-tree"], gitOptions);
    if (result.status === 0) return result.stdout.trim();
    const indexBusy = /index\.lock[\s\S]*File exists/iu.test(result.stderr);
    if (!indexBusy || attempt === FINGERPRINT_WRITE_TREE_RETRIES - 1) {
      if (result.error) throw result.error;
      throw new Error(formatCommandFailure(result));
    }
    const delay = 25 * (attempt + 1);
    const shared = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(shared), 0, 0, delay);
  }
  throw new Error("git write-tree retry budget exhausted.");
}

function hashWorkingTreePaths(repoRoot, relativePaths, gitOptions) {
  const hash = createHash("sha256");
  const regularPaths = [];

  for (const relativePath of relativePaths) {
    hash.update(relativePath, "utf8");
    hash.update("\0", "utf8");

    const absolutePath = path.join(repoRoot, relativePath);
    try {
      const stat = fs.lstatSync(absolutePath);
      if (stat.isDirectory()) {
        hash.update("directory", "utf8");
        hash.update("\0", "utf8");
        hash.update(String(Math.trunc(stat.mtimeMs)), "utf8");
        hash.update("\0", "utf8");
        continue;
      }

      if (stat.isSymbolicLink()) {
        hash.update("symlink", "utf8");
        hash.update("\0", "utf8");
        hash.update(fs.readlinkSync(absolutePath), "utf8");
        hash.update("\0", "utf8");
        continue;
      }

      if (stat.isFile()) {
        regularPaths.push(relativePath);
        continue;
      }

      const type = stat.isFIFO()
        ? "fifo"
        : stat.isSocket()
          ? "socket"
          : stat.isCharacterDevice()
            ? "character-device"
            : stat.isBlockDevice()
              ? "block-device"
              : "other";
      const mode = (stat.mode & 0o7777).toString(8).padStart(4, "0");
      hash.update(`special:${type}:${mode}`, "utf8");
      hash.update("\0", "utf8");
      continue;
    } catch (error) {
      if (error?.code === "ENOENT") {
        hash.update("deleted", "utf8");
      } else {
        throw error;
      }
    }
    hash.update("\0", "utf8");
  }

  const blobHashes = readBlobHashes(repoRoot, regularPaths, gitOptions);
  for (const relativePath of regularPaths) {
    hash.update(blobHashes.get(relativePath), "utf8");
    hash.update("\0", "utf8");
  }

  return hash.digest("hex");
}

function readBlobHashes(repoRoot, relativePaths, gitOptions) {
  const hashes = new Map();
  for (let index = 0; index < relativePaths.length; index += HASH_OBJECT_BATCH_SIZE) {
    const batch = relativePaths.slice(index, index + HASH_OBJECT_BATCH_SIZE);
    const stdout = gitChecked(
      repoRoot,
      ["hash-object", "--no-filters", "--", ...batch],
      gitOptions
    ).stdout;
    const digestLines = stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (digestLines.length !== batch.length) {
      throw new Error(
        `git hash-object returned ${digestLines.length} hashes for ${batch.length} path(s).`
      );
    }
    batch.forEach((relativePath, batchIndex) => {
      hashes.set(relativePath, digestLines[batchIndex]);
    });
  }
  return hashes;
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isDirectory()) {
      return `### ${relativePath}\n(skipped: untracked directory)`;
    }
    if (stat.isSymbolicLink()) {
      return `### ${relativePath}\n(skipped: symlink)`;
    }
    if (stat.size > MAX_UNTRACKED_BYTES) {
      return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
    }

    const buffer = fs.readFileSync(absolutePath);
    if (!isProbablyText(buffer)) {
      return `### ${relativePath}\n(skipped: binary file)`;
    }

    return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return `### ${relativePath}\n(skipped: file disappeared before it could be read)`;
    }
    if (error?.code === "EISDIR") {
      return `### ${relativePath}\n(skipped: untracked directory)`;
    }
    throw error;
  }
}

function shouldInlineReviewDiff(...sections) {
  let totalBytes = 0;
  for (const section of sections) {
    totalBytes += Buffer.byteLength(String(section ?? ""), "utf8");
    if (totalBytes > MAX_INLINE_REVIEW_DIFF_BYTES) {
      return false;
    }
  }
  return true;
}

function formatUntrackedFiles(cwd, relativePaths) {
  const sections = [];
  let totalBytes = 0;
  const omittedPaths = [];

  for (let index = 0; index < relativePaths.length; index += 1) {
    const relativePath = relativePaths[index];
    const section = formatUntrackedFile(cwd, relativePath);
    const separator = sections.length > 0 ? "\n\n" : "";
    const nextBytes = Buffer.byteLength(separator + section, "utf8");
    if (totalBytes + nextBytes > MAX_UNTRACKED_TOTAL_BYTES) {
      omittedPaths.push(relativePath);
      continue;
    }
    sections.push(section);
    totalBytes += nextBytes;
  }

  if (omittedPaths.length > 0) {
    const displayedPaths = omittedPaths.slice(0, 20).map((relativePath) => `- ${relativePath}`);
    if (omittedPaths.length > displayedPaths.length) {
      displayedPaths.push(`- ... and ${omittedPaths.length - displayedPaths.length} more`);
    }
    sections.push([
      "### Omitted untracked files",
      `(skipped: ${omittedPaths.length} untracked file(s) omitted because the aggregate untracked-file context exceeds ${MAX_UNTRACKED_TOTAL_BYTES} bytes)`,
      ...displayedPaths,
      `List remaining untracked files with \`${REVIEW_MCP_TOOL_PREFIX}status\` with \`{ "porcelain": true }\` (\`??\` paths), then open them with \`Read\`.`
    ].join("\n"));
  }

  return sections.join("\n\n");
}

function readBoundedGitDiff(cwd, args) {
  const result = git(cwd, args, { maxBuffer: REVIEW_DIFF_READ_MAX_BUFFER });
  if (result.error) {
    if (result.error.code === "ENOBUFS") {
      return { text: "", tooLarge: true };
    }
    throw new Error(
      `${result.command} ${result.args.join(" ")}: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return { text: result.stdout, tooLarge: false };
}

function collectWorkingTreeContext(cwd, state) {
  const status = gitChecked(cwd, ["status", "--short"]).stdout.trim();
  const untrackedBody = formatUntrackedFiles(cwd, state.untracked);
  const stagedDiff = readBoundedGitDiff(cwd, ["diff", "--cached", "--no-ext-diff", "--submodule=diff"]);
  const unstagedDiff = readBoundedGitDiff(cwd, ["diff", "--no-ext-diff", "--submodule=diff"]);
  const inlineDiffs =
    !stagedDiff.tooLarge &&
    !unstagedDiff.tooLarge &&
    shouldInlineReviewDiff(status, stagedDiff.text, unstagedDiff.text, untrackedBody);

  const parts = [
    formatSection("Git Status", status),
    formatSection(
      "Staged Diff",
      inlineDiffs
        ? stagedDiff.text
        : `Large diff omitted. Inspect staged changes with \`${REVIEW_MCP_TOOL_PREFIX}diff\` with \`{ "cached": true, "stat": true }\`, then \`{ "cached": true, "paths": [...] }\` per file (optionally \`head\`). \`Read\` shows the working tree, not the index.`
    ),
    formatSection(
      "Unstaged Diff",
      inlineDiffs
        ? unstagedDiff.text
        : `Large diff omitted. Inspect unstaged changes with \`${REVIEW_MCP_TOOL_PREFIX}diff\` with \`{ "stat": true }\`, then \`{ "paths": [...] }\` per file (optionally \`head\`), and \`Read\` for current file contents.`
    ),
    formatSection("Untracked Files", untrackedBody)
  ];

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n")
  };
}

function collectBranchContext(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  const commitRange = `${mergeBase}..HEAD`;
  const currentBranch = getCurrentBranch(cwd);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", commitRange]).stdout.trim();
  const diff = readBoundedGitDiff(cwd, ["diff", "--no-ext-diff", "--submodule=diff", commitRange]);
  const inlineDiff =
    !diff.tooLarge &&
    shouldInlineReviewDiff(logOutput, diffStat, diff.text);

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase}.`,
    content: [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection(
        "Branch Diff",
        inlineDiff
          ? diff.text
          : `Large diff omitted. Inspect the branch diff with \`${REVIEW_MCP_TOOL_PREFIX}diff\` with \`{ "refs": "${commitRange}", "stat": true }\`, then \`{ "refs": "${commitRange}", "paths": [...] }\` per file (optionally \`head\`).`
      )
    ].join("\n")
  };
}

export function collectReviewContext(cwd, target) {
  const repoRoot = getRepoRoot(cwd);
  const state = getWorkingTreeState(cwd);
  const currentBranch = getCurrentBranch(cwd);
  let details;

  if (target.mode === "working-tree") {
    details = collectWorkingTreeContext(repoRoot, state);
  } else {
    details = collectBranchContext(repoRoot, target.baseRef);
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    ...details
  };
}
