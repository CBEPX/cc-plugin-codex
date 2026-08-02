#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session lifecycle hook for Codex — Claude Code bridge.
 *
 * SessionStart: Exports CLAUDE_COMPANION_SESSION_ID and transcript path via CLAUDE_ENV_FILE.
 *
 * SessionEnd:   Cleans up tracked jobs for the session, kills orphan `claude` processes.
 *
 * No broker lifecycle — Claude Code uses direct CLI invocation.
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readHookInput } from "./lib/hook-input.mjs";
import { cleanupAfterOfficialUninstall } from "./lib/plugin-install-guard.mjs";
import { terminateProcessTreeIfIdentityMatches } from "../scripts/lib/process.mjs";
import {
  ACTIVE_JOB_STATUSES,
  clearCurrentSession,
  clearSessionCleanupPending,
  getCurrentSession,
  listPendingSessionCleanups,
  listStoredJobs,
  markSessionCleanupPending,
  setCurrentSession,
  transitionJob,
} from "../scripts/lib/state.mjs";
import {
  SESSION_CLEANUP_PENDING_MESSAGE,
  SESSION_CLEANUP_PENDING_PHASE,
} from "../scripts/lib/session-cleanup.mjs";
import { nowIso, SESSION_ID_ENV } from "../scripts/lib/tracked-jobs.mjs";
import { TRANSCRIPT_PATH_ENV } from "../scripts/lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "../scripts/lib/workspace.mjs";

export { SESSION_ID_ENV };
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const SKIP_INTERACTIVE_HOOKS_ENV = "CLAUDE_COMPANION_SKIP_INTERACTIVE_HOOKS";
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_CLEANUP_BUDGET_MS = 1_500;
const SESSION_HOOK_CLEANUP_DEADLINE_MS = 2_500;

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(
    process.env.CLAUDE_ENV_FILE,
    `export ${name}=${shellEscape(value)}\n`,
    "utf8"
  );
}

function isNestedCodexSession(inputSessionId) {
  const inheritedSessionId = process.env[SESSION_ID_ENV] || null;
  return Boolean(
    inputSessionId &&
      inheritedSessionId &&
      inheritedSessionId !== inputSessionId
  );
}

// ---------------------------------------------------------------------------
// Session cleanup
// ---------------------------------------------------------------------------

function createCleanupDeadlineAt() {
  return Math.min(
    SESSION_HOOK_CLEANUP_DEADLINE_MS,
    performance.now() + SESSION_CLEANUP_BUDGET_MS
  );
}

function remainingCleanupMs(cleanupDeadlineAt) {
  return Math.max(
    0,
    cleanupDeadlineAt - performance.now()
  );
}

function resolveLifecycleWorkspaceRoot(cwd) {
  return resolveWorkspaceRoot(cwd, {
    filesystemFallbackOnTimeout: true,
    gitTimeout: 200,
    processLocalHandoff: true,
  });
}

function reportLifecycleFailure(eventName, error) {
  const code = typeof error?.code === "string" ? ` (${error.code})` : "";
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[cc] ${eventName} cleanup failed${code}: ${detail}\n`);
}

function transitionWithinCleanupBudget(
  workspaceRoot,
  job,
  expectedStatuses,
  nextStatus,
  patch,
  cleanupDeadlineAt
) {
  if (remainingCleanupMs(cleanupDeadlineAt) < 1) {
    return null;
  }
  return transitionJob(
    workspaceRoot,
    job.id,
    expectedStatuses,
    nextStatus,
    patch,
    {
      deadlineAt: cleanupDeadlineAt,
      skipLockOwnerIdentity: process.platform === "win32",
    }
  );
}

function isRetryableCancelFailure(job) {
  return (
    job.status === "cancel_failed" &&
    Number.isInteger(job.pid) &&
    job.pid > 0 &&
    typeof job.pidIdentity === "string" &&
    job.pidIdentity.length > 0
  );
}

function sessionStillNeedsOwnershipMarker(jobs, sessionId) {
  return jobs.some(
    (job) =>
      job.sessionId === sessionId &&
      (isRetryableCancelFailure(job) ||
        (ACTIVE_JOB_STATUSES.has(job.status) &&
          !(
            job.status === "cancelling" &&
            job.phase === SESSION_CLEANUP_PENDING_PHASE
          )))
  );
}

function cleanupSessionJobs(workspaceRoot, jobs, trigger, cleanupDeadlineAt) {
  const prepared = [];
  const updatedJobsById = new Map(jobs.map((job) => [job.id, job]));
  let preparationComplete = true;

  // Persist every unresolved process handle before any external identity check.
  for (const job of jobs) {
    if (
      job.status === "cancel_failed" ||
      (job.status === "cancelling" &&
        job.phase === SESSION_CLEANUP_PENDING_PHASE)
    ) {
      prepared.push(job);
      continue;
    }
    if (!ACTIVE_JOB_STATUSES.has(job.status)) {
      continue;
    }

    try {
      const transition = transitionWithinCleanupBudget(
        workspaceRoot,
        job,
        [job.status],
        "cancelling",
        {
          completedAt: null,
          errorMessage: SESSION_CLEANUP_PENDING_MESSAGE,
          phase: SESSION_CLEANUP_PENDING_PHASE,
        },
        cleanupDeadlineAt
      );
      if (!transition) {
        preparationComplete = false;
        break;
      }
      if (transition.job) {
        updatedJobsById.set(transition.job.id, transition.job);
      }
      if (transition.transitioned) {
        prepared.push(transition.job);
      } else if (
        (transition.job?.status === "cancel_failed" ||
          (transition.job?.status === "cancelling" &&
            transition.job?.phase === SESSION_CLEANUP_PENDING_PHASE))
      ) {
        prepared.push(transition.job);
      }
    } catch {
      preparationComplete = false;
    }
  }

  for (const job of prepared) {
    const timeout = Math.floor(remainingCleanupMs(cleanupDeadlineAt));
    if (timeout <= 0) {
      // Every prepared job already carries a recoverable status or phase.
      break;
    }

    const hasPid = Number.isInteger(job.pid) && job.pid > 0;
    const hasIdentity =
      typeof job.pidIdentity === "string" && job.pidIdentity.length > 0;
    let canSafelyCancel = !hasPid;
    let cancellationFailure =
      "Refused to terminate a stored process without a matching PID identity.";

    if (hasPid && hasIdentity) {
      try {
        const result = terminateProcessTreeIfIdentityMatches(
          job.pid,
          job.pidIdentity,
          { timeout }
        );
        canSafelyCancel =
          result.delivered ||
          result.reason === "process-missing" ||
          result.reason === "identity-mismatch";
        if (!canSafelyCancel) {
          cancellationFailure =
            "Identity-checked process-tree termination did not complete.";
        }
      } catch (error) {
        canSafelyCancel = false;
        const detail = error instanceof Error ? error.message : String(error);
        cancellationFailure = `Failed to terminate the stored process tree: ${detail}`;
      }
    }

    if (remainingCleanupMs(cleanupDeadlineAt) < 1) {
      // Keep the pre-termination marker for SessionStart recovery.
      break;
    }
    try {
      const transition = transitionJob(
        workspaceRoot,
        job.id,
        ["cancelling", "cancel_failed"],
        canSafelyCancel ? "cancelled" : "cancel_failed",
        {
          completedAt: nowIso(),
          errorMessage: canSafelyCancel
            ? `Cancelled because ${trigger}.`
            : cancellationFailure,
          pid: canSafelyCancel ? null : job.pid ?? null,
          pidIdentity: canSafelyCancel ? null : job.pidIdentity ?? null,
          pgid: canSafelyCancel ? null : job.pgid ?? null,
          phase: canSafelyCancel ? "cancelled" : "cancel_failed",
        },
        {
          deadlineAt: cleanupDeadlineAt,
          skipLockOwnerIdentity: process.platform === "win32",
        }
      );
      if (transition.job) {
        updatedJobsById.set(transition.job.id, transition.job);
      }
    } catch {
      // The pre-termination marker remains recoverable.
    }
  }

  return { jobs: [...updatedJobsById.values()], preparationComplete };
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function handleSessionStart(input) {
  const cwd = input.cwd || process.cwd();
  const nestedSession = isNestedCodexSession(input.session_id);
  // Export session ID so companion scripts can correlate jobs
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  if (!nestedSession) {
    appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  }
  appendEnvVar(SKIP_INTERACTIVE_HOOKS_ENV, nestedSession ? "1" : "0");
  // Forward plugin data dir if set
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  if (input.session_id && !nestedSession) {
    let workspaceRoot = null;
    try {
      const cleanupDeadlineAt = createCleanupDeadlineAt();
      workspaceRoot = resolveLifecycleWorkspaceRoot(cwd);
      const jobs = listStoredJobs(workspaceRoot);
      const pendingSessionIds = new Set(
        listPendingSessionCleanups(workspaceRoot)
      );
      const recoverableJobs = jobs.filter(
        (job) => {
          const pendingPhase =
            job.status === "cancelling" &&
            job.phase === SESSION_CLEANUP_PENDING_PHASE;
          const endedSession =
            typeof job.sessionId === "string" &&
            pendingSessionIds.has(job.sessionId);
          return (
            pendingPhase ||
            (endedSession &&
              (ACTIVE_JOB_STATUSES.has(job.status) ||
                isRetryableCancelFailure(job)))
          );
        }
      );
      const cleanup = cleanupSessionJobs(
        workspaceRoot,
        recoverableJobs,
        "pending cleanup was retried",
        cleanupDeadlineAt
      );
      const cleanedJobsById = new Map(
        cleanup.jobs.map((job) => [job.id, job])
      );
      const updatedJobs = jobs.map(
        (job) => cleanedJobsById.get(job.id) ?? job
      );
      for (const pendingSessionId of pendingSessionIds) {
        if (
          !sessionStillNeedsOwnershipMarker(updatedJobs, pendingSessionId)
        ) {
          clearSessionCleanupPending(workspaceRoot, pendingSessionId);
        }
      }
    } catch (error) {
      reportLifecycleFailure("SessionStart", error);
    }
    if (workspaceRoot) {
      setCurrentSession(workspaceRoot, input.session_id);
    }
  }
}

function handleSessionEnd(input) {
  const cleanupDeadlineAt = createCleanupDeadlineAt();
  const cwd = input.cwd || process.cwd();
  let workspaceRoot = null;
  let cleanupMarkerRecorded = false;
  let sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    try {
      workspaceRoot = resolveLifecycleWorkspaceRoot(cwd);
      sessionId = getCurrentSession(workspaceRoot);
    } catch {
      sessionId = null;
    }
  }

  // Clean up tracked jobs for this session
  if (sessionId) {
    try {
      workspaceRoot ??= resolveLifecycleWorkspaceRoot(cwd);
      markSessionCleanupPending(workspaceRoot, sessionId);
      cleanupMarkerRecorded = true;
      const sessionJobs = listStoredJobs(workspaceRoot).filter(
        (job) =>
          job.sessionId === sessionId &&
          (ACTIVE_JOB_STATUSES.has(job.status) ||
            isRetryableCancelFailure(job))
      );
      const cleanup = cleanupSessionJobs(
        workspaceRoot,
        sessionJobs,
        "the Codex session ended",
        cleanupDeadlineAt
      );
      if (
        cleanup.preparationComplete &&
        !sessionStillNeedsOwnershipMarker(cleanup.jobs, sessionId)
      ) {
        clearSessionCleanupPending(workspaceRoot, sessionId);
      }
    } catch (error) {
      reportLifecycleFailure("SessionEnd", error);
    }
    if (workspaceRoot && cleanupMarkerRecorded) {
      clearCurrentSession(workspaceRoot, sessionId);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = readHookInput();
  if (cleanupAfterOfficialUninstall(ROOT_DIR)) {
    return;
  }
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart" || !eventName) {
    // Default to SessionStart (Codex invokes this on session start)
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
