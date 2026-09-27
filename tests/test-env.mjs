/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CC_TEST_ORIGINAL_CODEX_HOME ??=
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

const testCodexHome = fs.mkdtempSync(
  path.join(os.tmpdir(), "cc-plugin-codex-test-")
);
process.env.CODEX_HOME = testCodexHome;
delete process.env.CLAUDECODE;
delete process.env.CLAUDE_CODE_ENTRYPOINT;
// Owner resolution must not inherit the session running the test suite.
delete process.env.CLAUDE_COMPANION_SESSION_ID;
delete process.env.CODEX_THREAD_ID;

process.once("exit", () => {
  fs.rmSync(testCodexHome, { recursive: true, force: true });
});
