/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import process from "node:process";

export function detectExternalHostOrigin() {
  return process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT
    ? "claude-code"
    : null;
}
