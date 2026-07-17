/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Read-only git MCP server over stdio.
 *
 * Exposes a small surface of git read-only operations as structured MCP tools so
 * that review and adversarial-review runs can inspect commits, diffs, and history
 * without exposing the Bash tool. Tool calls land here, argv is constructed inside
 * the server (no shell), and the working directory is locked to CC_GIT_ROOT.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "cc-plugin-codex-git";
export const MCP_SERVER_VERSION = "1.0.0";
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_STDIN_BUFFER_BYTES = 1 * 1024 * 1024;

// Refs may contain letters, digits, and the small set of characters git uses for
// range/relative syntax. We deliberately reject shell metacharacters and spaces
// even though spawnSync does not invoke a shell — keeping the surface narrow makes
// the invariant easy to audit.
const REF_PATTERN = /^[A-Za-z0-9._/\-~^@]{1,200}(?:\.\.\.?[A-Za-z0-9._/\-~^@]{1,200})?$/;

// Pathspecs ride directly to git after the `--` separator so they cannot become
// flags, but we still gate them: no shell metacharacters, no NUL, no leading `-`,
// no parent traversal, and (when absolute) the resolved location must stay inside
// CC_GIT_ROOT.
const PATHSPEC_FORBIDDEN = /[\0\n\r;&|`$<>*?(){}\[\]"'\\]/;

const LIMIT_DEFAULTS = {
  log: 20,
  blame: 0,
  grep: 200,
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensureValidRef(ref, label = "ref") {
  if (typeof ref !== "string" || !ref) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (!REF_PATTERN.test(ref)) {
    throw new Error(`${label} contains characters that are not allowed`);
  }
  // A leading `-` would be interpreted by git as an option (e.g., `-p`,
  // `--ext-diff`) rather than a ref. Reject explicitly even though `--` follows
  // ref tokens elsewhere, since refs are emitted *before* the `--` separator.
  if (ref.startsWith("-")) {
    throw new Error(`${label} may not start with '-' (interpreted as flag): ${ref}`);
  }
  return ref;
}

function ensureValidPath(spec, root) {
  if (typeof spec !== "string" || !spec) {
    throw new Error("path must be a non-empty string");
  }
  if (PATHSPEC_FORBIDDEN.test(spec)) {
    throw new Error(`path contains forbidden characters: ${spec}`);
  }
  if (spec.startsWith("-")) {
    throw new Error(`path may not start with '-' (interpreted as flag): ${spec}`);
  }
  const resolved = path.resolve(root, spec);
  const rootResolved = path.resolve(root);
  const rel = path.relative(rootResolved, resolved);
  if (rel === "" || rel === ".") {
    return spec;
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes the git root: ${spec}`);
  }
  return spec;
}

function ensureValidPathList(paths, root) {
  if (paths == null) return [];
  if (!Array.isArray(paths)) {
    throw new Error("paths must be an array of strings");
  }
  if (paths.length > 64) {
    throw new Error("too many paths (max 64)");
  }
  return paths.map((p) => ensureValidPath(p, root));
}

function ensureBoundedInt(value, { min, max, label }) {
  if (value == null) return null;
  const num = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new Error(`${label} must be an integer`);
  }
  if (num < min || num > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return num;
}

function ensureValidBlameRange(range) {
  if (range == null) return null;
  if (typeof range !== "string") {
    throw new Error("range must be a string like '12,40'");
  }
  if (!/^\d{1,7}(?:,\d{1,7})?$/.test(range)) {
    throw new Error("range must look like '12' or '12,40'");
  }
  return range;
}

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    env: {
      ...process.env,
      // Disable git config that could side-effect (no signing, no pagers, no
      // hooks running through git commands we wrap). Use POSIX `:` and `cat`
      // builtins that work the same on Linux, macOS, and git-for-Windows.
      GIT_PAGER: "cat",
      GIT_EDITOR: ":",
      GIT_TERMINAL_PROMPT: "0",
    },
    timeout: 30_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS = [
  {
    name: "diff",
    description:
      "Show a git diff inside the review worktree. Optional `refs` (e.g., 'HEAD~3..HEAD' or 'origin/main...HEAD') and optional `paths`. Use `stat: true` for a stat-only summary.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        refs: { type: "string", description: "Git ref or ref range." },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Pathspecs relative to the review worktree.",
        },
        stat: { type: "boolean", description: "Return --stat summary instead of full diff." },
        head: {
          type: "integer",
          minimum: 1,
          maximum: 5000,
          description: "Truncate output to the first N lines.",
        },
      },
    },
  },
  {
    name: "log",
    description:
      "List recent commits. Optional `refs`, `paths`, `limit` (default 20), `format` ('oneline' | 'short' | 'full').",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        refs: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        format: { type: "string", enum: ["oneline", "short", "medium", "full"] },
      },
    },
  },
  {
    name: "show",
    description: "Show a single commit (`ref` required). Optional `paths` to restrict to specific files. Optional `stat: true` for stat-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ref"],
      properties: {
        ref: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        stat: { type: "boolean" },
      },
    },
  },
  {
    name: "blame",
    description: "Show line-by-line authorship of a file. `path` required. Optional `range` ('12,40').",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string" },
        range: { type: "string", description: "Line range like '12,40' or '12'." },
      },
    },
  },
  {
    name: "status",
    description: "Show working-tree status. Use `porcelain: true` for machine-readable output.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        porcelain: { type: "boolean" },
      },
    },
  },
  {
    name: "grep",
    description: "Search the tracked tree with `git grep`. `pattern` required. Optional `paths`, `limit` (default 200 lines).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: 5000 },
        ignoreCase: { type: "boolean" },
        word: { type: "boolean", description: "Match whole words only." },
      },
    },
  },
  {
    name: "ls_files",
    description: "List tracked files. Optional `paths` to filter.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        paths: { type: "array", items: { type: "string" } },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function truncateOutput(text, maxLines) {
  if (!maxLines || maxLines <= 0) return text;
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [
    ...lines.slice(0, maxLines),
    `... (truncated; ${lines.length - maxLines} more line(s))`,
  ].join("\n");
}

function formatResult(result, options = {}) {
  const { truncateLines, label } = options;
  let text = result.stdout || "";
  if (truncateLines && text) {
    text = truncateOutput(text, truncateLines);
  }
  if (!text && result.stderr) {
    text = `[git ${label ?? "command"} stderr]\n${result.stderr}`;
  }
  if (result.error) {
    text = `${text}\n[error: ${result.error}]`.trim();
  }
  const isError =
    Boolean(result.error) ||
    (result.exitCode != null && result.exitCode !== 0 && !result.stdout);
  return { text, isError };
}

const HANDLERS = {
  diff(args, root) {
    const cmd = ["diff", "--no-color"];
    if (args?.stat === true) cmd.push("--stat");
    if (args?.refs != null) cmd.push(ensureValidRef(args.refs, "refs"));
    const paths = ensureValidPathList(args?.paths, root);
    if (paths.length > 0) cmd.push("--", ...paths);
    const result = runGit(root, cmd);
    const headLimit = ensureBoundedInt(args?.head, { min: 1, max: 5000, label: "head" });
    return formatResult(result, { truncateLines: headLimit, label: "diff" });
  },

  log(args, root) {
    const cmd = ["log", "--no-color"];
    const limit = ensureBoundedInt(args?.limit, { min: 1, max: 500, label: "limit" }) ?? LIMIT_DEFAULTS.log;
    cmd.push(`-n`, String(limit));
    const format = args?.format;
    if (format === "oneline" || format == null) {
      cmd.push("--oneline");
    } else if (format === "short" || format === "medium" || format === "full") {
      cmd.push(`--pretty=${format}`);
    } else {
      throw new Error(`format must be one of: oneline, short, medium, full`);
    }
    if (args?.refs != null) cmd.push(ensureValidRef(args.refs, "refs"));
    const paths = ensureValidPathList(args?.paths, root);
    if (paths.length > 0) cmd.push("--", ...paths);
    return formatResult(runGit(root, cmd), { label: "log" });
  },

  show(args, root) {
    const cmd = ["show", "--no-color"];
    if (args?.stat === true) cmd.push("--stat");
    cmd.push(ensureValidRef(args?.ref, "ref"));
    const paths = ensureValidPathList(args?.paths, root);
    if (paths.length > 0) cmd.push("--", ...paths);
    return formatResult(runGit(root, cmd), { label: "show" });
  },

  blame(args, root) {
    // `git blame` does not accept `--no-color`; pass color config via -c instead.
    const cmd = ["-c", "color.ui=false", "blame"];
    const range = ensureValidBlameRange(args?.range);
    if (range) cmd.push("-L", range);
    cmd.push(ensureValidPath(args?.path, root));
    return formatResult(runGit(root, cmd), { label: "blame" });
  },

  status(args, root) {
    const cmd = ["status"];
    if (args?.porcelain === true) cmd.push("--porcelain");
    return formatResult(runGit(root, cmd), { label: "status" });
  },

  grep(args, root) {
    const cmd = ["grep", "-n", "--no-color"];
    if (args?.ignoreCase === true) cmd.push("-i");
    if (args?.word === true) cmd.push("-w");
    const pattern = args?.pattern;
    if (typeof pattern !== "string" || !pattern) {
      throw new Error("pattern must be a non-empty string");
    }
    if (pattern.length > 1024) {
      throw new Error("pattern too long (max 1024 chars)");
    }
    if (/[\0\n\r]/.test(pattern)) {
      throw new Error("pattern contains NUL/newline characters");
    }
    cmd.push("-e", pattern);
    const paths = ensureValidPathList(args?.paths, root);
    if (paths.length > 0) cmd.push("--", ...paths);
    const limit = ensureBoundedInt(args?.limit, { min: 1, max: 5000, label: "limit" }) ?? LIMIT_DEFAULTS.grep;
    return formatResult(runGit(root, cmd), { truncateLines: limit, label: "grep" });
  },

  ls_files(args, root) {
    const cmd = ["ls-files"];
    const paths = ensureValidPathList(args?.paths, root);
    if (paths.length > 0) cmd.push("--", ...paths);
    return formatResult(runGit(root, cmd), { label: "ls-files" });
  },
};

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

export function handleMcpRequest(request, root) {
  if (!isPlainObject(request)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    };
  }
  const { method, id, params } = request;
  const respondError = (code, message) => ({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: MCP_SERVER_NAME,
          version: MCP_SERVER_VERSION,
        },
      },
    };
  }

  if (method === "initialized" || method === "notifications/initialized") {
    return null;
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: TOOL_DEFINITIONS },
    };
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const handler = HANDLERS[name];
    if (!handler) {
      return respondError(-32601, `Unknown tool: ${name}`);
    }
    try {
      const { text, isError } = handler(args, root);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: text || "(empty)" }],
          isError: Boolean(isError),
        },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        },
      };
    }
  }

  return respondError(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// Server entrypoint
// ---------------------------------------------------------------------------

export async function runMcpGitServer({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const rawRoot = env.CC_GIT_ROOT;
  if (!rawRoot) {
    stderr.write("[mcp-git] CC_GIT_ROOT env var is required\n");
    return 2;
  }
  const root = path.resolve(rawRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    stderr.write(`[mcp-git] CC_GIT_ROOT not found or not a directory: ${root}\n`);
    return 2;
  }

  let buffer = "";
  stdin.setEncoding("utf8");

  const writeResponse = (response) => {
    if (response == null) return;
    stdout.write(`${JSON.stringify(response)}\n`);
  };

  return await new Promise((resolve) => {
    stdin.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_STDIN_BUFFER_BYTES) {
        // A well-behaved MCP client sends newline-delimited JSON. If we have grown
        // past the cap without a newline, drop the oversized prefix so memory is
        // bounded — subsequent data may still contain valid frames.
        const lastNewline = buffer.lastIndexOf("\n");
        if (lastNewline === -1) {
          buffer = buffer.slice(-MAX_STDIN_BUFFER_BYTES);
        } else {
          buffer = buffer.slice(lastNewline + 1);
        }
      }
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          writeResponse({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          });
          continue;
        }
        const response = handleMcpRequest(request, root);
        if (!response) {
          continue;
        }
        // Error responses (including -32600 for non-object payloads) must always
        // be emitted, even when the request has no `id`; otherwise the caller has
        // no signal that the framing was wrong. Result responses only flow back
        // when the request had an id (i.e., was a request, not a notification).
        const hasRequestId =
          isPlainObject(request) &&
          request.id !== undefined &&
          request.id !== null;
        if (response.error || hasRequestId) {
          writeResponse(response);
        }
      }
    });

    stdin.on("end", () => {
      resolve(0);
    });
  });
}
