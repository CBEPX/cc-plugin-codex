/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Derived from OpenAI's codex-plugin-cc and modified for Claude Code delegation.
 *
 * Tracked jobs — adapted from codex-plugin-cc.
 * SESSION_ID_ENV changed to CLAUDE_COMPANION_SESSION_ID.
 * Progress messages use [cc] prefix instead of [codex].
 */

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./process.mjs";
import { nowIso, ensureStateDir, getCurrentSession, patchJob, readJobFile, resolveJobLogFile, writeJobFile, cleanupOldJobs, transitionJob } from "./state.mjs";

export { nowIso };

export const SESSION_ID_ENV = "CLAUDE_COMPANION_SESSION_ID";
export const MAX_JOB_LOG_BYTES = 1024 * 1024;
export const MAX_JOB_MODEL_FALLBACK_EVENTS = 50;
const LOG_TRUNCATION_MARKER = "[... earlier log output truncated ...]\n";

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

function trimLogFile(logFile, maxBytes = MAX_JOB_LOG_BYTES) {
  if (!logFile || maxBytes <= 0) {
    return;
  }

  // stat before read: per-delta appends must not re-read the whole log.
  let size;
  try {
    size = fs.statSync(logFile).size;
  } catch {
    return;
  }
  if (size <= maxBytes) {
    return;
  }

  const content = fs.readFileSync(logFile, "utf8");
  // Trim with hysteresis to 75% of the cap so a near-cap log is not read and
  // rewritten in full on every subsequent append.
  const targetBytes = Math.floor(maxBytes * 0.75);

  let retained = content;
  while (Buffer.byteLength(retained, "utf8") > targetBytes) {
    const newlineIndex = retained.indexOf("\n");
    if (newlineIndex === -1 || newlineIndex === retained.length - 1) {
      break;
    }
    retained = retained.slice(newlineIndex + 1);
  }

  let output = retained;
  if (Buffer.byteLength(output, "utf8") > targetBytes) {
    const markerBytes = Buffer.byteLength(LOG_TRUNCATION_MARKER, "utf8");
    if (markerBytes >= targetBytes) {
      output = sliceTextTailByBytes(output, targetBytes);
    } else {
      output =
        LOG_TRUNCATION_MARKER +
        sliceTextTailByBytes(output, targetBytes - markerBytes);
    }
  }

  fs.writeFileSync(logFile, output, "utf8");
}

function appendToBoundedLog(logFile, text) {
  if (!logFile || !text) {
    return;
  }
  fs.appendFileSync(logFile, text, "utf8");
  trimLogFile(logFile);
}

function normalizeModelFallback(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const fromModel =
    typeof value.fromModel === "string" && value.fromModel.trim()
      ? value.fromModel.trim()
      : null;
  const toModel =
    typeof value.toModel === "string" && value.toModel.trim()
      ? value.toModel.trim()
      : null;
  if (!fromModel && !toModel) {
    return null;
  }

  return {
    fromModel,
    toModel,
    reason:
      typeof value.reason === "string" && value.reason.trim()
        ? value.reason.trim()
        : null,
    source:
      typeof value.source === "string" && value.source.trim()
        ? value.source.trim()
        : null,
    timestamp:
      typeof value.timestamp === "string" && value.timestamp.trim()
        ? value.timestamp.trim()
        : nowIso(),
  };
}

function normalizeModelFallbackList(value) {
  return Array.isArray(value)
    ? value.map((event) => normalizeModelFallback(event)).filter(Boolean)
    : [];
}

function modelFallbackKey(event) {
  return JSON.stringify([
    event.fromModel ?? "",
    event.toModel ?? "",
    event.reason ?? "",
    event.source ?? "",
  ]);
}

function mergeModelFallbacks(existing, incoming) {
  const merged = [];
  const seen = new Set();
  for (const event of [
    ...normalizeModelFallbackList(existing),
    ...normalizeModelFallbackList(incoming),
  ]) {
    const key = modelFallbackKey(event);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(event);
  }
  return merged.slice(-MAX_JOB_MODEL_FALLBACK_EVENTS);
}

function extractPayloadModelFallbacks(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const direct = normalizeModelFallbackList(payload.modelFallbacks);
  const codex = normalizeModelFallbackList(payload.codex?.modelFallbacks);
  return mergeModelFallbacks(direct, codex);
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd(),
      modelFallback: normalizeModelFallback(value.modelFallback)
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null,
    modelFallback: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  appendToBoundedLog(logFile, `[${nowIso()}] ${normalized}\n`);
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  appendToBoundedLog(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`);
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  ensureStateDir(workspaceRoot);
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, "", "utf8");
  }
  if (title && fs.statSync(logFile).size === 0) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

/**
 * @param {string | null} logFile
 * @returns {{ stdio: import("node:child_process").StdioOptions, close: () => void }}
 */
export function createWorkerLogStdio(logFile) {
  if (!logFile) {
    return { stdio: ["ignore", "ignore", "ignore"], close() {} };
  }
  const fd = fs.openSync(logFile, "a");
  return {
    stdio: ["ignore", fd, fd],
    close() {
      try { fs.closeSync(fd); } catch {}
    },
  };
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId =
    options.sessionId ??
    env[options.sessionIdEnv ?? SESSION_ID_ENV] ??
    (options.cwd ? getCurrentSession(options.cwd) : null);
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastModelFallbackKey = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (normalized.modelFallback) {
      const key = modelFallbackKey(normalized.modelFallback);
      if (key !== lastModelFallbackKey) {
        lastModelFallbackKey = key;
        const existing = readJobFile(workspaceRoot, jobId);
        patch.modelFallbacks = mergeModelFallbacks(
          existing?.modelFallbacks,
          [normalized.modelFallback]
        );
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    // Late display events (e.g. trailing subagent output) must not resurrect
    // phase/thread fields on a job that already reached a terminal status.
    const current = readJobFile(workspaceRoot, jobId);
    if (current && current.status !== "running") {
      return;
    }

    patchJob(workspaceRoot, jobId, patch);
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[cc] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: job.pid ?? null, // Preserve queued worker PID until onSpawn replaces it
    pidIdentity: job.pidIdentity ?? null,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);

  // onSpawn callback: persist Claude child PID/identity at spawn time
  // Guarded by status check — only write if job is still running (cancel may have won)
  const onSpawn = ({ pid, pidIdentity }) => {
    const transition = transitionJob(
      job.workspaceRoot,
      job.id,
      ["running"],
      "running",
      {
        pid,
        pidIdentity,
      }
    );
    if (!transition.transitioned) {
      // Job already left running state (cancel won the race) — kill the child immediately
      try { terminateProcessTree(pid); } catch {}
      return;
    }
  };

  try {
    const execution = await runner(onSpawn);

    // Use CAS for terminal transition: running → completed/failed
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const modelFallbacks = extractPayloadModelFallbacks(execution.payload);
    const terminalData = {
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      pidIdentity: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      summary: execution.summary,
      result: execution.payload,
      rendered: execution.rendered,
      ...(modelFallbacks.length > 0 ? { modelFallbacks } : {}),
    };

    const transitioned = transitionJob(
      job.workspaceRoot,
      job.id,
      ["running"],
      completionStatus,
      terminalData
    );
    // If CAS failed, another actor (cancel) already moved the job to a different state — respect that

    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    cleanupOldJobs(job.workspaceRoot);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();

    // Use CAS: running → failed
    transitionJob(job.workspaceRoot, job.id, ["running"], "failed", {
      errorMessage,
      pid: null,
      pidIdentity: null,
      phase: "failed",
      completedAt,
      logFile: options.logFile ?? job.logFile ?? null
    });
    cleanupOldJobs(job.workspaceRoot);

    throw error;
  }
}
