/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  StreamParser,
  areModelIdsEquivalent,
  classifyClaudeFailure,
  validateTurnCompletion,
  resolveModel,
  resolveEffort,
  resolveDefaultModel,
  resolveDefaultEffort,
  buildArgs,
  MODEL_ALIASES,
  EFFORT_ALIASES,
  VALID_EFFORTS,
  DEFAULT_MODEL,
  DEFAULT_EFFORT_BY_MODEL,
  SANDBOX_READ_ONLY_BASH_TOOLS,
  SANDBOX_READ_ONLY_TOOLS,
  SANDBOX_TEMP_DIR,
  SANDBOX_SETTINGS,
  MAX_STREAM_PARSER_UNKNOWN_EVENTS,
  MAX_STREAM_PARSER_PARSE_ERRORS,
  MAX_STREAM_PARSER_TOOL_USES,
  MAX_STREAM_PARSER_TOUCHED_FILES,
  MAX_STREAM_PARSER_MODEL_EVENTS,
  MAX_STDERR_BYTES,
  getClaudeAvailability,
  getClaudeAuthStatus,
  resolveClaudeCommand,
  cancelClaudeProcess,
  runClaudeTurn,
} from "../scripts/lib/claude-cli.mjs";

function createFakeClaudeCommand(tmpDir, source) {
  const packageRoot = path.join(
    tmpDir,
    "node_modules",
    "@anthropic-ai",
    "claude-code"
  );
  const fakeClaude = path.join(packageRoot, "cli.js");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(fakeClaude, source);

  fs.writeFileSync(
    path.join(tmpDir, "claude.cmd"),
    `@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`
  );
  if (process.platform !== "win32") {
    const launcher = path.join(tmpDir, "claude");
    fs.writeFileSync(
      launcher,
      `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`
    );
    fs.chmodSync(launcher, 0o755);
  }

  return fakeClaude;
}

// ===========================================================================
// StreamParser
// ===========================================================================

describe("StreamParser", () => {
  // ---- basic event parsing ------------------------------------------------

  it("parses a result event and marks receivedTerminalEvent", () => {
    const parser = new StreamParser();
    const resultEvent = JSON.stringify({
      type: "result",
      result: "done",
      session_id: "sess-1",
    });
    const events = parser.feed(resultEvent + "\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "result");
    assert.equal(parser.state.receivedTerminalEvent, true);
    assert.equal(parser.state.sessionId, "sess-1");
    assert.equal(parser.state.finalMessage, "done");
  });

  it("captures terminal structured_output even when result text is empty", () => {
    const parser = new StreamParser();
    const resultEvent = JSON.stringify({
      type: "result",
      result: "",
      structured_output: { answer: "ALPHA" },
      session_id: "sess-structured",
    });

    parser.feed(resultEvent + "\n");

    assert.equal(parser.state.receivedTerminalEvent, true);
    assert.deepEqual(parser.state.structuredOutput, { answer: "ALPHA" });
    assert.equal(parser.state.finalMessage, "");
  });

  it("ignores Claude synthetic error model ids", () => {
    const parser = new StreamParser();
    const resultEvent = JSON.stringify({
      type: "result",
      result: "You've hit your session limit · resets 4:50pm (Europe/Moscow)",
      model: "<synthetic>",
      session_id: "sess-limit",
    });

    parser.feed(resultEvent + "\n");

    assert.equal(parser.state.finalModel, null);
    assert.equal(parser.state.hasTerminalLimitSignal, true);
  });

  it("marks only synthetic terminal models as limit signals", () => {
    const syntheticParser = new StreamParser();
    syntheticParser.feed(
      JSON.stringify({
        type: "result",
        result: "done",
        model: "<synthetic>",
      }) + "\n"
    );
    assert.equal(syntheticParser.state.hasTerminalLimitSignal, true);

    const regularParser = new StreamParser();
    regularParser.feed(
      JSON.stringify({
        type: "result",
        result: "done",
        model: "claude-opus-5",
      }) + "\n"
    );
    assert.equal(regularParser.state.hasTerminalLimitSignal, false);
  });

  it("marks synthetic authentication failures as trusted terminal signals", () => {
    const parser = new StreamParser();
    parser.feed(
      JSON.stringify({
        type: "result",
        result: "Invalid API key. Please run /login.",
        model: "<synthetic>",
      }) + "\n"
    );

    assert.equal(parser.state.hasTerminalAuthSignal, true);
  });

  it("does not guess context telemetry from synthetic limit payloads", () => {
    const parser = new StreamParser();
    const resultEvent = JSON.stringify({
      type: "result",
      result: "Claude AI usage limit reached|1751554800",
      modelUsage: {
        "claude-opus-4-8": {
          input_tokens: 10,
          contextWindow: 1000000,
        },
        "<synthetic>": { input_tokens: 0 },
      },
      session_id: "sess-limit",
    });

    parser.feed(
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-opus-4-8" },
      }) + "\n"
    );
    parser.feed(resultEvent + "\n");

    assert.equal(parser.state.finalModel, "claude-opus-4-8");
    assert.equal(parser.state.contextWindow, null);
    assert.equal(parser.state.hasTerminalLimitSignal, true);
    assert.equal(parser.state.unresolvedParseErrors, 0);
  });

  it("does not treat unrelated assistant synthetic model ids as terminal limit signals", () => {
    const parser = new StreamParser();
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: { model: "<synthetic>" },
      session_id: "sess-limit",
    });

    parser.feed(assistantEvent + "\n");

    assert.equal(parser.state.finalModel, null);
    assert.equal(parser.state.hasTerminalLimitSignal, false);
  });

  it("treats assistant synthetic limit text as a terminal limit signal", () => {
    const parser = new StreamParser();
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: {
        model: "<synthetic>",
        content: [
          { type: "text", text: "You've hit your session limit · resets 4:50pm (Europe/Moscow)" },
        ],
      },
      session_id: "sess-limit",
    });
    const resultEvent = JSON.stringify({
      type: "result",
      result: "You've hit your session limit · resets 4:50pm (Europe/Moscow)",
      session_id: "sess-limit",
    });

    parser.feed(assistantEvent + "\n" + resultEvent + "\n");
    const failure = classifyClaudeFailure({
      finalMessage: parser.state.finalMessage,
      finalMessageHasLimitSignal: parser.state.hasTerminalLimitSignal,
    });

    assert.equal(parser.state.finalModel, null);
    assert.equal(parser.state.hasTerminalLimitSignal, true);
    assert.equal(failure.kind, "claude_rate_limit");
    assert.equal(failure.resetText, "4:50pm (Europe/Moscow)");
  });

  it("treats stream wrapper synthetic limit text as a terminal limit signal", () => {
    const parser = new StreamParser();
    const streamEvent = JSON.stringify({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          model: "<synthetic>",
          content: [
            { type: "text", text: "You've hit your session limit · resets 4:50pm (Europe/Moscow)" },
          ],
        },
      },
      session_id: "sess-limit",
    });
    const resultEvent = JSON.stringify({
      type: "result",
      result: "You've hit your session limit · resets 4:50pm (Europe/Moscow)",
      session_id: "sess-limit",
    });

    parser.feed(streamEvent + "\n" + resultEvent + "\n");
    const failure = classifyClaudeFailure({
      finalMessage: parser.state.finalMessage,
      finalMessageHasLimitSignal: parser.state.hasTerminalLimitSignal,
    });

    assert.equal(parser.state.hasTerminalLimitSignal, true);
    assert.equal(failure.kind, "claude_rate_limit");
    assert.equal(failure.resetText, "4:50pm (Europe/Moscow)");
  });

  it("does not overwrite accumulated deltas with a shorter terminal suffix", () => {
    const parser = new StreamParser();
    const delta = JSON.stringify({
      type: "stream_event",
      session_id: "sess-tail",
      event: { delta: { type: "text_delta", text: "Finding 1\nFinding 2\nFinding 3" } },
    });
    const resultEvent = JSON.stringify({
      type: "result",
      session_id: "sess-tail",
      result: "Finding 3",
    });

    parser.feed(delta + "\n");
    parser.feed(resultEvent + "\n");

    assert.equal(
      parser.state.finalMessage,
      "Finding 1\nFinding 2\nFinding 3"
    );
  });

  it("upgrades accumulated deltas when the terminal result is a full superset", () => {
    const parser = new StreamParser();
    const delta = JSON.stringify({
      type: "stream_event",
      session_id: "sess-full",
      event: { delta: { type: "text_delta", text: "Finding 1\nFinding 2" } },
    });
    const resultEvent = JSON.stringify({
      type: "result",
      session_id: "sess-full",
      result: "Finding 1\nFinding 2\nFinding 3",
    });

    parser.feed(delta + "\n");
    parser.feed(resultEvent + "\n");

    assert.equal(
      parser.state.finalMessage,
      "Finding 1\nFinding 2\nFinding 3"
    );
  });

  it("prefers the terminal result when both payloads are non-empty and disagree", () => {
    const parser = new StreamParser();
    const delta = JSON.stringify({
      type: "stream_event",
      session_id: "sess-disjoint",
      event: { delta: { type: "text_delta", text: "Structured review body" } },
    });
    const resultEvent = JSON.stringify({
      type: "result",
      session_id: "sess-disjoint",
      result: "Metadata wrapper",
    });

    parser.feed(delta + "\n");
    parser.feed(resultEvent + "\n");

    assert.equal(parser.state.finalMessage, "Metadata wrapper");
  });

  it("keeps accumulated deltas when the terminal result is empty", () => {
    const parser = new StreamParser();
    const delta = JSON.stringify({
      type: "stream_event",
      session_id: "sess-empty-terminal",
      event: { delta: { type: "text_delta", text: "Structured review body" } },
    });
    const resultEvent = JSON.stringify({
      type: "result",
      session_id: "sess-empty-terminal",
      result: "",
    });

    parser.feed(delta + "\n");
    parser.feed(resultEvent + "\n");

    assert.equal(parser.state.finalMessage, "Structured review body");
  });

  it("parses a text_delta stream_event", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "stream_event",
      session_id: "sess-2",
      event: { delta: { type: "text_delta", text: "hello" } },
    });
    const events = parser.feed(evt + "\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "text");
    assert.equal(events[0].text, "hello");
    assert.equal(events[0].message, "hello");
    assert.equal(events[0].phase, "running");
    assert.equal(parser.state.finalMessage, "hello");
  });

  it("parses a content_block_delta text_delta from newer stream-json output", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "stream_event",
      session_id: "sess-cbd",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "chunk" },
      },
    });
    const events = parser.feed(evt + "\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "text");
    assert.equal(events[0].text, "chunk");
    assert.equal(events[0].message, "chunk");
    assert.equal(events[0].phase, "running");
    assert.equal(events[0].threadId, "sess-cbd");
    assert.equal(parser.state.finalMessage, "chunk");
  });

  it("parses a content_block_delta thinking_delta as progress", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "stream_event",
      session_id: "sess-think",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "planning" },
      },
    });
    const events = parser.feed(evt + "\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "thinking");
    assert.equal(events[0].message, "planning");
    assert.equal(events[0].phase, "thinking");
    assert.equal(events[0].threadId, "sess-think");
  });

  it("emits tagged subagent progress without changing parent state", () => {
    const parser = new StreamParser();
    const topLevelEvent = {
      type: "stream_event",
      session_id: "sess-main",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "main text" },
      },
    };
    const topLevelEvents = parser.feed(JSON.stringify(topLevelEvent) + "\n");
    assert.equal(topLevelEvents.length, 1);
    const parentState = structuredClone(parser.state);

    const subagentEvents = [
      {
        type: "stream_event",
        session_id: "sess-sub",
        parent_tool_use_id: "toolu_sub_1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "subagent text" },
        },
      },
      {
        type: "stream_event",
        parent_tool_use_id: "toolu_sub_1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "subagent thinking" },
        },
      },
      {
        type: "stream_event",
        parent_tool_use_id: "toolu_sub_2",
        event: {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            name: "Write",
            input: { file_path: "/sub.txt" },
          },
        },
      },
      // Current Claude forwards subagent output as complete top-level
      // assistant records, not stream_event deltas.
      {
        type: "assistant",
        parent_tool_use_id: "toolu_sub_3",
        session_id: "sess-main",
        message: {
          model: "claude-haiku-4-5",
          content: [
            { type: "text", text: "assistant record text" },
            { type: "thinking", thinking: "assistant record thinking" },
            { type: "tool_use", name: "Read", input: { path: "/y" } },
          ],
        },
      },
      // Live captures show thinking blocks with empty text (signature only);
      // they still prove the subagent is alive.
      {
        type: "assistant",
        parent_tool_use_id: "toolu_sub_3",
        session_id: "sess-main",
        message: {
          model: "claude-haiku-4-5",
          content: [{ type: "thinking", thinking: "", signature: "sig" }],
        },
      },
    ];
    const events = parser.feed(
      subagentEvents.map((event) => JSON.stringify(event)).join("\n") + "\n"
    );

    assert.equal(events.length, 7);
    assert.deepEqual(
      events.map((e) => e.kind),
      [
        "subagent_text",
        "subagent_thinking",
        "subagent_tool_use",
        "subagent_text",
        "subagent_thinking",
        "subagent_tool_use",
        "subagent_thinking",
      ]
    );
    assert.ok(events.every((e) => e.subagent === true));
    assert.ok(events.every((e) => e.phase === "subagent"));
    assert.equal(events[0].parentToolUseId, "toolu_sub_1");
    assert.equal(events[0].message, "subagent text");
    assert.equal(events[1].message, "subagent thinking");
    assert.equal(events[2].tool, "Write");
    assert.equal(events[2].message, "Subagent using tool: Write");
    assert.equal(events[3].parentToolUseId, "toolu_sub_3");
    assert.equal(events[3].message, "assistant record text");
    assert.equal(events[4].message, "assistant record thinking");
    assert.equal(events[5].tool, "Read");
    assert.equal(events[5].message, "Subagent using tool: Read");
    assert.equal(events[6].message, "Subagent thinking…");
    assert.deepEqual(parser.state, parentState);
  });

  it("drops non-stream subagent events without changing parent state", () => {
    const parser = new StreamParser();
    const topLevelEvent = {
      type: "stream_event",
      session_id: "sess-main",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "main text" },
      },
    };
    parser.feed(JSON.stringify(topLevelEvent) + "\n");
    const parentState = structuredClone(parser.state);

    const subagentEvents = [
      {
        type: "stream_event",
        parent_tool_use_id: "toolu_nested",
        event: {
          type: "model_switch",
          previous_model: "claude-opus-4-8",
          current_model: "claude-haiku-4-5",
        },
      },
      {
        type: "system",
        subtype: "api_retry",
        parent_tool_use_id: "toolu_sub_2",
      },
      {
        type: "user",
        parent_tool_use_id: "toolu_nested",
        message: { content: "subagent tool result" },
      },
      // Lifecycle stream events carry no displayable content.
      {
        type: "stream_event",
        parent_tool_use_id: "toolu_sub_1",
        event: { type: "message_start", message: { model: "<synthetic>" } },
      },
      {
        type: "stream_event",
        parent_tool_use_id: "toolu_sub_1",
        event: { type: "content_block_stop", index: 0 },
      },
      {
        type: "stream_event",
        parent_tool_use_id: "toolu_sub_1",
        event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
      },
      {
        type: "stream_event",
        parent_tool_use_id: "toolu_sub_1",
        event: { type: "message_stop" },
      },
      {
        type: "result",
        parent_tool_use_id: "toolu_sub_2",
        result: "subagent result",
        structured_output: { leaked: true },
        model: "claude-haiku-4-5",
      },
    ];
    const events = parser.feed(
      subagentEvents.map((event) => JSON.stringify(event)).join("\n") + "\n"
    );

    assert.equal(events.length, 0);
    assert.deepEqual(parser.state, parentState);
  });

  it("parses a tool_use content_block_start event", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Read", input: { path: "/a" } },
      },
    });
    const events = parser.feed(evt + "\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "tool_use");
    assert.equal(events[0].tool, "Read");
    assert.deepEqual(events[0].input, { path: "/a" });
    assert.equal(events[0].message, "Using tool: Read");
    assert.equal(events[0].phase, "tool");
    assert.equal(parser.state.toolUses.length, 1);
  });

  it("parses system api_retry event", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({ type: "system", subtype: "api_retry", message: "retrying" });
    const events = parser.feed(evt + "\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "system");
    assert.equal(events[0].subtype, "api_retry");
  });

  it("parses explicit model fallback events", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "system",
      subtype: "model_fallback",
      session_id: "sess-model",
      from_model: "claude-opus-4-8",
      to_model: "claude-sonnet-5",
      reason: "capacity",
    });

    const events = parser.feed(evt + "\n");

    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "model_fallback");
    assert.equal(events[0].phase, "model_fallback");
    assert.deepEqual(events[0].modelFallback.fromModel, "claude-opus-4-8");
    assert.deepEqual(events[0].modelFallback.toModel, "claude-sonnet-5");
    assert.equal(events[0].modelFallback.reason, "capacity");
    assert.equal(parser.state.modelEvents.length, 1);
  });

  it("parses nested model fallback events", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "stream_event",
      session_id: "sess-nested-model",
      event: {
        type: "model_switch",
        previous_model: "claude-opus-4-8",
        current_model: "claude-sonnet-5",
      },
    });

    const events = parser.feed(evt + "\n");

    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "model_fallback");
    assert.equal(events[0].modelFallback.fromModel, "claude-opus-4-8");
    assert.equal(events[0].modelFallback.toModel, "claude-sonnet-5");
  });

  it("parses model switch marker events that only report the target model", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "system",
      subtype: "model_switch",
      session_id: "sess-switch-marker",
      model: "claude-sonnet-5",
    });

    const events = parser.feed(evt + "\n");

    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "model_fallback");
    assert.equal(events[0].modelFallback.fromModel, null);
    assert.equal(events[0].modelFallback.toModel, "claude-sonnet-5");
  });

  it("parses compact modelswitch marker events", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "system",
      subtype: "modelswitch",
      session_id: "sess-compact-switch",
      model: "claude-haiku-4-5",
    });

    const events = parser.feed(evt + "\n");

    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "model_fallback");
    assert.equal(events[0].modelFallback.toModel, "claude-haiku-4-5");
  });

  it("does not misclassify generic changed events with model fields as fallbacks", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "system",
      subtype: "settings_changed",
      message: "settings changed",
      model: "claude-opus-4-8",
    });

    const events = parser.feed(evt + "\n");

    assert.equal(events.length, 0);
    assert.equal(parser.state.modelEvents.length, 0);
  });

  it("does not consume result events with fallback-like prose as model fallbacks", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "result",
      session_id: "sess-result-prose",
      result: "The model changed in the text explanation.",
      model: "claude-sonnet-5",
    });

    const events = parser.feed(evt + "\n");

    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "result");
    assert.equal(parser.state.modelEvents.length, 0);
    assert.equal(parser.state.finalModel, "claude-sonnet-5");
  });

  it("captures the terminal result model", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "result",
      result: "done",
      model: "claude-sonnet-5",
      session_id: "sess-final-model",
    });

    parser.feed(evt + "\n");

    assert.equal(parser.state.finalModel, "claude-sonnet-5");
  });

  it("matches context windows across equivalent model ids in multi-model usage", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "result",
      result: "done",
      model: "claude-fable-5",
      modelUsage: {
        "claude-fable-5[1m]": { contextWindow: 1000000 },
        "claude-haiku-4-5": { contextWindow: 200000 },
      },
    });

    parser.feed(evt + "\n");

    assert.equal(parser.state.finalModel, "claude-fable-5");
    assert.equal(parser.state.contextWindow, 1000000);
  });

  it("rejects invalid context window telemetry", () => {
    for (const contextWindow of [0, -1, 1.5, "1000000", null]) {
      const parser = new StreamParser();
      parser.feed(
        JSON.stringify({
          type: "result",
          result: "done",
          modelUsage: {
            "claude-opus-5": { contextWindow },
          },
        }) + "\n"
      );
      assert.equal(parser.state.contextWindow, null);
    }
  });

  it("does not attribute context telemetry from a different model", () => {
    const parser = new StreamParser();
    parser.feed(
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-sonnet-5" },
      }) + "\n"
    );
    parser.feed(
      JSON.stringify({
        type: "result",
        result: "done",
        model: "claude-opus-5",
        modelUsage: {
          "claude-sonnet-5": { contextWindow: 1000000 },
        },
      }) + "\n"
    );

    assert.equal(parser.state.contextWindow, null);
    assert.equal(parser.state.unresolvedParseErrors, 0);
  });

  it("uses the observed session model when multi-model terminal usage omits it", () => {
    const parser = new StreamParser();
    parser.feed(
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-opus-5" },
      }) + "\n"
    );
    parser.feed(
      JSON.stringify({
        type: "result",
        result: "done",
        modelUsage: {
          "claude-opus-5": { contextWindow: 1000000 },
          "claude-sonnet-5": { contextWindow: 1000000 },
        },
      }) + "\n"
    );

    assert.equal(parser.state.finalModel, "claude-opus-5");
    assert.equal(parser.state.contextWindow, 1000000);
    assert.equal(parser.state.unresolvedParseErrors, 0);
  });

  it("does not guess context telemetry without an observed terminal model", () => {
    const parser = new StreamParser();
    parser.feed(
      JSON.stringify({
        type: "result",
        result: "done",
        modelUsage: {
          "claude-opus-5": { contextWindow: 1000000 },
          "claude-sonnet-5": { contextWindow: 1000000 },
        },
      }) + "\n"
    );

    assert.equal(parser.state.finalModel, null);
    assert.equal(parser.state.contextWindow, null);
    assert.equal(parser.state.unresolvedParseErrors, 0);
  });

  it("does not guess between multiple same-family usage entries for an alias", () => {
    const parser = new StreamParser();
    parser.feed(
      JSON.stringify({
        type: "result",
        result: "done",
        model: "opus",
        modelUsage: {
          "claude-opus-4-8": { contextWindow: 200000 },
          "claude-opus-5": { contextWindow: 1000000 },
        },
      }) + "\n"
    );

    assert.equal(parser.state.finalModel, "opus");
    assert.equal(parser.state.contextWindow, null);
  });

  it("prefers a unique canonical usage entry over family alias matches", () => {
    const parser = new StreamParser();
    parser.feed(
      JSON.stringify({
        type: "result",
        result: "done",
        model: "claude-opus-5",
        modelUsage: {
          opus: { contextWindow: 200000 },
          "claude-opus-5[1m]": { contextWindow: 1000000 },
        },
      }) + "\n"
    );

    assert.equal(parser.state.finalModel, "claude-opus-5");
    assert.equal(parser.state.contextWindow, 1000000);
  });

  it("uses a unique concrete usage entry for a terminal family alias", () => {
    const parser = new StreamParser();
    parser.feed(
      JSON.stringify({
        type: "result",
        result: "done",
        model: "fable",
        modelUsage: {
          "claude-fable-5": { contextWindow: 1000000 },
        },
      }) + "\n"
    );

    assert.equal(parser.state.finalModel, "fable");
    assert.equal(parser.state.contextWindow, 1000000);
  });

  it("captures the observed model from message_start stream events", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "stream_event",
      session_id: "sess-message-model",
      event: {
        type: "message_start",
        message: {
          model: "claude-opus-4-8",
        },
      },
    });

    parser.feed(evt + "\n");

    assert.equal(parser.state.finalModel, "claude-opus-4-8");
  });

  it("captures the final model from result modelUsage", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "result",
      result: "done",
      session_id: "sess-model-usage",
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 1,
          outputTokens: 1,
          contextWindow: 1000000,
        },
      },
    });

    parser.feed(evt + "\n");

    assert.equal(parser.state.finalModel, "claude-sonnet-5");
    assert.equal(parser.state.contextWindow, 1000000);
  });

  it("returns null for unknown event types and tracks them", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({ type: "unknown_event", data: "x" });
    const events = parser.feed(evt + "\n");
    assert.equal(events.length, 0);
    assert.equal(parser.state.unknownEvents.length, 1);
    assert.equal(parser.state.unknownEvents[0].type, "unknown_event");
  });

  it("caps unknown event history to the configured maximum", () => {
    const parser = new StreamParser();

    for (let i = 0; i < MAX_STREAM_PARSER_UNKNOWN_EVENTS + 7; i++) {
      parser.feed(JSON.stringify({ type: `unknown_${i}` }) + "\n");
    }

    assert.equal(parser.state.unknownEvents.length, MAX_STREAM_PARSER_UNKNOWN_EVENTS);
    assert.equal(parser.state.unknownEvents[0].type, "unknown_7");
    assert.equal(
      parser.state.unknownEvents.at(-1).type,
      `unknown_${MAX_STREAM_PARSER_UNKNOWN_EVENTS + 6}`
    );
  });

  it("caps model fallback history to the configured maximum", () => {
    const parser = new StreamParser();

    for (let i = 0; i < MAX_STREAM_PARSER_MODEL_EVENTS + 3; i++) {
      parser.feed(
        JSON.stringify({
          type: "system",
          subtype: "model_fallback",
          from_model: `claude-opus-${i}`,
          to_model: `claude-sonnet-${i}`,
        }) + "\n"
      );
    }

    assert.equal(parser.state.modelEvents.length, MAX_STREAM_PARSER_MODEL_EVENTS);
    assert.equal(parser.state.modelEvents[0].fromModel, "claude-opus-3");
    assert.equal(
      parser.state.modelEvents.at(-1).toModel,
      `claude-sonnet-${MAX_STREAM_PARSER_MODEL_EVENTS + 2}`
    );
  });

  it("skips blank lines", () => {
    const parser = new StreamParser();
    const events = parser.feed("\n\n\n");
    assert.equal(events.length, 0);
  });

  // ---- chunk-boundary buffering ------------------------------------------

  it("buffers incomplete JSON across chunks", () => {
    const parser = new StreamParser();
    const full = JSON.stringify({ type: "result", result: "ok", session_id: "s1" });
    const mid = Math.floor(full.length / 2);

    // first chunk — incomplete line, no events
    const events1 = parser.feed(full.slice(0, mid));
    assert.equal(events1.length, 0);

    // second chunk — completes the line
    const events2 = parser.feed(full.slice(mid) + "\n");
    assert.equal(events2.length, 1);
    assert.equal(events2[0].kind, "result");
    assert.equal(parser.state.receivedTerminalEvent, true);
  });

  it("handles multiple events in a single chunk", () => {
    const parser = new StreamParser();
    const ev1 = JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "a" } } });
    const ev2 = JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "b" } } });
    const events = parser.feed(ev1 + "\n" + ev2 + "\n");
    assert.equal(events.length, 2);
    assert.equal(parser.state.finalMessage, "ab");
  });

  // ---- flush -------------------------------------------------------------

  it("flush() processes remaining buffer content", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({ type: "result", result: "final", session_id: "s2" });
    // feed without trailing newline
    parser.feed(evt);
    assert.equal(parser.state.receivedTerminalEvent, false);

    const flushed = parser.flush();
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].kind, "result");
    assert.equal(parser.state.receivedTerminalEvent, true);
  });

  it("flush() on empty buffer returns empty array", () => {
    const parser = new StreamParser();
    assert.deepEqual(parser.flush(), []);
  });

  it("flush() on whitespace-only buffer returns empty array", () => {
    const parser = new StreamParser();
    parser.feed("   ");
    assert.deepEqual(parser.flush(), []);
  });

  // ---- parse error handling -----------------------------------------------

  it("records parse errors for invalid JSON", () => {
    const parser = new StreamParser();
    const events = parser.feed("not valid json\n");
    assert.equal(events.length, 0);
    assert.equal(parser.state.unresolvedParseErrors, 1);
    assert.equal(parser.state.parseErrors.length, 1);
    assert.ok(parser.state.parseErrors[0].line.includes("not valid json"));
  });

  it("caps stored parse error samples while keeping the total unresolved count", () => {
    const parser = new StreamParser();

    for (let i = 0; i < MAX_STREAM_PARSER_PARSE_ERRORS + 9; i++) {
      parser.feed(`not valid json ${i}\n`);
    }

    assert.equal(parser.state.unresolvedParseErrors, MAX_STREAM_PARSER_PARSE_ERRORS + 9);
    assert.equal(parser.state.parseErrors.length, MAX_STREAM_PARSER_PARSE_ERRORS);
    assert.ok(parser.state.parseErrors[0].line.includes(`not valid json 9`));
  });

  it("caps stored tool-use samples and touched file tracking", () => {
    const parser = new StreamParser();
    const total = MAX_STREAM_PARSER_TOOL_USES + 11;

    for (let i = 0; i < total; i++) {
      parser.feed(
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: {
              type: "tool_use",
              name: i % 2 === 0 ? "Write" : "Edit",
              input: { file_path: `/tmp/file-${i}.txt` },
            },
          },
        }) + "\n"
      );
    }

    assert.equal(parser.state.toolUses.length, MAX_STREAM_PARSER_TOOL_USES);
    assert.equal(parser.state.toolUses[0].input.file_path, "/tmp/file-11.txt");
    assert.equal(
      parser.state.toolUses.at(-1).input.file_path,
      `/tmp/file-${total - 1}.txt`
    );
    assert.equal(parser.state.touchedFiles.length, MAX_STREAM_PARSER_TOUCHED_FILES);
    assert.equal(parser.state.touchedFiles[0], "/tmp/file-11.txt");
    assert.equal(
      parser.state.touchedFiles.at(-1),
      `/tmp/file-${total - 1}.txt`
    );
  });

  // ---- session_id extraction ----------------------------------------------

  it("extracts session_id from first event only", () => {
    const parser = new StreamParser();
    const ev1 = JSON.stringify({ type: "stream_event", session_id: "first", event: { delta: { type: "text_delta", text: "x" } } });
    const ev2 = JSON.stringify({ type: "stream_event", session_id: "second", event: { delta: { type: "text_delta", text: "y" } } });
    parser.feed(ev1 + "\n" + ev2 + "\n");
    assert.equal(parser.state.sessionId, "first");
  });
});

describe("classifyClaudeFailure", () => {
  it("classifies Fable model-credit limits from terminal output", () => {
    const failure = classifyClaudeFailure({
      finalMessage: "You've reached your Fable 5 limit",
      finalMessageHasLimitSignal: true,
    });

    assert.equal(failure.kind, "claude_rate_limit");
    assert.match(failure.message, /Fable 5 limit/);
    assert.equal(failure.resetText, null);
  });

  it("classifies authentication stderr from a failed command without a terminal event", () => {
    const failure = classifyClaudeFailure({
      stderr: "Not logged in. Run claude auth login to continue.",
      exitCode: 1,
      receivedTerminalEvent: false,
    });

    assert.equal(failure.kind, "claude_auth");
    assert.match(failure.message, /auth login/);
  });

  it("ignores authentication stderr without trusted failure provenance", () => {
    const stderr = "Not logged in. Run claude auth login to continue.";

    assert.equal(classifyClaudeFailure({ stderr }), null);
    assert.equal(
      classifyClaudeFailure({
        stderr,
        exitCode: 1,
        receivedTerminalEvent: true,
      }),
      null
    );
  });

  it("classifies authentication failures from terminal output", () => {
    const failure = classifyClaudeFailure({
      finalMessage: "Invalid API key. Please run /login.",
      finalMessageHasAuthSignal: true,
    });

    assert.equal(failure.kind, "claude_auth");
  });

  it("ignores authentication prose from ordinary final output", () => {
    assert.equal(
      classifyClaudeFailure({
        finalMessage: "Documented the invalid API key and claude auth login errors.",
      }),
      null
    );
  });

  it("prefers a terminal quota signal over secondary auth stderr", () => {
    const failure = classifyClaudeFailure({
      finalMessage: "You've reached your Fable 5 limit",
      finalMessageHasLimitSignal: true,
      stderr: "Not logged in. Run claude auth login.",
    });

    assert.equal(failure.kind, "claude_rate_limit");
  });

  it("classifies Claude 429 stderr and extracts reset text", () => {
    const failure = classifyClaudeFailure({
      stderr: "APIErrorStatus: 429. You've hit your session limit; resets at 4:50pm (Europe/Moscow).",
    });

    assert.equal(failure.kind, "claude_rate_limit");
    assert.match(failure.message, /429/);
    assert.equal(failure.resetText, "4:50pm (Europe/Moscow)");
  });

  it("classifies strong Claude limit messages from final output", () => {
    const failure = classifyClaudeFailure({
      finalMessage: "You've hit your session limit · resets 4:50pm (Europe/Moscow)",
      finalMessageHasLimitSignal: true,
    });

    assert.equal(failure.kind, "claude_rate_limit");
    assert.match(failure.message, /session limit/);
    assert.equal(failure.resetText, "4:50pm (Europe/Moscow)");
  });

  it("ignores strong-looking limit prose from final output without a synthetic model signal", () => {
    assert.equal(
      classifyClaudeFailure({
        finalMessage: "Added session limit enforcement; the counter resets every hour.",
        stderr: "Error: cancellation signal interrupted the tool call.",
      }),
      null
    );
    assert.equal(
      classifyClaudeFailure({
        finalMessage: "Documented the fixture: You've hit your session limit · resets 4:50pm.",
        stderr: "Error: cancellation signal interrupted the tool call.",
      }),
      null
    );
  });

  it("classifies usage-limit-reached final output when Claude marks it synthetic", () => {
    const failure = classifyClaudeFailure({
      finalMessage: "Claude AI usage limit reached|1751554800",
      finalMessageHasLimitSignal: true,
    });

    assert.equal(failure.kind, "claude_rate_limit");
    assert.match(failure.message, /usage limit reached/);
    assert.equal(failure.resetText, "2025-07-03T15:00:00.000Z");
  });

  it("extracts reset text from stderr when final output has the limit signal", () => {
    const failure = classifyClaudeFailure({
      finalMessage: "Claude AI usage limit reached",
      finalMessageHasLimitSignal: true,
      stderr: "APIErrorStatus: 429; resets at 4:50pm (Europe/Moscow).",
    });

    assert.equal(failure.kind, "claude_rate_limit");
    assert.equal(failure.resetText, "4:50pm (Europe/Moscow)");
  });

  it("does not extract unrelated reset prose from stderr", () => {
    const failure = classifyClaudeFailure({
      finalMessage: "Claude AI usage limit reached",
      finalMessageHasLimitSignal: true,
      stderr: "watchdog resets the connection after 30 seconds",
    });

    assert.equal(failure.kind, "claude_rate_limit");
    assert.equal(failure.resetText, null);
  });

  it("does not extract unrelated reset prose from stderr-classified failures", () => {
    const failure = classifyClaudeFailure({
      stderr: "HTTP 429 from Claude API\nwatchdog resets the connection after 30 seconds",
    });

    assert.equal(failure.kind, "claude_rate_limit");
    assert.equal(failure.resetText, null);
  });

  it("does not extract unrelated reset prose from same-line stderr-classified failures", () => {
    const failure = classifyClaudeFailure({
      stderr: "HTTP 429 from Claude API; watchdog resets the connection after 30 seconds",
    });

    assert.equal(failure.kind, "claude_rate_limit");
    assert.equal(failure.resetText, null);
  });

  it("uses reset prose that follows the terminal limit text in final output", () => {
    const failure = classifyClaudeFailure({
      finalMessage:
        "the watchdog resets the connection after 30 seconds. " +
        "You've hit your session limit · resets 4:50pm (Europe/Moscow)",
      finalMessageHasLimitSignal: true,
    });

    assert.equal(failure.kind, "claude_rate_limit");
    assert.equal(failure.resetText, "4:50pm (Europe/Moscow)");
  });

  it("uses the last terminal reset when earlier output quotes canonical epoch fixtures", () => {
    const failure = classifyClaudeFailure({
      finalMessage:
        "quoted fixture: Claude AI usage limit reached|1751554800. " +
        "You've hit your session limit · resets 6:00pm (Europe/Moscow)",
      finalMessageHasLimitSignal: true,
    });

    assert.equal(failure.kind, "claude_rate_limit");
    assert.equal(failure.resetText, "6:00pm (Europe/Moscow)");
  });

  it("uses the last canonical epoch when multiple canonical limit epochs are present", () => {
    const failure = classifyClaudeFailure({
      finalMessage:
        "quoted fixture: Claude AI usage limit reached|1751554800. " +
        "Claude AI usage limit reached|1751558400",
      finalMessageHasLimitSignal: true,
    });

    assert.equal(failure.kind, "claude_rate_limit");
    assert.equal(failure.resetText, "2025-07-03T16:00:00.000Z");
  });

  it("only extracts epochs from canonical usage-limit text", () => {
    const failure = classifyClaudeFailure({
      finalMessage: "Claude AI usage limit reached; resets 4:50pm (Europe/Moscow). fixture reached|1751554800",
      finalMessageHasLimitSignal: true,
    });

    assert.equal(failure.kind, "claude_rate_limit");
    assert.equal(failure.resetText, "4:50pm (Europe/Moscow)");
  });

  it("classifies loose limit markers from stderr", () => {
    assert.equal(
      classifyClaudeFailure({ stderr: "HTTP 429 from Claude API" })?.kind,
      "claude_rate_limit"
    );
    assert.equal(
      classifyClaudeFailure({ stderr: "rate_limit exceeded" })?.kind,
      "claude_rate_limit"
    );
  });

  it("accepts the supported spacing and separator variants", () => {
    const finalMessages = [
      "youve   hit  your   weekly limit",
      "you have hit your limit",
      "session   limit after a cooldown resets tomorrow",
      "usage  limit  reached",
    ];
    for (const finalMessage of finalMessages) {
      assert.equal(
        classifyClaudeFailure({
          finalMessage,
          finalMessageHasLimitSignal: true,
        })?.kind,
        "claude_rate_limit",
        finalMessage
      );
    }

    for (const stderr of ["ratelimit exceeded", "rate limit exceeded", "rate-limit exceeded"]) {
      assert.equal(classifyClaudeFailure({ stderr })?.kind, "claude_rate_limit", stderr);
    }
  });

  it("uses source order across textual and canonical reset markers", () => {
    const failure = classifyClaudeFailure({
      finalMessage:
        "You've hit your session limit · resets 4:50pm (Europe/Moscow). " +
        "Claude AI usage limit reached|1751558400",
      finalMessageHasLimitSignal: true,
    });

    assert.equal(failure.kind, "claude_rate_limit");
    assert.equal(failure.resetText, "2025-07-03T16:00:00.000Z");
  });

  it("ignores loose rate-limit markers from final model output", () => {
    assert.equal(
      classifyClaudeFailure({
        finalMessage: "Implemented 429 retry handling for rate limiting responses.",
        stderr: "Error: cancellation signal interrupted the tool call.",
      }),
      null
    );
    assert.equal(
      classifyClaudeFailure({
        finalMessage: "Implemented rate-limit retry handling.",
        stderr: "Error: cancellation signal interrupted the tool call.",
      }),
      null
    );
  });

  it("ignores non-limit failures", () => {
    assert.equal(classifyClaudeFailure({ stderr: "syntax error" }), null);
  });
});

describe("runClaudeTurn", () => {
  it("sends a large Unicode prompt through stdin and keeps it out of argv", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-claude-stdin-"));
    const oldPath = process.env.PATH ?? "";
    try {
      createFakeClaudeCommand(
        tmpDir,
        `let prompt = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (chunk) => { prompt += chunk; });\nprocess.stdin.on("end", () => {\n  const result = JSON.stringify({ argv: process.argv.slice(2), prompt });\n  const out = JSON.stringify({ type: "result", result, session_id: "sess-stdin" });\n  process.stdout.write(out + "\\n", () => process.exit(0));\n});\n`
      );
      process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;
      const prompt = "Привет, Claude! 🧪\n".repeat(4_000);

      const result = await runClaudeTurn(process.cwd(), prompt);
      const payload = JSON.parse(result.finalMessage);

      assert.equal(result.status, "completed");
      assert.equal(payload.prompt, prompt);
      assert.equal(payload.argv.includes(prompt), false);
      assert.equal(payload.argv.includes("--"), false);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails when the Claude process closes stdin before receiving the prompt", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-claude-stdin-error-"));
    const oldPath = process.env.PATH ?? "";
    try {
      createFakeClaudeCommand(
        tmpDir,
        `process.stdin.destroy();\nsetTimeout(() => {\n  const out = JSON.stringify({ type: "result", result: "done", session_id: "sess-stdin-error" });\n  process.stdout.write(out + "\\n", () => process.exit(0));\n}, 100);\n`
      );
      process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;

      const result = await runClaudeTurn(process.cwd(), "x".repeat(8 * 1024 * 1024));

      assert.equal(result.status, "failed");
      assert.match(result.stderr, /Failed to write Claude prompt to stdin/);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not let a secondary stdin error hide an authentication failure", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-claude-stdin-auth-"));
    const oldPath = process.env.PATH ?? "";
    try {
      createFakeClaudeCommand(
        tmpDir,
        `process.stdin.destroy();\nprocess.stderr.write("Not logged in. Run claude auth login to continue.\\n");\nsetTimeout(() => process.exit(1), 100);\n`
      );
      process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;

      const result = await runClaudeTurn(process.cwd(), "x".repeat(8 * 1024 * 1024));

      assert.equal(result.status, "failed");
      assert.equal(result.warning, undefined);
      assert.equal(result.failure?.kind, "claude_auth");
      assert.match(result.stderr, /Not logged in/);
      assert.match(result.stderr, /Failed to write Claude prompt to stdin/);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps only the newest stderr bytes on failed Claude runs", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-claude-"));
    const oldPath = process.env.PATH ?? "";
    try {
      const longStderr = `DROP-ME\n${"x".repeat(MAX_STDERR_BYTES + 32)}\nKEEP-ME`;
      createFakeClaudeCommand(
        tmpDir,
        `process.stderr.write(${JSON.stringify(longStderr)}, () => process.exit(1));\n`
      );
      process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;

      const result = await runClaudeTurn(process.cwd(), "prompt");

      assert.equal(result.status, "failed");
      assert.ok(Buffer.byteLength(result.stderr, "utf8") <= MAX_STDERR_BYTES);
      assert.ok(result.stderr.endsWith("KEEP-ME"));
      assert.ok(!result.stderr.includes("DROP-ME"));
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("spawns claude with CLAUDE_CODE_FORWARD_SUBAGENT_TEXT=1", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-claude-env-"));
    const oldPath = process.env.PATH ?? "";
    const oldFlag = process.env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT;
    delete process.env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT;
    try {
      createFakeClaudeCommand(
        tmpDir,
        `const result = JSON.stringify({ env: process.env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT ?? "unset", argv: process.argv.slice(2) });\nconst out = JSON.stringify({ type: "result", result, session_id: "sess-env" });\nprocess.stdout.write(out + "\\n", () => process.exit(0));\n`
      );
      process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;

      const options = {
        model: "claude-opus-5",
        effort: "xhigh",
        permissionMode: "dontAsk",
      };
      const result = await runClaudeTurn(process.cwd(), "prompt", options);
      const payload = JSON.parse(result.finalMessage);

      assert.equal(payload.env, "1");
      assert.deepEqual(
        payload.argv,
        buildArgs("prompt", { outputFormat: "stream-json", ...options })
      );
    } finally {
      process.env.PATH = oldPath;
      if (oldFlag === undefined) {
        delete process.env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT;
      } else {
        process.env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT = oldFlag;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses the same PATH-resolved Claude command for availability and auth", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-claude-status-"));
    const oldPath = process.env.PATH ?? "";
    const oldApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      createFakeClaudeCommand(
        tmpDir,
        `const args = process.argv.slice(2);\nif (args[0] === "--version") process.stdout.write("2.1.220\\n");\nprocess.exit(args[0] === "--version" || (args[0] === "auth" && args[1] === "status") ? 0 : 1);\n`
      );
      process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;

      assert.deepEqual(getClaudeAvailability(process.cwd()), {
        available: true,
        detail: "2.1.220",
      });
      assert.deepEqual(getClaudeAuthStatus(process.cwd()), {
        available: true,
        loggedIn: true,
        detail: "authenticated",
      });
    } finally {
      process.env.PATH = oldPath;
      if (oldApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = oldApiKey;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves legacy and current npm shims without a command shell", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-claude-shim-"));
    try {
      const legacyTarget = createFakeClaudeCommand(tmpDir, "");
      assert.deepEqual(resolveClaudeCommand("win32", { PATH: tmpDir }), {
        executable: process.execPath,
        prefixArgs: [legacyTarget],
      });

      const nativeTarget = path.join(
        tmpDir,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe"
      );
      fs.mkdirSync(path.dirname(nativeTarget), { recursive: true });
      fs.writeFileSync(nativeTarget, "");
      fs.writeFileSync(
        path.join(tmpDir, "claude.cmd"),
        `@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n`
      );

      assert.deepEqual(resolveClaudeCommand("win32", { PATH: tmpDir }), {
        executable: nativeTarget,
        prefixArgs: [],
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves a quoted native PATH entry after misses and honors Path casing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-claude-native-"));
    try {
      const missingDir = path.join(tmpDir, "missing");
      const nativeDir = path.join(tmpDir, "native claude");
      const nativeExecutable = path.join(nativeDir, "claude.exe");
      fs.mkdirSync(missingDir);
      fs.mkdirSync(nativeDir);
      fs.writeFileSync(nativeExecutable, "");

      assert.deepEqual(
        resolveClaudeCommand("win32", {
          Path: `; ${missingDir} ;  "${nativeDir}"  `,
        }),
        {
          executable: nativeExecutable,
          prefixArgs: [],
        }
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves a local npm shim that uses the %~dp0 form", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-claude-local-"));
    try {
      const binDir = path.join(tmpDir, "node_modules", ".bin");
      const target = path.join(
        tmpDir,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "cli.js"
      );
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "");
      fs.writeFileSync(
        path.join(binDir, "claude.cmd"),
        `@echo off\r\nnode "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`
      );

      assert.deepEqual(resolveClaudeCommand("win32", { PATH: binDir }), {
        executable: process.execPath,
        prefixArgs: [target],
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips an unsupported shim when a later native Claude executable exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-claude-invalid-"));
    try {
      const firstDir = path.join(tmpDir, "first");
      const secondDir = path.join(tmpDir, "second");
      fs.mkdirSync(firstDir);
      fs.mkdirSync(secondDir);
      fs.writeFileSync(path.join(firstDir, "claude.cmd"), "@echo off\r\nother-cli %*\r\n");
      fs.writeFileSync(path.join(secondDir, "claude.exe"), "");

      const resolved = resolveClaudeCommand("win32", {
        PATH: `${firstDir};${secondDir}`,
      });
      assert.equal(resolved.executable, path.join(secondDir, "claude.exe"));
      assert.deepEqual(resolved.prefixArgs, []);
      assert.equal(resolved.error, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a recognized shim with a missing target and preserves non-Windows resolution", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-claude-missing-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "claude.cmd"),
        `@echo off\r\nnode "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`
      );

      const windowsResult = resolveClaudeCommand("win32", { PATH: tmpDir });
      assert.equal(windowsResult.executable, null);
      assert.match(windowsResult.error, /target could not be resolved safely/iu);
      assert.deepEqual(resolveClaudeCommand("linux", { PATH: tmpDir }), {
        executable: "claude",
        prefixArgs: [],
      });
      assert.deepEqual(resolveClaudeCommand("win32", { PATH: "" }), {
        executable: "claude",
        prefixArgs: [],
      });

      const targetDirectory = path.join(
        tmpDir,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "cli.js"
      );
      fs.mkdirSync(targetDirectory, { recursive: true });
      const directoryResult = resolveClaudeCommand("win32", { PATH: tmpDir });
      assert.equal(directoryResult.executable, null);
      assert.match(directoryResult.error, /target could not be resolved safely/iu);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("cancelClaudeProcess", () => {
  it("uses atomic Windows identity-checked process-tree termination", async () => {
    let terminatedPid = null;
    let terminatedIdentity = null;
    const result = await cancelClaudeProcess(12345, "identity", {
      platform: "win32",
      terminateProcessTreeIfIdentityMatchesImpl: (pid, identity) => {
        terminatedPid = pid;
        terminatedIdentity = identity;
        return {
          attempted: true,
          delivered: true,
          method: "identity-checked-taskkill",
        };
      },
    });

    assert.equal(terminatedPid, 12345);
    assert.equal(terminatedIdentity, "identity");
    assert.deepEqual(result, { cancelled: true });
  });

  it("treats an already-exited Windows process as cancelled", async () => {
    const result = await cancelClaudeProcess(12345, "identity", {
      platform: "win32",
      terminateProcessTreeIfIdentityMatchesImpl: () => ({
        attempted: true,
        delivered: false,
        method: "identity-checked-taskkill",
        reason: "process-missing",
      }),
    });

    assert.deepEqual(result, {
      cancelled: true,
      note: "Process already exited",
    });
  });

  it("reports Windows and POSIX termination errors as failures", async () => {
    const windowsResult = await cancelClaudeProcess(12345, "identity", {
      platform: "win32",
      terminateProcessTreeIfIdentityMatchesImpl: () => {
        throw new Error("access denied");
      },
    });
    const permissionError = Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
    });
    const posixResult = await cancelClaudeProcess(12345, "identity", {
      platform: "linux",
      getProcessIdentityImpl: () => "identity",
      killImpl: () => {
        throw permissionError;
      },
    });

    assert.deepEqual(windowsResult, {
      cancelled: false,
      note: "Failed to terminate process tree: access denied",
    });
    assert.deepEqual(posixResult, {
      cancelled: false,
      note: "Failed to send SIGTERM: operation not permitted",
    });
  });

  it("does not terminate a recycled Windows PID", async () => {
    const result = await cancelClaudeProcess(12345, "old-identity", {
      platform: "win32",
      terminateProcessTreeIfIdentityMatchesImpl: () => ({
        attempted: true,
        delivered: false,
        method: "identity-checked-taskkill",
        reason: "identity-mismatch",
      }),
    });

    assert.deepEqual(result, {
      cancelled: true,
      note: "Process already exited (PID recycled)",
    });
  });

  it("refuses Windows termination without a stable identity", async () => {
    const result = await cancelClaudeProcess(12345, null, {
      platform: "win32",
      terminateProcessTreeIfIdentityMatchesImpl: () => ({
        attempted: false,
        delivered: false,
        method: null,
        reason: "identity-unavailable",
      }),
    });

    assert.deepEqual(result, {
      cancelled: false,
      note: "Refused to terminate process tree without a matching PID identity",
    });
  });

  it("distinguishes a missing POSIX process from other signal errors", async () => {
    const missingError = Object.assign(new Error("missing"), { code: "ESRCH" });
    const result = await cancelClaudeProcess(12345, "identity", {
      platform: "linux",
      getProcessIdentityImpl: () => "identity",
      killImpl: () => {
        throw missingError;
      },
    });

    assert.deepEqual(result, {
      cancelled: true,
      note: "Process not found",
    });
  });

  it("stops after SIGTERM when the POSIX process group exits", async () => {
    const signals = [];
    const waits = [];
    const result = await cancelClaudeProcess(12345, "identity", {
      platform: "linux",
      getProcessIdentityImpl: () => "identity",
      killImpl: (pid, signal) => signals.push([pid, signal]),
      waitForProcessGroupImpl: async (pid, timeout) => {
        waits.push([pid, timeout]);
        return true;
      },
    });

    assert.deepEqual(signals, [[-12345, "SIGTERM"]]);
    assert.deepEqual(waits, [[12345, 5000]]);
    assert.deepEqual(result, { cancelled: true });
  });

  it("fails closed when POSIX identity lookup is unavailable for a live group", async () => {
    const signals = [];
    let leaderChecks = 0;
    const result = await cancelClaudeProcess(12345, "identity", {
      platform: "linux",
      getProcessIdentityImpl: () => {
        throw Object.assign(new Error("lookup unavailable"), { code: "EAGAIN" });
      },
      isProcessAliveImpl: () => {
        leaderChecks += 1;
        return false;
      },
      isProcessGroupAliveImpl: () => true,
      killImpl: (pid, signal) => signals.push([pid, signal]),
    });

    assert.equal(leaderChecks, 1);
    assert.deepEqual(signals, []);
    assert.deepEqual(result, {
      cancelled: false,
      note: "Unable to verify process identity: lookup unavailable",
    });
  });

  it("distinguishes a missing POSIX process, recycled PID, and missing identity", async () => {
    const missing = await cancelClaudeProcess(12345, "identity", {
      platform: "linux",
      getProcessIdentityImpl: () => {
        throw new Error("lookup failed");
      },
      isProcessAliveImpl: () => false,
      isProcessGroupAliveImpl: () => false,
      killImpl: () => assert.fail("missing process must not be signalled"),
    });
    const recycled = await cancelClaudeProcess(12345, "identity", {
      platform: "linux",
      getProcessIdentityImpl: () => "different-identity",
      killImpl: () => assert.fail("recycled PID must not be signalled"),
    });
    const noIdentity = await cancelClaudeProcess(12345, null, {
      platform: "linux",
      killImpl: () => assert.fail("unverified process must not be signalled"),
    });

    assert.deepEqual(missing, {
      cancelled: true,
      note: "Process already exited",
    });
    assert.deepEqual(recycled, {
      cancelled: true,
      note: "Process already exited (PID recycled)",
    });
    assert.deepEqual(noIdentity, {
      cancelled: false,
      note: "Refused to terminate process group without a matching PID identity",
    });
  });

  it("skips SIGKILL when the process group exits after the wait timeout", async () => {
    const signals = [];
    const result = await cancelClaudeProcess(12345, "identity", {
      platform: "linux",
      getProcessIdentityImpl: () => "identity",
      isProcessGroupAliveImpl: () => false,
      killImpl: (pid, signal) => signals.push([pid, signal]),
      waitForProcessGroupImpl: async () => false,
    });

    assert.deepEqual(signals, [[-12345, "SIGTERM"]]);
    assert.deepEqual(result, {
      cancelled: true,
      note: "Process exited during SIGTERM wait",
    });
  });

  it("escalates when the group survives SIGTERM after its leader exits", async () => {
    let identityLookups = 0;
    let waits = 0;
    const signals = [];
    const result = await cancelClaudeProcess(12345, "identity", {
      platform: "linux",
      getProcessIdentityImpl: () => {
        identityLookups += 1;
        return "identity";
      },
      isProcessGroupAliveImpl: () => true,
      killImpl: (pid, signal) => signals.push([pid, signal]),
      waitForProcessGroupImpl: async () => {
        waits += 1;
        return waits === 2;
      },
    });

    assert.equal(identityLookups, 1);
    assert.deepEqual(signals, [
      [-12345, "SIGTERM"],
      [-12345, "SIGKILL"],
    ]);
    assert.deepEqual(result, { cancelled: true });
  });

  it("escalates to SIGKILL and reports whether the process group died", async () => {
    const successfulSignals = [];
    let successfulWaits = 0;
    const killed = await cancelClaudeProcess(12345, "identity", {
      platform: "linux",
      getProcessIdentityImpl: () => "identity",
      isProcessAliveImpl: () => true,
      isProcessGroupAliveImpl: () => true,
      killImpl: (pid, signal) => successfulSignals.push([pid, signal]),
      waitForProcessGroupImpl: async () => {
        successfulWaits += 1;
        return successfulWaits === 2;
      },
    });
    const aliveSignals = [];
    const stillAlive = await cancelClaudeProcess(54321, "identity", {
      platform: "linux",
      getProcessIdentityImpl: () => "identity",
      isProcessAliveImpl: () => true,
      isProcessGroupAliveImpl: () => true,
      killImpl: (pid, signal) => aliveSignals.push([pid, signal]),
      waitForProcessGroupImpl: async () => false,
    });

    assert.deepEqual(successfulSignals, [
      [-12345, "SIGTERM"],
      [-12345, "SIGKILL"],
    ]);
    assert.deepEqual(killed, { cancelled: true });
    assert.deepEqual(aliveSignals, [
      [-54321, "SIGTERM"],
      [-54321, "SIGKILL"],
    ]);
    assert.deepEqual(stillAlive, {
      cancelled: false,
      note: "Process group 54321 still alive after SIGKILL",
    });
  });

  it("refuses SIGKILL when the group leader PID is recycled during the wait", async () => {
    const signals = [];
    let identityLookups = 0;
    const result = await cancelClaudeProcess(12345, "identity", {
      platform: "linux",
      getProcessIdentityImpl: () => {
        identityLookups += 1;
        return identityLookups === 1 ? "identity" : "recycled-identity";
      },
      isProcessAliveImpl: () => true,
      isProcessGroupAliveImpl: () => true,
      killImpl: (pid, signal) => signals.push([pid, signal]),
      waitForProcessGroupImpl: async () => false,
    });

    assert.equal(identityLookups, 2);
    assert.deepEqual(signals, [[-12345, "SIGTERM"]]);
    assert.deepEqual(result, {
      cancelled: true,
      note: "Process exited during SIGTERM wait (PID recycled)",
    });
  });

  it("fails closed when identity cannot be re-verified before SIGKILL", async () => {
    const signals = [];
    let identityLookups = 0;
    const result = await cancelClaudeProcess(12345, "identity", {
      platform: "linux",
      getProcessIdentityImpl: () => {
        identityLookups += 1;
        if (identityLookups === 1) return "identity";
        throw new Error("second lookup failed");
      },
      isProcessAliveImpl: () => true,
      isProcessGroupAliveImpl: () => true,
      killImpl: (pid, signal) => signals.push([pid, signal]),
      waitForProcessGroupImpl: async () => false,
    });

    assert.deepEqual(signals, [[-12345, "SIGTERM"]]);
    assert.deepEqual(result, {
      cancelled: false,
      note: "Unable to re-verify process identity before SIGKILL: second lookup failed",
    });
  });
});

// ===========================================================================
// areModelIdsEquivalent
// ===========================================================================

describe("areModelIdsEquivalent", () => {
  it("treats dated model snapshots as equivalent to their stable alias target", () => {
    assert.equal(
      areModelIdsEquivalent("claude-haiku-4-5", "claude-haiku-4-5-20251001"),
      true
    );
  });

  it("treats Claude CLI aliases as equivalent to concrete family ids", () => {
    assert.equal(areModelIdsEquivalent("fable", "claude-fable-5"), true);
    assert.equal(areModelIdsEquivalent("fable", "claude-fable-5[1m]"), true);
    assert.equal(areModelIdsEquivalent("opus", "claude-opus-5"), true);
  });

  it("ignores bracketed context-window suffixes for comparison", () => {
    assert.equal(
      areModelIdsEquivalent("claude-sonnet-5[1m]", "claude-sonnet-5"),
      true
    );
  });

  it("does not treat different model families as equivalent", () => {
    assert.equal(areModelIdsEquivalent("claude-opus-4-8", "claude-sonnet-5"), false);
  });

  it("does not treat pinned versions in the same family as equivalent", () => {
    assert.equal(areModelIdsEquivalent("claude-opus-4-8", "claude-opus-5"), false);
  });
});

// ===========================================================================
// validateTurnCompletion
// ===========================================================================

describe("validateTurnCompletion", () => {
  it("returns completed for exit 0 with terminal event", () => {
    const state = { receivedTerminalEvent: true, unresolvedParseErrors: 0, unknownEvents: [] };
    const result = validateTurnCompletion(state, 0);
    assert.equal(result.status, "completed");
  });

  it("returns unknown for exit 0 without terminal event", () => {
    const state = { receivedTerminalEvent: false, unresolvedParseErrors: 0, unknownEvents: [] };
    const result = validateTurnCompletion(state, 0);
    assert.equal(result.status, "unknown");
    assert.ok(result.warning.includes("No terminal result event"));
  });

  it("returns failed for non-zero exit code", () => {
    const state = { receivedTerminalEvent: true, unresolvedParseErrors: 0, unknownEvents: [] };
    const result = validateTurnCompletion(state, 1);
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
  });

  it("returns unknown when there are unresolved parse errors", () => {
    const state = { receivedTerminalEvent: true, unresolvedParseErrors: 3, unknownEvents: [] };
    const result = validateTurnCompletion(state, 0);
    assert.equal(result.status, "unknown");
    assert.ok(result.warning.includes("3 unrecovered parse errors"));
  });

  it("returns completed even when unknown events exist (protocol drift)", () => {
    const state = { receivedTerminalEvent: true, unresolvedParseErrors: 0, unknownEvents: [{ type: "new_type", ts: 1 }] };
    const result = validateTurnCompletion(state, 0);
    assert.equal(result.status, "completed");
  });
});

// ===========================================================================
// resolveModel
// ===========================================================================

describe("resolveModel", () => {
  it("passes through the native 'sonnet' alias", () => {
    assert.equal(resolveModel("sonnet"), "sonnet");
  });

  it("passes through the native 'haiku' alias", () => {
    assert.equal(resolveModel("haiku"), "haiku");
  });

  it("passes through unknown model names", () => {
    assert.equal(resolveModel("claude-3-opus-20240229"), "claude-3-opus-20240229");
  });

  it("returns undefined for null/undefined input", () => {
    assert.equal(resolveModel(null), undefined);
    assert.equal(resolveModel(undefined), undefined);
  });

  it("passes through empty string", () => {
    assert.equal(resolveModel(""), undefined);
    assert.equal(resolveModel("   "), undefined);
  });

  it("normalizes and forwards native aliases without pinning a version", () => {
    assert.equal(MODEL_ALIASES.size, 4);
    for (const alias of ["opus", "sonnet", "haiku", "fable"]) {
      assert.equal(MODEL_ALIASES.get(alias), alias);
      assert.equal(resolveModel(` ${alias.toUpperCase()} `), alias);
      const args = buildArgs("p", { model: alias });
      assert.equal(args[args.indexOf("--model") + 1], alias);
    }
  });
});

// ===========================================================================
// resolveDefaultModel / resolveDefaultEffort
// ===========================================================================

describe("resolveDefaultModel", () => {
  it("returns 'opus' when model is null/undefined/empty", () => {
    assert.equal(resolveDefaultModel(null), "opus");
    assert.equal(resolveDefaultModel(undefined), "opus");
    assert.equal(resolveDefaultModel(""), "opus");
    assert.equal(resolveDefaultModel("   "), "opus");
  });

  it("passes through an explicit model", () => {
    assert.equal(resolveDefaultModel("sonnet"), "sonnet");
    assert.equal(resolveDefaultModel("haiku"), "haiku");
    assert.equal(resolveDefaultModel("claude-opus-4-8"), "claude-opus-4-8");
  });

  it("exposes DEFAULT_MODEL constant as 'opus'", () => {
    assert.equal(DEFAULT_MODEL, "opus");
  });
});

describe("resolveDefaultEffort", () => {
  it("defaults to xhigh for the opus alias and supported current ids", () => {
    assert.equal(resolveDefaultEffort("opus", null), "xhigh");
    assert.equal(resolveDefaultEffort("opus[1m]", null), "xhigh");
    assert.equal(resolveDefaultEffort("claude-opus-4-8", null), "xhigh");
    assert.equal(resolveDefaultEffort("claude-opus-5", null), "xhigh");
    assert.equal(resolveDefaultEffort("claude-opus-5[1m]", null), "xhigh");
    assert.equal(resolveDefaultEffort(" OPUS ", undefined), "xhigh");
  });

  it("defaults to high for the sonnet alias and supported current ids", () => {
    assert.equal(resolveDefaultEffort("sonnet", null), "high");
    assert.equal(resolveDefaultEffort("claude-sonnet-5", null), "high");
    assert.equal(resolveDefaultEffort("claude-sonnet-5[1m]", null), "high");
  });

  it("returns undefined for haiku (no effort default)", () => {
    assert.equal(resolveDefaultEffort("haiku", null), undefined);
    assert.equal(resolveDefaultEffort("claude-haiku-4-5", undefined), undefined);
  });

  it("returns undefined for fable (no hidden effort default)", () => {
    assert.equal(resolveDefaultEffort("fable", null), undefined);
    assert.equal(resolveDefaultEffort("claude-fable-5[1m]", undefined), undefined);
  });

  it("returns undefined for unknown model when effort not provided", () => {
    assert.equal(resolveDefaultEffort("some-future-model", null), undefined);
  });

  it("does not broaden alias effort defaults to older pinned family ids", () => {
    assert.equal(resolveDefaultEffort("claude-sonnet-4-5", null), undefined);
    assert.equal(
      resolveDefaultEffort("claude-opus-4-1-20250805", null),
      undefined
    );
    assert.equal(resolveDefaultEffort("claude-opus[1m]-5", null), undefined);
  });

  it("preserves an explicit effort regardless of model", () => {
    assert.equal(resolveDefaultEffort("opus", "low"), "low");
    assert.equal(resolveDefaultEffort("sonnet", "medium"), "medium");
    assert.equal(resolveDefaultEffort("haiku", "high"), "high");
    assert.equal(resolveDefaultEffort(null, "max"), "max");
  });

  it("treats blank effort as missing", () => {
    assert.equal(resolveDefaultEffort("opus", ""), "xhigh");
    assert.equal(resolveDefaultEffort("opus", "   "), "xhigh");
  });

  it("DEFAULT_EFFORT_BY_MODEL contains the expected entries", () => {
    assert.equal(DEFAULT_EFFORT_BY_MODEL.size, 5);
    assert.equal(DEFAULT_EFFORT_BY_MODEL.get("opus"), "xhigh");
    assert.equal(DEFAULT_EFFORT_BY_MODEL.get("claude-opus-4-8"), "xhigh");
    assert.equal(DEFAULT_EFFORT_BY_MODEL.get("claude-opus-5"), "xhigh");
    assert.equal(DEFAULT_EFFORT_BY_MODEL.get("sonnet"), "high");
    assert.equal(DEFAULT_EFFORT_BY_MODEL.get("claude-sonnet-5"), "high");
    assert.equal(DEFAULT_EFFORT_BY_MODEL.has("haiku"), false);
  });
});

// ===========================================================================
// resolveEffort
// ===========================================================================

describe("resolveEffort", () => {
  it("maps 'none' to 'low'", () => {
    assert.equal(resolveEffort("none"), "low");
  });

  it("maps 'minimal' to 'low'", () => {
    assert.equal(resolveEffort("minimal"), "low");
  });

  it("maps 'low' to 'low'", () => {
    assert.equal(resolveEffort("low"), "low");
  });

  it("maps 'medium' to 'medium'", () => {
    assert.equal(resolveEffort("medium"), "medium");
  });

  it("maps 'high' to 'high'", () => {
    assert.equal(resolveEffort("high"), "high");
  });

  it("passes 'xhigh' through as a first-class effort", () => {
    assert.equal(resolveEffort("xhigh"), "xhigh");
  });

  it("maps 'max' to 'max'", () => {
    assert.equal(resolveEffort("max"), "max");
  });

  it("normalizes canonical effort values to lowercase", () => {
    assert.equal(resolveEffort("HIGH"), "high");
    assert.equal(resolveEffort("XHIGH"), "xhigh");
  });

  it("throws on unsupported effort values", () => {
    assert.throws(
      () => resolveEffort("ultra"),
      /Unsupported effort "ultra"/
    );
  });

  it("returns undefined for null/undefined input", () => {
    assert.equal(resolveEffort(null), undefined);
    assert.equal(resolveEffort(undefined), undefined);
  });

  it("VALID_EFFORTS contains low, medium, high, xhigh, max", () => {
    assert.ok(VALID_EFFORTS.has("low"));
    assert.ok(VALID_EFFORTS.has("medium"));
    assert.ok(VALID_EFFORTS.has("high"));
    assert.ok(VALID_EFFORTS.has("xhigh"));
    assert.ok(VALID_EFFORTS.has("max"));
    assert.equal(VALID_EFFORTS.size, 5);
  });

  it("EFFORT_ALIASES only contains legacy compatibility mappings", () => {
    assert.deepEqual(EFFORT_ALIASES, {
      none: "low",
      minimal: "low",
    });
  });
});

// ===========================================================================
// buildArgs
// ===========================================================================

describe("buildArgs", () => {
  it("always starts with -p", () => {
    const args = buildArgs("prompt");
    assert.equal(args[0], "-p");
  });

  it("keeps the prompt out of argv so runClaudeTurn can send it through stdin", () => {
    const prompt = "x".repeat(70_000);
    const args = buildArgs(prompt);

    assert.equal(args.includes("--"), false);
    assert.equal(args.includes(prompt), false);
  });

  it("defaults output format to json", () => {
    const args = buildArgs("p");
    const idx = args.indexOf("--output-format");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "json");
  });

  it("stream-json format includes verbose and include-partial-messages", () => {
    const args = buildArgs("p", { outputFormat: "stream-json" });
    assert.ok(args.includes("--verbose"));
    assert.ok(args.includes("--include-partial-messages"));
    const idx = args.indexOf("--output-format");
    assert.equal(args[idx + 1], "stream-json");
  });

  it("includes --no-session-persistence when set", () => {
    const args = buildArgs("p", { noSessionPersistence: true });
    assert.ok(args.includes("--no-session-persistence"));
  });

  it("does not include --no-session-persistence when not set", () => {
    const args = buildArgs("p", {});
    assert.ok(!args.includes("--no-session-persistence"));
  });

  it("includes --model with the native model alias", () => {
    const args = buildArgs("p", { model: "sonnet" });
    const idx = args.indexOf("--model");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "sonnet");
  });

  it("includes --effort with resolved effort", () => {
    const args = buildArgs("p", { effort: "xhigh" });
    const idx = args.indexOf("--effort");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "xhigh");
  });

  it("omits whitespace-only model and effort values", () => {
    const args = buildArgs("p", { model: "   ", effort: "  " });

    assert.equal(args.includes("--model"), false);
    assert.equal(args.includes("--effort"), false);
    assert.equal(args.every((value) => typeof value === "string"), true);
  });

  it("passes 'max' through as --effort max when explicitly requested", () => {
    const args = buildArgs("p", { effort: "max" });
    const idx = args.indexOf("--effort");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "max");
  });

  it("includes --session-id when provided", () => {
    const args = buildArgs("p", { sessionId: "sid-123" });
    const idx = args.indexOf("--session-id");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "sid-123");
  });

  it("includes --resume when resumeSessionId is provided", () => {
    const args = buildArgs("p", { resumeSessionId: "rsid-456" });
    const idx = args.indexOf("--resume");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "rsid-456");
  });

  it("includes --allowedTools as separate flags per tool", () => {
    const tools = ["Read", "Glob", "Bash(git diff:*)"];
    const args = buildArgs("p", { allowedTools: tools });
    const toolArgs = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--allowedTools") toolArgs.push(args[i + 1]);
    }
    assert.deepEqual(toolArgs, tools);
  });

  it("includes --max-turns as string", () => {
    const args = buildArgs("p", { maxTurns: 5 });
    const idx = args.indexOf("--max-turns");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "5");
  });

  it("includes --json-schema as stringified JSON", () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
    };
    const args = buildArgs("p", { jsonSchema: schema });
    const idx = args.indexOf("--json-schema");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], JSON.stringify(schema));
  });

  it("includes --system-prompt when provided", () => {
    const args = buildArgs("p", { systemPrompt: "Be helpful" });
    const idx = args.indexOf("--system-prompt");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "Be helpful");
  });

  it("includes --permission-mode when provided", () => {
    const args = buildArgs("p", { permissionMode: "dontAsk" });
    const idx = args.indexOf("--permission-mode");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "dontAsk");
  });

  it("includes --settings when settingsFile is provided", () => {
    const args = buildArgs("p", { settingsFile: "/tmp/s.json" });
    const idx = args.indexOf("--settings");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "/tmp/s.json");
  });
});

// ===========================================================================
// SANDBOX_READ_ONLY_TOOLS constant
// ===========================================================================

describe("SANDBOX_READ_ONLY_TOOLS", () => {
  it("contains Read", () => assert.ok(SANDBOX_READ_ONLY_TOOLS.includes("Read")));
  it("contains Glob", () => assert.ok(SANDBOX_READ_ONLY_TOOLS.includes("Glob")));
  it("contains Grep", () => assert.ok(SANDBOX_READ_ONLY_TOOLS.includes("Grep")));
  it("contains explicit read-only git Bash patterns", () => {
    for (const pattern of SANDBOX_READ_ONLY_BASH_TOOLS) {
      assert.ok(SANDBOX_READ_ONLY_TOOLS.includes(pattern));
    }
    assert.ok(!SANDBOX_READ_ONLY_TOOLS.includes("Bash(git:*)"));
  });
  it("contains WebSearch", () => assert.ok(SANDBOX_READ_ONLY_TOOLS.includes("WebSearch")));
  it("contains WebFetch", () => assert.ok(SANDBOX_READ_ONLY_TOOLS.includes("WebFetch")));
  it("contains Agent(explore,plan)", () => assert.ok(SANDBOX_READ_ONLY_TOOLS.includes("Agent(explore,plan)")));
  it("has room for the explicit git allowlist", () => assert.ok(SANDBOX_READ_ONLY_TOOLS.length > 7));
  it("does not contain Write or Edit", () => {
    assert.ok(!SANDBOX_READ_ONLY_TOOLS.includes("Write"));
    assert.ok(!SANDBOX_READ_ONLY_TOOLS.includes("Edit"));
  });
});

// ===========================================================================
// SANDBOX_SETTINGS constant
// ===========================================================================

describe("SANDBOX_SETTINGS", () => {
  it("has read-only and workspace-write keys", () => {
    assert.ok("read-only" in SANDBOX_SETTINGS);
    assert.ok("workspace-write" in SANDBOX_SETTINGS);
  });

  it("read-only enables sandbox with allowWrite [SANDBOX_TEMP_DIR] and unrestricted network", () => {
    const s = SANDBOX_SETTINGS["read-only"].sandbox;
    assert.equal(s.enabled, true);
    assert.deepEqual(s.filesystem.allowWrite, [SANDBOX_TEMP_DIR]);
    // network is intentionally omitted so that WebFetch/WebSearch and Claude's
    // own API path remain reachable; review safety comes from removing Bash
    // from the allowlist instead.
    assert.equal(s.network, undefined);
  });

  it("workspace-write enables sandbox with allowWrite ['.', SANDBOX_TEMP_DIR]", () => {
    const s = SANDBOX_SETTINGS["workspace-write"].sandbox;
    assert.equal(s.enabled, true);
    assert.deepEqual(s.filesystem.allowWrite, [".", SANDBOX_TEMP_DIR]);
    assert.deepEqual(s.network.allowedDomains, []);
  });
});
