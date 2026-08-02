/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";
import path from "node:path";

import { ensureGitRepository } from "./git.mjs";

const cachedWorkspaceRoots = new Map();

function cacheWorkspaceRoot(cacheKey, workspaceRoot) {
  cachedWorkspaceRoots.set(cacheKey, workspaceRoot);
  cachedWorkspaceRoots.set(path.resolve(workspaceRoot), workspaceRoot);
}

function findGitRoot(cwd) {
  // Lifecycle-hook fast path for ordinary repositories and .git-file worktrees.
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveWorkspaceRoot(cwd, options = {}) {
  const cacheKey = path.resolve(cwd);
  // Lifecycle hooks opt in to this process-local handoff so state hashing does
  // not spawn Git again before the short-lived hook process exits.
  if (cachedWorkspaceRoots.has(cacheKey)) {
    return cachedWorkspaceRoots.get(cacheKey);
  }
  try {
    const workspaceRoot = ensureGitRepository(cwd, {
      timeout: options.gitTimeout,
    });
    if (options.processLocalHandoff) {
      cacheWorkspaceRoot(cacheKey, workspaceRoot);
    }
    return workspaceRoot;
  } catch (error) {
    const workspaceRoot =
      error?.code === "ETIMEDOUT" && options.filesystemFallbackOnTimeout
        ? findGitRoot(cwd) ?? cwd
        : cwd;
    if (options.processLocalHandoff) {
      cacheWorkspaceRoot(cacheKey, workspaceRoot);
    }
    return workspaceRoot;
  }
}
