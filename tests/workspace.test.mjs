/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveWorkspaceRoot } from "../scripts/lib/workspace.mjs";

test("keeps the cwd fallback when git rev-parse refuses", {
  skip: process.platform === "win32",
}, () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-root-test-"));
  const workspaceDir = path.join(rootDir, "workspace");
  const childDir = path.join(workspaceDir, "nested");
  const binDir = path.join(rootDir, "bin");
  const originalPath = process.env.PATH;

  try {
    fs.mkdirSync(path.join(workspaceDir, ".git"), { recursive: true });
    fs.mkdirSync(childDir, { recursive: true });
    fs.mkdirSync(binDir);
    const gitPath = path.join(binDir, "git");
    fs.writeFileSync(gitPath, "#!/bin/sh\nexit 128\n", "utf8");
    fs.chmodSync(gitPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    assert.equal(resolveWorkspaceRoot(childDir), childDir);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("uses the physical Git ancestor when a bounded probe times out", {
  skip: process.platform === "win32",
}, () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-root-timeout-test-"));
  const workspaceDir = path.join(rootDir, "workspace");
  const childDir = path.join(workspaceDir, "nested");
  const binDir = path.join(rootDir, "bin");
  const originalPath = process.env.PATH;

  try {
    fs.mkdirSync(path.join(workspaceDir, ".git"), { recursive: true });
    fs.mkdirSync(childDir, { recursive: true });
    fs.mkdirSync(binDir);
    const gitPath = path.join(binDir, "git");
    fs.writeFileSync(gitPath, "#!/bin/sh\nwhile :; do sleep 1; done\n", "utf8");
    fs.chmodSync(gitPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    assert.equal(
      resolveWorkspaceRoot(childDir, {
        filesystemFallbackOnTimeout: true,
        gitTimeout: 50,
      }),
      workspaceDir
    );
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
