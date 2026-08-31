/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Grok CLI wrapper for Codex `$cc:* --guest grok`.
 * Spawns `grok --prompt-file` with `--output-format json`.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePluginRuntimeRoot } from "./codex-paths.mjs";
import { getSpawnedProcessIdentity } from "./process.mjs";

const GROK_BIN = "grok";
export const MAX_STDERR_BYTES = 64 * 1024;

export const GROK_REVIEW_TOOLS = Object.freeze([
  "read_file",
  "grep",
  "list_dir",
  "web_search",
  "web_fetch",
]);

export const GROK_READ_ONLY_TOOLS = GROK_REVIEW_TOOLS;

export const GROK_VALID_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const GROK_AUTH_RE =
  /\bnot (?:logged|signed) in\b|\bnot authenticated\b|\bgrok login\b|\binvalid api key\b/i;
const GROK_LIMIT_RE = /\brate[_ -]?limit\b|\b429\b|\busage limit\b/i;

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
  return sliceTextTailByBytes(`${existing ?? ""}${chunk ?? ""}`, maxBytes);
}

export function resolveGrokCommand(platform = process.platform, env = process.env) {
  if (platform !== "win32") {
    return { executable: GROK_BIN, prefixArgs: [] };
  }

  const searchPath = env.PATH ?? env.Path ?? "";
  for (const entry of searchPath.split(";")) {
    const directory = entry.trim().replace(/^"(.*)"$/u, "$1");
    if (!directory) {
      continue;
    }
    const nativeExecutable = path.join(directory, `${GROK_BIN}.exe`);
    try {
      if (fs.statSync(nativeExecutable).isFile()) {
        return { executable: nativeExecutable, prefixArgs: [] };
      }
    } catch {
      // Keep searching PATH.
    }
  }

  return { executable: GROK_BIN, prefixArgs: [] };
}

export function resolveGrokModel(model) {
  if (model == null) {
    return undefined;
  }
  const normalized = String(model).trim();
  return normalized ? normalized : undefined;
}

export function resolveGrokEffort(effort) {
  if (effort == null) {
    return undefined;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!GROK_VALID_EFFORTS.includes(normalized)) {
    throw new Error(
      `Unsupported effort "${effort}". Use one of: ${GROK_VALID_EFFORTS.join(", ")}.`
    );
  }
  return normalized;
}

export function getGrokAvailability(cwd) {
  try {
    const command = resolveGrokCommand();
    if (command.error) {
      return { available: false, detail: command.error };
    }
    const result = spawnSync(command.executable, [...command.prefixArgs, "--version"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error("non-zero exit");
    }
    return { available: true, detail: (result.stdout ?? "").trim() };
  } catch {
    return { available: false, detail: "grok CLI not found in PATH" };
  }
}

export function getGrokAuthStatus(cwd, env = process.env, options = {}) {
  if (env?.XAI_API_KEY || env?.GROK_API_KEY) {
    return { available: true, loggedIn: true, detail: "API key configured" };
  }
  const grokHome =
    options.grokHome ?? env?.GROK_HOME ?? path.join(os.homedir(), ".grok");
  try {
    if (fs.statSync(path.join(grokHome, "auth.json")).isFile()) {
      return { available: true, loggedIn: true, detail: "authenticated" };
    }
  } catch {
    // Fall through.
  }
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated — run `grok login`",
  };
}

export function classifyGrokFailure(value = {}) {
  const finalMessage = typeof value.finalMessage === "string" ? value.finalMessage.trim() : "";
  const stderr = typeof value.stderr === "string" ? value.stderr.trim() : "";
  const message = [finalMessage, stderr].filter(Boolean).join("\n").trim();
  if (!message) {
    return null;
  }
  if (GROK_LIMIT_RE.test(message)) {
    return { kind: "grok_rate_limit", message, resetText: null };
  }
  if (GROK_AUTH_RE.test(message) && value.exitCode !== 0) {
    return { kind: "grok_auth", message, resetText: null };
  }
  return null;
}

export function parseGrokJsonResult(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    throw new Error("Grok JSON output was empty.");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Grok JSON output was not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Grok JSON output was not an object.");
  }

  const resultText = typeof value.text === "string" ? value.text : "";
  const sessionId =
    typeof value.sessionId === "string" && value.sessionId.trim()
      ? value.sessionId.trim()
      : null;
  const modelUsage =
    value.modelUsage && typeof value.modelUsage === "object" && !Array.isArray(value.modelUsage)
      ? value.modelUsage
      : null;
  const usageKeys = modelUsage
    ? Object.keys(modelUsage).filter((key) => key.trim())
    : [];
  const finalModel = usageKeys.length === 1 ? usageKeys[0] : null;
  const usage = finalModel ? modelUsage[finalModel] : null;
  const contextWindow =
    Number.isSafeInteger(usage?.contextWindow) && usage.contextWindow > 0
      ? usage.contextWindow
      : null;

  let structuredOutput = null;
  const trimmedText = resultText.trim();
  if (
    (trimmedText.startsWith("{") && trimmedText.endsWith("}")) ||
    (trimmedText.startsWith("[") && trimmedText.endsWith("]"))
  ) {
    try {
      structuredOutput = JSON.parse(trimmedText);
    } catch {
      structuredOutput = null;
    }
  }

  return {
    text: resultText,
    sessionId,
    finalModel,
    contextWindow,
    structuredOutput,
    value,
  };
}

export function buildGrokArgs(options = {}) {
  if (!options.promptFile) {
    throw new Error("buildGrokArgs requires promptFile.");
  }
  const args = [
    "--prompt-file",
    options.promptFile,
    "--output-format",
    options.outputFormat ?? "json",
  ];
  if (options.alwaysApprove !== false) {
    args.push("--always-approve");
  }
  const model = resolveGrokModel(options.model);
  if (model) {
    args.push("--model", model);
  }
  const effort = resolveGrokEffort(options.effort);
  if (effort) {
    args.push("--effort", effort);
  }
  if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }
  if (options.tools?.length) {
    const tools = Array.isArray(options.tools) ? options.tools.join(",") : String(options.tools);
    args.push("--tools", tools);
  }
  if (options.disallowedTools?.length) {
    const tools = Array.isArray(options.disallowedTools)
      ? options.disallowedTools.join(",")
      : String(options.disallowedTools);
    args.push("--disallowed-tools", tools);
  }
  if (options.maxTurns) {
    args.push("--max-turns", String(options.maxTurns));
  }
  if (options.jsonSchema) {
    args.push(
      "--json-schema",
      typeof options.jsonSchema === "string"
        ? options.jsonSchema
        : JSON.stringify(options.jsonSchema)
    );
  }
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.cwd) {
    args.push("--cwd", options.cwd);
  }
  return args;
}

function createGrokPromptFile(prompt) {
  const dir = path.join(resolvePluginRuntimeRoot(), "prompts");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpFile = path.join(
    dir,
    `cc-grok-${process.pid}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}.txt`
  );
  fs.writeFileSync(tmpFile, String(prompt ?? ""), {
    encoding: "utf8",
    mode: 0o600,
  });
  return tmpFile;
}

function cleanupGrokPromptFile(filePath) {
  if (filePath) {
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }
}

function failedGrokResult({
  stderr,
  exitCode = -1,
  requestedModel = null,
  pid = null,
  pidIdentity = null,
}) {
  return {
    status: "failed",
    exitCode,
    sessionId: null,
    finalMessage: "",
    structuredOutput: null,
    toolUses: [],
    touchedFiles: [],
    requestedModel,
    finalModel: null,
    contextWindow: null,
    modelEvents: [],
    parseErrors: [],
    unresolvedParseErrors: 0,
    failure: classifyGrokFailure({
      stderr,
      exitCode,
    }),
    stderr,
    pid,
    pidIdentity,
  };
}

export async function runGrokTurn(cwd, prompt, options = {}) {
  const requestedModel = resolveGrokModel(options.model) ?? null;
  const command = resolveGrokCommand();
  if (command.error) {
    return failedGrokResult({ stderr: command.error, requestedModel });
  }

  const promptFile = createGrokPromptFile(prompt);
  const args = buildGrokArgs({
    ...options,
    promptFile,
  });
  const executableArgs = [...command.prefixArgs, ...args];

  try {
    return await new Promise((resolve) => {
      const proc = spawn(command.executable, executableArgs, {
        cwd,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let pidIdentity = null;
      try {
        pidIdentity = getSpawnedProcessIdentity(proc.pid);
      } catch {
        // Best-effort — may fail on some platforms
      }
      if (options.onSpawn) {
        options.onSpawn({ pid: proc.pid, pidIdentity });
      }

      let stdout = "";
      let stderr = "";
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      proc.stderr.on("data", (chunk) => {
        stderr = appendTextTail(stderr, chunk, MAX_STDERR_BYTES);
      });

      proc.on("error", (err) => {
        resolve(
          failedGrokResult({
            stderr: err.message,
            requestedModel,
            pid: proc.pid,
            pidIdentity,
          })
        );
      });

      proc.on("close", (code) => {
        let parsed = null;
        let parseError = null;
        try {
          parsed = parseGrokJsonResult(stdout);
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
        }

        if (parseError) {
          const combined = appendTextTail(
            stderr,
            stderr ? `\n${parseError}` : parseError,
            MAX_STDERR_BYTES
          );
          resolve({
            ...failedGrokResult({
              stderr: combined,
              exitCode: code ?? 1,
              requestedModel,
              pid: proc.pid,
              pidIdentity,
            }),
            parseErrors: [{ error: parseError }],
            unresolvedParseErrors: 1,
          });
          return;
        }

        const exitCode = code ?? 1;
        const status = exitCode === 0 ? "completed" : "failed";
        if (options.onProgress) {
          options.onProgress({
            kind: "result",
            data: parsed.value,
            message: parsed.text,
            threadId: parsed.sessionId,
          });
        }
        resolve({
          status,
          warning: undefined,
          exitCode,
          sessionId: parsed.sessionId,
          finalMessage: parsed.text,
          structuredOutput: parsed.structuredOutput,
          toolUses: [],
          touchedFiles: [],
          requestedModel,
          finalModel: parsed.finalModel,
          contextWindow: parsed.contextWindow,
          modelEvents: [],
          parseErrors: [],
          unresolvedParseErrors: 0,
          failure:
            status === "failed"
              ? classifyGrokFailure({
                  finalMessage: parsed.text,
                  stderr,
                  exitCode,
                })
              : null,
          stderr,
          pid: proc.pid,
          pidIdentity,
        });
      });

      if (options.background) {
        proc.unref();
      }
    });
  } finally {
    cleanupGrokPromptFile(promptFile);
  }
}

export async function runGrokReview(cwd, prompt, options = {}) {
  const result = await runGrokTurn(cwd, prompt, {
    tools: GROK_REVIEW_TOOLS,
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
    contextWindow: result.contextWindow,
    modelEvents: result.modelEvents,
    parseErrors: result.parseErrors,
    unresolvedParseErrors: result.unresolvedParseErrors,
    failure: result.failure,
    stderr: result.stderr,
    pid: result.pid,
    pidIdentity: result.pidIdentity,
  };
}
