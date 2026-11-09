#!/usr/bin/env node
/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { readHookInput } from "./lib/hook-input.mjs";
import { dispatchResearchContinuations, pauseResearchContinuations } from "../scripts/lib/research-continuation.mjs";

try {
  const input = readHookInput();
  if (input.hook_event_name === "Interrupt") {
    await pauseResearchContinuations({ cwd: input.cwd, sessionId: input.session_id });
  } else if (input.hook_event_name === "PostToolUse" && input.tool_name === "Bash" &&
      /\b(session-routing-context|peer-create|peer-checkpoint|peer-final|peer-status)\b/.test(input.tool_input?.command ?? "")) {
    const receipts = await dispatchResearchContinuations({ cwd: input.cwd, sessionId: input.session_id });
    if (receipts.length) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse",
      additionalContext: "Research continuation dispatcher receipts: " + JSON.stringify(receipts) } }));
  }
} catch { /* Hook failure preserves the native tool result and manual continuation. */ }
