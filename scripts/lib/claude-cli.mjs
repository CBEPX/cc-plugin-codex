/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Claude Code CLI wrapper — replaces Codex app-server + broker pattern.
 * Spawns `claude -p` subprocess per invocation.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePathSlashes, resolvePluginRuntimeRoot } from "./codex-paths.mjs";
import { getProcessIdentity, validateProcessIdentity } from "./process.mjs";

const CLAUDE_BIN = "claude";
export const MAX_STREAM_PARSER_UNKNOWN_EVENTS = 50;
export const MAX_STREAM_PARSER_PARSE_ERRORS = 50;
export const MAX_STREAM_PARSER_TOOL_USES = 256;
export const MAX_STREAM_PARSER_TOUCHED_FILES = 256;
export const MAX_STREAM_PARSER_MODEL_EVENTS = 50;
export const MAX_STDERR_BYTES = 64 * 1024;
export const SANDBOX_TEMP_DIR = normalizePathSlashes(path.resolve(os.tmpdir()));

const MODEL_FALLBACK_RE = /\bmodel[_ -]?(?:fallback|switch|switched|downgrade|downgraded)\b/i;
const SYNTHETIC_MODEL_IDS = new Set(["<synthetic>"]);

function pushBoundedTail(list, value, maxEntries) {
  list.push(value);
  if (list.length > maxEntries) {
    list.splice(0, list.length - maxEntries);
  }
}

function pushUniqueBoundedTail(list, value, maxEntries) {
  if (!value || list.includes(value)) {
    return;
  }
  pushBoundedTail(list, value, maxEntries);
}

function sliceTextTailByBytes(text, maxBytes) {
  const normalized = typeof text === "string" ? text : String(text ?? "");
  if (!normalized || maxBytes <= 0) {
    return "";
  }
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) {
    return normalized;
  }

  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Buffer.byteLength(normalized.slice(mid), "utf8") > maxBytes) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  let start = low;
  let retained = normalized.slice(start);
  while (start < normalized.length && Buffer.byteLength(retained, "utf8") > maxBytes) {
    start += 1;
    retained = normalized.slice(start);
  }
  return retained;
}

function appendTextTail(existing, chunk, maxBytes) {
  const next = `${existing ?? ""}${chunk ?? ""}`;
  return sliceTextTailByBytes(next, maxBytes);
}

function firstStringField(source, names) {
  if (!source || typeof source !== "object") {
    return null;
  }
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function firstStringFieldFromSources(sources, names) {
  for (const source of sources) {
    const value = firstStringField(source, names);
    if (value) {
      return value;
    }
  }
  return null;
}

function collectEventModelSources(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const sources = [value];
  if (value.event && typeof value.event === "object" && !Array.isArray(value.event)) {
    sources.push(value.event);
    if (
      value.event.message &&
      typeof value.event.message === "object" &&
      !Array.isArray(value.event.message)
    ) {
      sources.push(value.event.message);
    }
  }
  if (value.message && typeof value.message === "object" && !Array.isArray(value.message)) {
    sources.push(value.message);
  }
  return sources;
}

function firstModelUsageKey(value) {
  const modelUsage =
    value && typeof value === "object" && !Array.isArray(value)
      ? value.modelUsage
      : null;
  if (!modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) {
    return null;
  }
  const keys = Object.keys(modelUsage).filter((key) => key.trim());
  return keys.length === 1 ? keys[0] : null;
}

function normalizeObservedModel(model) {
  const normalized = typeof model === "string" ? model.trim() : "";
  if (!normalized || SYNTHETIC_MODEL_IDS.has(normalized.toLowerCase())) {
    return null;
  }
  return normalized;
}

function extractObservedModel(value) {
  return normalizeObservedModel(
    firstStringFieldFromSources(collectEventModelSources(value), [
      "model",
      "actual_model",
      "actualModel",
      "selected_model",
      "selectedModel",
    ]) ?? firstModelUsageKey(value)
  );
}

function extractClaudeLimitResetText(text) {
  const match = String(text ?? "").match(/\bresets(?:\s+at)?\s+([^\r\n.]+)/i);
  return match?.[1]?.trim() ?? null;
}

export function classifyClaudeFailure(value = {}) {
  const message = [value.finalMessage, value.stderr]
    .filter((part) => typeof part === "string" && part.trim())
    .join("\n")
    .trim();
  if (!message) {
    return null;
  }
  if (
    !/you'?ve hit your .*limit|session limit|rate[_ -]?limit|apierrorstatus"?\s*:?\s*429|\b429\b/i.test(message)
  ) {
    return null;
  }
  return {
    kind: "claude_rate_limit",
    message,
    resetText: extractClaudeLimitResetText(message),
  };
}

function compactModelEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const nestedEvent =
    value.event && typeof value.event === "object" && !Array.isArray(value.event)
      ? value.event
      : null;
  const sources = nestedEvent ? [value, nestedEvent] : [value];
  const modelContext = [
    value.type,
    value.subtype,
    value.name,
    typeof value.event === "string" ? value.event : null,
    nestedEvent?.type,
    nestedEvent?.name,
    nestedEvent?.subtype,
  ].filter((part) => typeof part === "string").join(" ");
  const hasFallbackMarker = MODEL_FALLBACK_RE.test(modelContext);
  const fromModel = firstStringFieldFromSources(sources, [
    "from_model",
    "fromModel",
    "previous_model",
    "previousModel",
    "original_model",
    "originalModel",
    "requested_model",
    "requestedModel",
    "source_model",
    "sourceModel",
  ]);
  const toModel =
    firstStringFieldFromSources(sources, [
      "to_model",
      "toModel",
      "fallback_model",
      "fallbackModel",
      "new_model",
      "newModel",
      "current_model",
      "currentModel",
      "actual_model",
      "actualModel",
      "selected_model",
      "selectedModel",
    ]) ??
    (hasFallbackMarker ? firstStringFieldFromSources(sources, ["model"]) : null);

  if (!hasFallbackMarker && !(fromModel && toModel && fromModel !== toModel)) {
    return null;
  }
  if (!fromModel && !toModel) {
    return null;
  }

  const reason = firstStringFieldFromSources(sources, ["reason", "message", "detail", "details"]);
  return {
    fromModel,
    toModel,
    reason,
    source: firstStringFieldFromSources(sources, ["subtype", "type", "name"]) ?? "model_fallback",
    timestamp: new Date().toISOString(),
  };
}

function formatModelEventMessage(event) {
  const from = event?.fromModel ?? "unknown";
  const to = event?.toModel ?? "unknown";
  const reason = event?.reason ? ` (${event.reason})` : "";
  return `Claude model fallback: ${from} -> ${to}${reason}`;
}

function canonicalModelForComparison(model) {
  const normalized = String(model ?? "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const withoutContextSuffix = normalized.replace(/\[[^\]]+\]$/u, "");
  const withoutDateSuffix = withoutContextSuffix.replace(/-\d{8}$/u, "");
  const resolved = MODEL_ALIASES.get(withoutDateSuffix) ?? withoutDateSuffix;
  return resolved.replace(/\[[^\]]+\]$/u, "");
}

export function areModelIdsEquivalent(left, right) {
  const a = canonicalModelForComparison(left);
  const b = canonicalModelForComparison(right);
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  if (!a.startsWith("claude-") && (b === `claude-${a}` || b.startsWith(`claude-${a}-`))) {
    return true;
  }
  if (!b.startsWith("claude-") && (a === `claude-${b}` || a.startsWith(`claude-${b}-`))) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Availability & Auth
// ---------------------------------------------------------------------------

export function getClaudeAvailability(cwd) {
  try {
    const result = spawnSync(CLAUDE_BIN, ["--version"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status !== 0) throw new Error("non-zero exit");
    return { available: true, detail: (result.stdout ?? "").trim() };
  } catch {
    return { available: false, detail: "claude CLI not found in PATH" };
  }
}

export function getClaudeAuthStatus(cwd) {
  if (process.env.ANTHROPIC_API_KEY) {
    return { available: true, loggedIn: true, detail: "API key configured" };
  }
  try {
    const result = spawnSync(CLAUDE_BIN, ["auth", "status"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status !== 0) throw new Error("not authenticated");
    return { available: true, loggedIn: true, detail: "authenticated" };
  } catch {
    return {
      available: true,
      loggedIn: false,
      detail: "not authenticated — run `claude auth login`",
    };
  }
}

// ---------------------------------------------------------------------------
// Stream Parser — fail-safe with chunk-boundary buffering
// ---------------------------------------------------------------------------

export class StreamParser {
  constructor() {
    this.buffer = "";
    this.state = {
      sessionId: null,
      finalMessage: "",
      structuredOutput: null,
      receivedTerminalEvent: false,
      unknownEvents: [],
      parseErrors: [],
      unresolvedParseErrors: 0,
      toolUses: [],
      touchedFiles: [],
      modelEvents: [],
      finalModel: null,
    };
  }

  /** Feed a raw stdout chunk. Returns parsed events. */
  feed(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop(); // keep incomplete trailing line
    return lines.map((l) => this._parseLine(l)).filter(Boolean);
  }

  /** Flush remaining buffer at stream end. */
  flush() {
    if (this.buffer.trim()) {
      const result = this._parseLine(this.buffer);
      this.buffer = "";
      return result ? [result] : [];
    }
    return [];
  }

  _parseLine(line) {
    if (!line.trim()) return null;
    try {
      const event = JSON.parse(line);
      // Extract session_id from any event
      if (event.session_id && !this.state.sessionId) {
        this.state.sessionId = event.session_id;
      }
      const modelEvent = compactModelEvent(event);
      if (modelEvent) {
        this.state.finalModel = modelEvent.toModel ?? this.state.finalModel;
        pushBoundedTail(
          this.state.modelEvents,
          modelEvent,
          MAX_STREAM_PARSER_MODEL_EVENTS
        );
        return {
          kind: "model_fallback",
          modelFallback: modelEvent,
          data: event,
          message: formatModelEventMessage(modelEvent),
          phase: "model_fallback",
          threadId: this.state.sessionId,
        };
      }
      this.state.finalModel = extractObservedModel(event) ?? this.state.finalModel;
      switch (event.type) {
        case "stream_event":
          return this._handleStreamEvent(event);
        case "system":
          return this._handleSystemEvent(event);
        case "result":
          this.state.receivedTerminalEvent = true;
          if (event.result) {
            this.state.finalMessage = mergeTerminalResultText(
              this.state.finalMessage,
              event.result
            );
          }
          if (Object.prototype.hasOwnProperty.call(event, "structured_output")) {
            this.state.structuredOutput = event.structured_output ?? null;
          }
          if (event.session_id) this.state.sessionId = event.session_id;
          this.state.finalModel = extractObservedModel(event) ?? this.state.finalModel;
          return { kind: "result", data: event };
        default:
          pushBoundedTail(this.state.unknownEvents, {
            type: event.type,
            ts: Date.now(),
          }, MAX_STREAM_PARSER_UNKNOWN_EVENTS);
          return null;
      }
    } catch (err) {
      this.state.unresolvedParseErrors++;
      pushBoundedTail(this.state.parseErrors, {
        line: line.slice(0, 200),
        error: err.message,
      }, MAX_STREAM_PARSER_PARSE_ERRORS);
      return null;
    }
  }

  _handleStreamEvent(event) {
    const inner = event.event;
    const delta = inner?.delta;
    if (delta?.type === "text_delta" && delta.text) {
      this.state.finalMessage += delta.text;
      return {
        kind: "text",
        text: delta.text,
        message: delta.text,
        phase: "running",
        threadId: this.state.sessionId,
      };
    }

    if (inner?.type === "content_block_delta") {
      const blockDelta = inner.delta;
      if (blockDelta?.type === "text_delta" && blockDelta.text) {
        this.state.finalMessage += blockDelta.text;
        return {
          kind: "text",
          text: blockDelta.text,
          message: blockDelta.text,
          phase: "running",
          threadId: this.state.sessionId,
        };
      }
      if (blockDelta?.type === "thinking_delta" && blockDelta.thinking) {
        return {
          kind: "thinking",
          message: blockDelta.thinking,
          phase: "thinking",
          threadId: this.state.sessionId,
        };
      }
    }

    // Tool use events
    if (inner?.type === "content_block_start") {
      const cb = inner.content_block;
      if (cb?.type === "tool_use") {
        pushBoundedTail(
          this.state.toolUses,
          { tool: cb.name, input: cb.input },
          MAX_STREAM_PARSER_TOOL_USES
        );
        if (cb.name === "Write" || cb.name === "Edit") {
          pushUniqueBoundedTail(
            this.state.touchedFiles,
            cb.input?.file_path ?? cb.input?.path ?? null,
            MAX_STREAM_PARSER_TOUCHED_FILES
          );
        }
        return {
          kind: "tool_use",
          tool: cb.name,
          input: cb.input,
          message: `Using tool: ${cb.name}`,
          phase: "tool",
          threadId: this.state.sessionId,
        };
      }
    }
    return null;
  }

  _handleSystemEvent(event) {
    if (event.subtype === "api_retry") {
      return {
        kind: "system",
        subtype: "api_retry",
        data: event,
        message: "API retry in progress",
        phase: "retry",
        threadId: this.state.sessionId,
      };
    }
    return null;
  }
}

function mergeTerminalResultText(existingText, terminalText) {
  const existing = typeof existingText === "string" ? existingText : "";
  const terminal = typeof terminalText === "string" ? terminalText : "";

  if (!terminal) {
    // Structured-output and tool-only turns can finish with an empty text result.
    return existing;
  }
  if (!existing) {
    return terminal;
  }

  // We observed one real failure mode where the terminal payload only contained
  // a truncated tail of the streamed answer. Preserve the longer streamed copy
  // only for that strict suffix case; otherwise the terminal result is the
  // authoritative final answer according to the streaming contract.
  if (existing.endsWith(terminal) && existing.length > terminal.length) {
    return existing;
  }

  return terminal;
}

// ---------------------------------------------------------------------------
// Turn Completion Validation
// ---------------------------------------------------------------------------

export function validateTurnCompletion(state, exitCode) {
  if (exitCode !== 0) {
    return { status: "failed", exitCode };
  }
  if (state.unresolvedParseErrors > 0) {
    return {
      status: "unknown",
      warning: `${state.unresolvedParseErrors} unrecovered parse errors`,
    };
  }
  if (!state.receivedTerminalEvent) {
    return {
      status: "unknown",
      warning: "No terminal result event received despite exit code 0",
    };
  }
  if (state.unknownEvents.length > 0) {
    // Log but don't fail — protocol drift detection
  }
  return { status: "completed" };
}

// ---------------------------------------------------------------------------
// Sandbox Tool Sets — approximate Codex sandbox modes via allowedTools.
// Codex enforces sandbox at OS level (seatbelt/landlock); Claude Code lacks
// OS-level sandboxing, so we restrict the tool whitelist instead.
// ---------------------------------------------------------------------------

export const SANDBOX_READ_ONLY_BASH_TOOLS = [
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git blame:*)",
  "Bash(git rev-parse:*)",
  "Bash(git branch:*)",
  "Bash(git ls-files:*)",
  "Bash(git merge-base:*)",
  "Bash(git describe:*)",
  "Bash(git shortlog:*)",
  "Bash(git cat-file:*)",
  "Bash(git tag --list:*)",
  "Bash(git stash list:*)",
  "Bash(git config --get:*)",
];

export const SANDBOX_STOP_REVIEW_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git show:*)",
];

/** read-only: file reading + read-only git + web + read-only agents. No writes, MCP, or skills. */
export const SANDBOX_READ_ONLY_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  ...SANDBOX_READ_ONLY_BASH_TOOLS,
  "WebSearch",
  "WebFetch",
  "Agent(explore,plan)",
];

/**
 * MCP server name used for the bundled read-only git MCP server. Exposes tools as
 * `mcp__<SERVER_NAME>__<toolName>` (see scripts/lib/mcp-git.mjs for the catalog).
 */
export const REVIEW_MCP_SERVER_NAME = "gitReview";

export const REVIEW_MCP_TOOL_NAMES = [
  "diff",
  "log",
  "show",
  "blame",
  "status",
  "grep",
  "ls_files",
];

export const REVIEW_MCP_ALLOWED_TOOLS = REVIEW_MCP_TOOL_NAMES.map(
  (name) => `mcp__${REVIEW_MCP_SERVER_NAME}__${name}`
);

/**
 * Tools exposed to review/adversarial-review runs. Bash is intentionally absent —
 * the Claude CLI does not strictly enforce `Bash(<pattern>:*)` sub-patterns, so any
 * Bash entry would open the full Bash surface. Git operations are surfaced through
 * the bundled read-only git MCP server instead (`REVIEW_MCP_ALLOWED_TOOLS`).
 */
export const SANDBOX_REVIEW_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  ...REVIEW_MCP_ALLOWED_TOOLS,
];

// ---------------------------------------------------------------------------
// Sandbox Settings — OS-level isolation via Claude Code's sandbox feature.
// Written to a temp file and passed via --settings.
// ---------------------------------------------------------------------------

/**
 * Sandbox presets matching Codex sandbox modes.
 *
 * read-only:       no file writes outside the OS temp dir. Network is allowed so
 *                  that `WebFetch`, `WebSearch`, and the Claude CLI's API path keep
 *                  working; the review allowlist excludes Bash entirely, so there
 *                  is no shell surface to exfiltrate or mutate state through.
 * workspace-write: Bash can write to cwd + OS temp dir only, no network from Bash.
 *                  All tools allowed (no allowedTools restriction).
 */
export const SANDBOX_SETTINGS = {
  "read-only": {
    sandbox: {
      enabled: true,
      // No Bash in the review allowlist, but keep this flag conservative so that
      // any sandbox-aware tool still has to opt in explicitly.
      autoAllowBashIfSandboxed: false,
      filesystem: {
        allowWrite: [SANDBOX_TEMP_DIR],
      },
    },
  },
  "workspace-write": {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        allowWrite: [".", SANDBOX_TEMP_DIR],
      },
      network: {
        allowedDomains: [],
      },
    },
  },
};

/**
 * Write sandbox settings to a temp file. Returns the file path.
 * Caller is responsible for cleanup via cleanupSandboxSettings().
 */
export function createSandboxSettings(mode) {
  const settings = SANDBOX_SETTINGS[mode];
  if (!settings) return null;

  const sandboxDir = path.join(resolvePluginRuntimeRoot(), "sandbox");
  fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
  const tmpFile = path.join(
    sandboxDir,
    `cc-sandbox-${process.pid}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}.json`
  );
  fs.writeFileSync(tmpFile, JSON.stringify(settings), {
    encoding: "utf8",
    mode: 0o600,
  });
  return tmpFile;
}

export function cleanupSandboxSettings(filePath) {
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Review MCP config
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path of the bundled claude-companion.mjs script so the
 * `mcp-git` subcommand can be invoked from any cwd. Uses `fileURLToPath` so the
 * resolution works on Windows where `new URL(...).pathname` is not a usable
 * filesystem path.
 */
function resolveCompanionScriptPath() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "claude-companion.mjs"
  );
}

/**
 * Write an `--mcp-config` JSON file that registers the bundled read-only git
 * MCP server. The server's CC_GIT_ROOT env var is set to `gitRoot` so that its
 * tool handlers operate strictly inside the review worktree.
 */
export function createReviewMcpConfig(gitRoot, options = {}) {
  if (!gitRoot || typeof gitRoot !== "string") {
    throw new Error("createReviewMcpConfig: gitRoot is required");
  }
  const companionScript = resolveCompanionScriptPath();
  const config = {
    mcpServers: {
      [REVIEW_MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [companionScript, "mcp-git"],
        env: {
          CC_GIT_ROOT: gitRoot,
        },
      },
      ...(options.extraMcpServers ?? {}),
    },
  };

  const dir = path.join(resolvePluginRuntimeRoot(), "mcp");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpFile = path.join(
    dir,
    `cc-mcp-${process.pid}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}.json`
  );
  fs.writeFileSync(tmpFile, JSON.stringify(config), {
    encoding: "utf8",
    mode: 0o600,
  });
  return tmpFile;
}

export function cleanupReviewMcpConfig(filePath) {
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Stale tmp sweepers — reclaim files left behind by SIGKILL/crashes.
// ---------------------------------------------------------------------------

function pruneStaleTempFiles(subdir, options = {}) {
  const prefix = options.prefix;
  const maxAgeMs = options.maxAgeMs ?? 6 * 60 * 60 * 1000;
  const dir = path.join(resolvePluginRuntimeRoot(), subdir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (prefix && !entry.name.startsWith(prefix)) continue;
    const full = path.join(dir, entry.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs < maxAgeMs) continue;
    try {
      fs.unlinkSync(full);
    } catch {
      // Best effort: leave on disk rather than crash callers.
    }
  }
}

/**
 * Sweep sandbox-settings JSON files left behind by crashes. Call this at the
 * start of any flow that creates sandbox settings so they do not accumulate.
 */
export function pruneStaleSandboxSettings(options = {}) {
  pruneStaleTempFiles("sandbox", { prefix: "cc-sandbox-", ...options });
}

/**
 * Sweep review MCP config JSON files left behind by crashes. The same SIGKILL
 * window that strands a worktree can strand the MCP config; clean both.
 */
export function pruneStaleReviewMcpConfigs(options = {}) {
  pruneStaleTempFiles("mcp", { prefix: "cc-mcp-", ...options });
}

// ---------------------------------------------------------------------------
// Model & Effort Mapping
// ---------------------------------------------------------------------------

export const MODEL_ALIASES = new Map([
  ["opus", "claude-opus-4-8"],
  ["sonnet", "claude-sonnet-5"],
  ["haiku", "claude-haiku-4-5"],
  ["fable", "claude-fable-5[1m]"],
]);

export const EFFORT_ALIASES = {
  none: "low",
  minimal: "low",
};

export const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export const DEFAULT_MODEL = "opus";

export const DEFAULT_EFFORT_BY_MODEL = new Map([
  ["opus", "xhigh"],
  ["claude-opus-4-8", "xhigh"],
  ["sonnet", "high"],
  ["claude-sonnet-5", "high"],
]);

export function resolveDefaultModel(model) {
  if (model == null || String(model).trim() === "") {
    return DEFAULT_MODEL;
  }
  return model;
}

export function resolveDefaultEffort(model, effort) {
  if (effort != null && String(effort).trim() !== "") {
    return effort;
  }
  const key = String(model ?? "").trim().toLowerCase();
  return DEFAULT_EFFORT_BY_MODEL.get(key);
}

export function resolveModel(model) {
  if (!model) return undefined;
  return MODEL_ALIASES.get(model) ?? model;
}

export function resolveEffort(effort) {
  if (!effort) return undefined;
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) return undefined;
  const resolved = EFFORT_ALIASES[normalized] ?? normalized;
  if (VALID_EFFORTS.has(resolved)) {
    return resolved;
  }
  throw new Error(
    `Unsupported effort "${effort}". Use one of: ${[...VALID_EFFORTS].join(", ")}.`
  );
}

// ---------------------------------------------------------------------------
// Core Execution
// ---------------------------------------------------------------------------

/**
 * Build CLI argument array for `claude -p`.
 */
/** @visibleForTesting */
export function buildArgs(prompt, options = {}) {
  const args = ["-p"];
  // No --bare: it breaks OAuth auth. Isolation is achieved via --allowedTools.

  if (options.outputFormat === "stream-json") {
    args.push(
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages"
    );
  } else {
    args.push("--output-format", options.outputFormat ?? "json");
  }

  if (options.noSessionPersistence) {
    args.push("--no-session-persistence");
  }
  if (options.model) {
    args.push("--model", resolveModel(options.model));
  }
  if (options.effort) {
    args.push("--effort", resolveEffort(options.effort));
  }
  if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }
  if (options.allowedTools) {
    for (const tool of options.allowedTools) {
      args.push("--allowedTools", tool);
    }
  }
  if (options.maxTurns) {
    args.push("--max-turns", String(options.maxTurns));
  }
  if (options.jsonSchema) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }
  if (options.systemPrompt) {
    args.push("--system-prompt", options.systemPrompt);
  }
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.settingsFile) {
    args.push("--settings", options.settingsFile);
  }
  if (options.mcpConfigFile) {
    args.push("--mcp-config", options.mcpConfigFile);
  }
  if (options.strictMcpConfig) {
    args.push("--strict-mcp-config");
  }

  args.push("--", prompt);
  return args;
}

/**
 * Execute a Claude Code turn with streaming progress.
 * Returns { status, sessionId, finalMessage, toolUses, touchedFiles, stderr, pid, pidIdentity }
 */
export async function runClaudeTurn(cwd, prompt, options = {}) {
  const args = buildArgs(prompt, {
    outputFormat: "stream-json",
    ...options,
  });
  const requestedModel = options.model ? resolveModel(options.model) : null;

  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      detached: true, // new process group for safe cancellation
      stdio: ["ignore", "pipe", "pipe"], // stdin ignored — prompt is passed as CLI arg
    });

    let pidIdentity = null;
    try {
      pidIdentity = getProcessIdentity(proc.pid);
    } catch {
      // Best-effort — may fail on some platforms
    }

    // Notify caller of child PID at spawn time (before execution completes)
    if (options.onSpawn) {
      options.onSpawn({ pid: proc.pid, pidIdentity });
    }

    const parser = new StreamParser();
    let stderr = "";

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      stderr = appendTextTail(stderr, chunk, MAX_STDERR_BYTES);
    });

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      const events = parser.feed(chunk);
      for (const evt of events) {
        if (options.onProgress) {
          options.onProgress(evt);
        }
      }
    });

    proc.on("close", (code) => {
      // Flush remaining buffer
      const remaining = parser.flush();
      for (const evt of remaining) {
        if (options.onProgress) options.onProgress(evt);
      }

      const validation = validateTurnCompletion(parser.state, code ?? 1);
      const modelEvents = [...parser.state.modelEvents];
      const finalModel = parser.state.finalModel;
      const failure =
        validation.status === "completed"
          ? null
          : classifyClaudeFailure({
              finalMessage: parser.state.finalMessage,
              stderr,
            });
      if (
        requestedModel &&
        finalModel &&
        !areModelIdsEquivalent(finalModel, requestedModel) &&
        !modelEvents.some(
          (event) =>
            areModelIdsEquivalent(event.fromModel, requestedModel) &&
            areModelIdsEquivalent(event.toModel, finalModel)
        )
      ) {
        modelEvents.push({
          fromModel: requestedModel,
          toModel: finalModel,
          reason: "Claude reported a different terminal model.",
          source: "terminal_result",
          timestamp: new Date().toISOString(),
        });
      }
      resolve({
        status: validation.status,
        warning: validation.warning,
        exitCode: code,
        sessionId: parser.state.sessionId,
        finalMessage: parser.state.finalMessage,
        structuredOutput: parser.state.structuredOutput,
        toolUses: parser.state.toolUses,
        touchedFiles: parser.state.touchedFiles,
        requestedModel,
        finalModel,
        modelEvents,
        failure,
        stderr,
        pid: proc.pid,
        pidIdentity,
      });
    });

    proc.on("error", (err) => {
      resolve({
        status: "failed",
        exitCode: -1,
        sessionId: null,
        finalMessage: "",
        structuredOutput: null,
        toolUses: [],
        touchedFiles: [],
        requestedModel,
        finalModel: null,
        modelEvents: [],
        failure: classifyClaudeFailure({ stderr: err.message }),
        stderr: err.message,
        pid: proc.pid,
        pidIdentity,
      });
    });

    // Unref only for background workers — foreground callers need the process to keep Node alive
    if (options.background) {
      proc.unref();
    }
  });
}

/**
 * Execute a review (non-streaming, no session persistence).
 *
 * The default allowlist is `SANDBOX_REVIEW_TOOLS` (Read/Glob/Grep/Web + the git
 * MCP tool surface). Callers that want to run with an alternative allowlist —
 * e.g., legacy `SANDBOX_READ_ONLY_TOOLS` for back-compat — can override via
 * `options.allowedTools`. Bash is intentionally excluded by default.
 */
export async function runClaudeReview(cwd, prompt, options = {}) {
  // Use streaming mode (same as runClaudeTurn) for progress reporting
  const result = await runClaudeTurn(cwd, prompt, {
    noSessionPersistence: true,
    allowedTools: SANDBOX_REVIEW_TOOLS,
    ...options,
  });

  return {
    status: result.status,
    exitCode: result.exitCode,
    warning: result.warning,
    result: result.finalMessage,
    structuredOutput: result.structuredOutput ?? null,
    sessionId: result.sessionId,
    requestedModel: result.requestedModel,
    finalModel: result.finalModel,
    modelEvents: result.modelEvents,
    failure: result.failure,
    stderr: result.stderr,
    pid: result.pid,
    pidIdentity: result.pidIdentity,
  };
}

/**
 * Execute an adversarial review with JSON schema output.
 */
export async function runClaudeAdversarialReview(
  cwd,
  prompt,
  schema,
  options = {}
) {
  return runClaudeReview(cwd, prompt, {
    jsonSchema: schema,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Cancellation — process-group based, identity-verified
// ---------------------------------------------------------------------------

/**
 * Cancel a running Claude Code process.
 * Uses process group kill with PID identity verification.
 */
export async function cancelClaudeProcess(pid, pidIdentity) {
  // Verify PID identity to prevent killing recycled PIDs
  if (pidIdentity && !validateProcessIdentity(pid, pidIdentity)) {
    return {
      cancelled: true,
      note: "Process already exited (PID recycled)",
    };
  }

  // SIGTERM to entire process group
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return { cancelled: true, note: "Process not found" };
  }

  // Wait for process group to die
  const dead = await waitForProcessGroup(pid, 5000);
  if (dead) {
    return { cancelled: true };
  }

  // Escalate to SIGKILL
  if (pidIdentity && !validateProcessIdentity(pid, pidIdentity)) {
    return {
      cancelled: true,
      note: "Process exited during SIGTERM wait",
    };
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {}

  const killedDead = await waitForProcessGroup(pid, 3000);
  if (killedDead) {
    return { cancelled: true };
  }

  return {
    cancelled: false,
    note: `Process group ${pid} still alive after SIGKILL`,
  };
}

function isProcessGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroup(pgid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessGroupAlive(pgid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isProcessGroupAlive(pgid);
}
