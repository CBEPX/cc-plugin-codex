#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readHookInput } from "./lib/hook-input.mjs";
import { cleanupAfterOfficialUninstall } from "./lib/plugin-install-guard.mjs";
import {
  getConfig,
  listJobs,
  patchJob,
  TERMINAL_JOB_STATUSES,
  writeTurnBaseline,
} from "../scripts/lib/state.mjs";
import { getWorkingTreeFingerprint } from "../scripts/lib/git.mjs";
import { nowIso, SESSION_ID_ENV } from "../scripts/lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "../scripts/lib/workspace.mjs";

const MAX_LISTED_JOBS = 3;
const SKIP_INTERACTIVE_HOOKS_ENV = "CLAUDE_COMPANION_SKIP_INTERACTIVE_HOOKS";
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isExplicitClaudeStatusRequest(prompt) {
  const text = String(prompt ?? "").toLowerCase();
  return text.includes("$cc:status") || text.includes("$cc:result");
}

function summarizeJob(job) {
  const parts = [job.id, job.status];
  if (job.kindLabel) parts.push(job.kindLabel);
  if (job.summary) parts.push(job.summary);
  return parts.join(" | ");
}

function buildAdditionalContext(jobs) {
  const listed = jobs.slice(0, MAX_LISTED_JOBS).map((job) => `- ${summarizeJob(job)}`);
  const remaining = jobs.length - listed.length;
  const intro =
    jobs.length === 1
      ? "A Claude Code background job from this session reached a terminal state and has not been surfaced yet."
      : `${jobs.length} Claude Code background jobs from this session reached a terminal state and have not been surfaced yet.`;

  const guidance =
    jobs.length === 1
      ? `Before handling the new request, briefly mention that ${jobs[0].id} reached ${jobs[0].status} and ask whether the user wants to inspect its result first or continue with the new request. If they want the result, direct them to \`$cc:result ${jobs[0].id}\`. If the user is clearly asking about this work already, answer that directly instead of asking again. Do not bring this outcome up again automatically after this turn.`
      : "Before handling the new request, briefly mention that these Claude Code jobs reached terminal states and ask whether the user wants to inspect them first or continue with the new request. If they want to inspect them, direct them to `$cc:status` first, then `$cc:result <job-id>` for a specific job. If the user is clearly asking about this work already, answer that directly instead of asking again. Do not bring these outcomes up again automatically after this turn.";

  return [
    intro,
    "",
    "Terminal jobs:",
    ...listed,
    ...(remaining > 0 ? [`- and ${remaining} more terminal Claude Code job(s)`] : []),
    "",
    guidance,
  ].join("\n");
}

function selectUnreadTerminalJobs(workspaceRoot, sessionId) {
  if (!sessionId) {
    return [];
  }

  return listJobs(workspaceRoot)
    .filter((job) => job.sessionId === sessionId)
    .filter((job) => TERMINAL_JOB_STATUSES.has(job.status))
    .filter((job) => job.status !== "cancelled")
    .filter((job) => !job.resultViewedAt)
    .filter((job) => !job.notifiedAt)
    .sort((left, right) =>
      String(right.updatedAt ?? right.completedAt ?? "").localeCompare(
        String(left.updatedAt ?? left.completedAt ?? "")
      )
    );
}

function markJobsNotified(workspaceRoot, jobs) {
  const timestamp = nowIso();
  for (const job of jobs) {
    patchJob(workspaceRoot, job.id, {
      notifiedAt: timestamp,
    });
  }
}

function captureTurnBaseline(workspaceRoot, sessionId, cwd) {
  if (!sessionId) {
    return;
  }
  try {
    const fingerprint = getWorkingTreeFingerprint(cwd);
    writeTurnBaseline(workspaceRoot, sessionId, {
      cwd,
      workspaceRoot,
      capturedAt: nowIso(),
      fingerprint,
    });
  } catch {
    // Baseline capture is best-effort. If it fails, Stop falls back to running review.
  }
}

async function main() {
  const input = readHookInput();
  if (cleanupAfterOfficialUninstall(ROOT_DIR)) {
    return;
  }
  const cwd = input.cwd || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  const prompt = String(input.prompt ?? "");

  if (
    process.env[SKIP_INTERACTIVE_HOOKS_ENV] === "1" ||
    !sessionId
  ) {
    return;
  }

  const config = getConfig(workspaceRoot);
  if (config.stopReviewGate) {
    captureTurnBaseline(workspaceRoot, sessionId, cwd);
  }

  if (isExplicitClaudeStatusRequest(prompt)) {
    return;
  }

  const jobs = selectUnreadTerminalJobs(workspaceRoot, sessionId);
  if (jobs.length === 0) {
    return;
  }

  markJobsNotified(workspaceRoot, jobs);
  process.stdout.write(`${buildAdditionalContext(jobs)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
