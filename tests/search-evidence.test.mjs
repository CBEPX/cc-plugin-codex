/** Copyright 2026 CBEPX contributors. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { StreamParser } from "../scripts/lib/claude-cli.mjs";

it("joins parent search calls with native tool results without retaining page contents", () => {
  const parser = new StreamParser();
  const feed = (event) => parser.feed(JSON.stringify(event) + "\n");
  feed({ type: "stream_event", event: { type: "content_block_start", content_block: {
    type: "tool_use", id: "tool-search-1", name: "WebSearch", input: { query: "public documentation" },
  } } });
  feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-search-1", content: "PRIVATE PAGE CONTENT" }] } });
  assert.equal(parser.state.toolUses[0].toolUseId, "tool-search-1");
  assert.deepEqual(parser.state.toolResults, [{ toolUseId: "tool-search-1", isError: false }]);
  assert.doesNotMatch(JSON.stringify(parser.state.toolResults), /PRIVATE|documentation/);
});

it("does not treat failed, unknown or forwarded subagent results as parent search success", () => {
  const parser = new StreamParser();
  const feed = (event) => parser.feed(JSON.stringify(event) + "\n");
  feed({ type: "stream_event", event: { type: "content_block_start", content_block: {
    type: "tool_use", id: "tool-search-1", name: "WebSearch", input: {},
  } } });
  feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "unknown", content: "ok" }] } });
  feed({ type: "user", parent_tool_use_id: "child", message: { content: [{ type: "tool_result", tool_use_id: "tool-search-1", content: "ok" }] } });
  feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-search-1", is_error: true, content: "quota reached" }] } });
  assert.deepEqual(parser.state.toolResults, [{ toolUseId: "tool-search-1", isError: true }]);
});

it("recognizes a Firecrawl application error inside a successful MCP envelope", () => {
  const parser = new StreamParser();
  parser.feed(JSON.stringify({ type: "stream_event", event: { type: "content_block_start", content_block: {
    type: "tool_use", id: "f1", name: "mcp__firecrawl__firecrawl_search", input: {},
  } } }) + "\n");
  parser.feed(JSON.stringify({ type: "user", message: { content: [{
    type: "tool_result", tool_use_id: "f1", content: [{ type: "text", text: '{"success":false,"error":"quota reached"}' }],
  }] } }) + "\n");
  assert.deepEqual(parser.state.toolResults, [{ toolUseId: "f1", isError: true }]);
});
