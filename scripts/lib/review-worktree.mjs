/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Ephemeral git worktree lifecycle for review/adversarial-review runs.
 *
 * A branch review runs inside a throwaway `git worktree` so that the reviewed
 * commit is checked out apart from the user's checkout and is removed on
 * cleanup. This is not a filesystem sandbox: absolute paths stay reachable and
 * containment comes from the Bash-free tool allowlist and permission rules.
 * The worktree shares the primary repo's object database, so creating one is
 * cheap.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePluginRuntimeRoot } from "./codex-paths.mjs";

const WORKTREE_DIR_NAME = "review-worktrees";

function runGit(cwd, args, options = {}) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      // Use git's own no-op editor so review never spawns a real editor.
      // `:` is a builtin in both POSIX shells and git's exec resolution.
      GIT_EDITOR: ":",
    },
    ...options,
  });
}

function resolveWorktreesRoot() {
  const root = path.join(resolvePluginRuntimeRoot(), WORKTREE_DIR_NAME);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function makeWorktreePath(label) {
  const slug = label && /^[A-Za-z0-9._-]+$/.test(label) ? label : "review";
  return path.join(
    resolveWorktreesRoot(),
    `${slug}-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`
  );
}

/**
 * Resolve the canonical git ref to materialize for a review. We default to HEAD
 * (the branch tip); callers may pass a specific ref (branch review) or "HEAD" to
 * be explicit.
 */
export function resolveBaseRef(repoRoot, requestedRef = "HEAD") {
  const ref = requestedRef && /^[A-Za-z0-9._/\-~^@]+$/.test(requestedRef)
    ? requestedRef
    : "HEAD";
  const result = runGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (result.status !== 0) {
    throw new Error(
      `git rev-parse ${ref} failed: ${(result.stderr ?? "").trim() || "unknown error"}`
    );
  }
  return result.stdout.trim();
}

/**
 * Create an ephemeral worktree at the resolved ref. Returns `{ path, cleanup }`.
 * The caller MUST invoke `cleanup()` (typically in a `finally` block) so that
 * the worktree is removed even if the review fails.
 */
export function createReviewWorktree(repoRoot, { label = "review", ref = "HEAD" } = {}) {
  const commit = resolveBaseRef(repoRoot, ref);
  const worktreePath = makeWorktreePath(label);

  // `git worktree add --detach <path> <commit>` performs the checkout in one step;
  // splitting it into add+checkout is unnecessary and slower.
  const created = runGit(repoRoot, [
    "worktree",
    "add",
    "--detach",
    worktreePath,
    commit,
  ]);
  if (created.status !== 0) {
    // `git worktree add` may have partially registered a `.git/worktrees/<name>`
    // bookkeeping entry before failing on checkout or ENOSPC. Remove the
    // filesystem directory and then prune so the partial entry is reclaimed.
    cleanupWorktreeDir(worktreePath);
    runGit(repoRoot, ["worktree", "prune"]);
    throw new Error(
      `git worktree add failed: ${(created.stderr ?? "").trim() || "unknown error"}`
    );
  }

  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    safeRemoveWorktree(repoRoot, worktreePath);
  };

  return { path: worktreePath, commit, cleanup };
}

function safeRemoveWorktree(repoRoot, worktreePath) {
  // Best-effort: ask git to remove, then ensure the directory is gone.
  runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  cleanupWorktreeDir(worktreePath);
  // `git worktree prune` cleans up the bookkeeping under .git/worktrees so that
  // a future cleanup pass does not see a dangling entry pointing at a deleted dir.
  runGit(repoRoot, ["worktree", "prune"]);
}

function cleanupWorktreeDir(worktreePath) {
  try {
    fs.rmSync(worktreePath, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Last resort — leave on disk rather than crash the review pipeline.
  }
}

/**
 * Choose how to expose the repository to a review run.
 *
 * For branch reviews we run inside an ephemeral worktree checked out at the
 * branch tip: that gives us mutation isolation without losing any of the
 * commits Claude needs to inspect.
 *
 * For working-tree reviews we deliberately *do not* create a worktree. A
 * worktree-from-HEAD would hide the very staged/unstaged/untracked changes
 * that the reviewer is supposed to inspect — `git status` would report clean,
 * `git diff` would show nothing, and the MCP server pointed at the worktree
 * would mislead Claude into thinking the repo is unchanged. Instead we run in
 * the original repo; the Bash-free allowlist limits what Claude can do there,
 * but nothing isolates the checkout itself.
 *
 * Returns `{ cwd, gitRoot, cleanup }`. `gitRoot` is the path the MCP git server
 * should be rooted at; `cwd` is what the Claude CLI should treat as the
 * working directory.
 */
export function createReviewIsolation(repoRoot, target, { label = "review" } = {}) {
  if (target?.mode === "working-tree") {
    return {
      cwd: repoRoot,
      gitRoot: repoRoot,
      cleanup: () => {},
      isolated: false,
    };
  }
  const worktree = createReviewWorktree(repoRoot, { label });
  return {
    cwd: worktree.path,
    gitRoot: worktree.path,
    cleanup: () => worktree.cleanup(),
    isolated: true,
  };
}

/**
 * Sweep stale worktrees left behind by crashes. Called on every review start
 * so that long-running plugin installs do not accumulate dead worktrees.
 */
export function pruneStaleReviewWorktrees(repoRoot, { maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  const root = resolveWorktreesRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs < maxAgeMs) continue;
    safeRemoveWorktree(repoRoot, full);
  }
}

// ---------------------------------------------------------------------------
// Project permission restrictions for protected reviews
// ---------------------------------------------------------------------------

const PROJECT_SETTINGS_FILES = ["settings.json", "settings.local.json"];
// Keys that only grant capability or pick a mode. Reviews force `dontAsk`, so
// dropping them cannot weaken a restriction.
const IGNORED_PERMISSION_KEYS = new Set([
  "allow",
  "additionalDirectories",
  "defaultMode",
  "disableBypassPermissionsMode",
  "disableAutoMode",
]);
// The first character can never be "-": rules become argv values, and a value
// shaped like a flag would be parsed as a separate Claude CLI option.
const RULE_PATTERN = /^([A-Za-z_*][A-Za-z0-9_*.-]*)(?:\((.*)\))?$/s;

function projectSettingsUnsupported(file, reason) {
  return Object.assign(
    new Error(
      `PROJECT_SETTINGS_UNSUPPORTED: ${file}: ${reason}. ` +
        "The review did not start because this project permission protection could not be preserved in an isolated review. " +
        "Do not edit or remove project permission rules to pass this check; changing that policy is a human decision."
    ),
    { code: "PROJECT_SETTINGS_UNSUPPORTED" }
  );
}

/**
 * Directories whose `.claude/` may hold settings Claude Code would apply to a
 * session started in `dir`: the directory itself, its worktree root, and the
 * primary checkout, which stores local settings for linked worktrees.
 */
function projectSettingsDirs(dir) {
  const dirs = [dir];
  const top = runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (top.status === 0) dirs.push(top.stdout.trim());
  const common = runGit(dir, ["rev-parse", "--git-common-dir"]);
  if (common.status === 0) {
    const commonDir = path.resolve(dir, common.stdout.trim());
    if (path.basename(commonDir) === ".git") dirs.push(path.dirname(commonDir));
  }
  return dirs;
}

function readRestrictionRules(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw projectSettingsUnsupported(file, `cannot be inspected (${error?.code ?? "error"})`);
  }
  if (!stat.isFile()) throw projectSettingsUnsupported(file, "is not a regular file");

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw projectSettingsUnsupported(file, "is not valid JSON");
  }
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(settings)) throw projectSettingsUnsupported(file, "is not a JSON object");
  if (settings.permissions === undefined) return [];
  if (!isObject(settings.permissions)) {
    throw projectSettingsUnsupported(file, "permissions is not an object");
  }

  const rules = [];
  for (const [key, value] of Object.entries(settings.permissions)) {
    if (IGNORED_PERMISSION_KEYS.has(key)) continue;
    if (key !== "deny" && key !== "ask") {
      throw projectSettingsUnsupported(file, `permissions.${key} is not supported`);
    }
    if (!Array.isArray(value)) {
      throw projectSettingsUnsupported(file, `permissions.${key} is not an array`);
    }
    for (const rule of value) {
      const match = typeof rule === "string" ? RULE_PATTERN.exec(rule) : null;
      const [, tool, specifier] = match ?? [];
      if (
        !match ||
        specifier === "" ||
        /\p{Cc}/u.test(rule) ||
        (specifier !== undefined && tool.startsWith("mcp__"))
      ) {
        throw projectSettingsUnsupported(file, `permissions.${key} rule ${JSON.stringify(rule)} is not supported`);
      }
      // Negation only cancels rules from its own source; flattening sources
      // into one CLI list would change what it cancels.
      if (specifier?.startsWith("!")) {
        throw projectSettingsUnsupported(file, `permissions.${key} negated rule ${JSON.stringify(rule)} is not supported`);
      }
      rules.push({ tool, specifier, rule });
    }
  }
  return rules;
}

/** `//`-anchored copy of a cwd-relative Read/Edit rule, widened to any depth under `anchor`. */
function pinToAnchor({ tool, specifier }, anchor) {
  if (
    (tool !== "Read" && tool !== "Edit") ||
    specifier === undefined ||
    specifier.startsWith("//") ||
    specifier.startsWith("~/")
  ) {
    return null;
  }
  const posixAnchor = anchor
    .replace(/\\/g, "/")
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  if (/[*?[\]!]/.test(posixAnchor)) {
    throw projectSettingsUnsupported(
      anchor,
      "the original checkout path contains glob characters, so its relative rules cannot be pinned"
    );
  }
  return `${tool}(/${posixAnchor}/**/${specifier.replace(/^\.?\//, "")})`;
}

/**
 * Collect project `deny` and `ask` rules (dontAsk denies asks) that Claude Code
 * would apply in the original checkout and in the reviewed tree, for
 * `--disallowedTools`. Project settings are read as untrusted data and never
 * loaded by Claude. CLI rules anchor at the review cwd like project rules, so
 * rules pass through verbatim. When the review runs elsewhere (a worktree),
 * the original tree's relative Read/Edit rules also get `//` copies pinned to
 * the original cwd and, when that cwd is below the repo root, to the matching
 * subdirectory of the review cwd, whose own reviewed settings are collected and
 * pinned there too. Throws PROJECT_SETTINGS_UNSUPPORTED for anything whose
 * meaning cannot be preserved.
 */
export function collectProjectReviewRestrictions(reviewCwd, originalCwd = reviewCwd) {
  const realOrNull = (file) => {
    try {
      return fs.realpathSync.native(file);
    } catch {
      return null;
    }
  };
  const realReview = realOrNull(reviewCwd) ?? path.resolve(reviewCwd);
  const realOriginal = realOrNull(originalCwd) ?? path.resolve(originalCwd);
  const relocated = realReview !== realOriginal;
  // Original rules anchor at the user's cwd. A review worktree starts at the
  // repo root, so a cwd below the root maps to the same subdirectory there.
  let subdir = "";
  if (relocated) {
    const prefix = runGit(originalCwd, ["rev-parse", "--show-prefix"]);
    if (prefix.status !== 0) {
      throw projectSettingsUnsupported(originalCwd, "its location inside the repository could not be determined");
    }
    subdir = prefix.stdout.trim().replace(/\/$/, "");
  }
  const reviewSubdir = subdir ? path.join(realReview, subdir) : null;
  const originalAnchors = relocated ? [realOriginal, ...(reviewSubdir ? [reviewSubdir] : [])] : [];

  // Each settings file maps to the `//` anchors its relative rules need beyond
  // the verbatim copy (which anchors at the review cwd).
  const files = new Map();
  const addFiles = (dirs, anchors) => {
    for (const settingsDir of dirs) {
      for (const name of PROJECT_SETTINGS_FILES) {
        const file = path.join(settingsDir, ".claude", name);
        const key = realOrNull(file) ?? path.resolve(file);
        files.set(key, { file, anchors: [...new Set([...(files.get(key)?.anchors ?? []), ...anchors])] });
      }
    }
  };
  addFiles(projectSettingsDirs(reviewCwd), []);
  addFiles(projectSettingsDirs(originalCwd), originalAnchors);
  // The reviewed tree's copy of the user's subdirectory keeps its own policy,
  // even though Claude starts at the review root.
  if (reviewSubdir) addFiles([reviewSubdir], [reviewSubdir]);

  const restrictions = new Set();
  for (const { file, anchors } of files.values()) {
    for (const parsed of readRestrictionRules(file)) {
      restrictions.add(parsed.rule);
      for (const anchor of anchors) {
        const pinned = pinToAnchor(parsed, anchor);
        if (pinned) restrictions.add(pinned);
      }
    }
  }
  return [...restrictions];
}
