#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readHookInput } from "./lib/hook-input.mjs";
import { detectExternalHostOrigin } from "./lib/host-origin.mjs";
import { cleanupAfterOfficialUninstall } from "./lib/plugin-install-guard.mjs";
import {
  getConfig,
  getCurrentSessionMarker,
  listJobs,
  setCurrentSession,
  TERMINAL_JOB_STATUSES,
  transitionJob,
  writeTurnBaseline,
} from "../scripts/lib/state.mjs";
import { getWorkingTreeFingerprint } from "../scripts/lib/git.mjs";
import { nowIso, SESSION_ID_ENV } from "../scripts/lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "../scripts/lib/workspace.mjs";
import {
  listWorkflows,
  markWorkflowNotification,
  readWorkflow,
  workflowNotificationEvent,
} from "../scripts/lib/workflows.mjs";

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

function buildWorkflowContext(workflows) {
  const rows = workflows.map(({ workflow, event }) =>
    `- ${workflow.id} | ${workflow.status} | ${event} | \`$cc:result ${workflow.id}\``
  );
  return [
    workflows.length === 1
      ? "A peer workflow from this session reached a new aggregate milestone."
      : `${workflows.length} peer workflows from this session reached new aggregate milestones.`,
    "",
    "Peer workflows:",
    ...rows,
    "",
    "Before handling the new request, briefly mention the workflow milestone and ask whether the user wants to inspect it first or continue. Use the exact `$cc:result <workflow-id>` command above. Do not announce linked jobs separately or repeat this milestone automatically.",
  ].join("\n");
}

function selectUnreadTerminalJobs(workspaceRoot, sessionId) {
  if (!sessionId) {
    return [];
  }

  return listJobs(workspaceRoot)
    .filter((job) => job.sessionId === sessionId)
    .filter((job) => !job.workflowId)
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

function selectUnreadWorkflows(workspaceRoot, sessionId) {
  return listWorkflows(workspaceRoot)
    .filter((workflow) => workflow.currentOwnerSessionId === sessionId)
    .map((workflow) => ({ workflow, event: workflowNotificationEvent(workflow) }))
    .filter(({ event }) => event)
    .filter(({ workflow, event }) => !(workflow.notifiedEvents ?? []).includes(event))
    .filter(({ workflow, event }) => !(workflow.viewedEvents ?? []).includes(event));
}

function markJobsNotified(workspaceRoot, jobs) {
  const timestamp = nowIso();
  for (const job of jobs) {
    try {
      transitionJob(workspaceRoot, job.id, [job.status], job.status, {
        notifiedAt: timestamp,
      });
    } catch {
      // Notification state is best-effort; still surface the terminal result.
    }
  }
}

function markWorkflowsNotified(workspaceRoot, workflows) {
  const claimed = [];
  for (const { workflow, event } of workflows) {
    let current = workflow;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const updated = markWorkflowNotification(workspaceRoot, current.id, {
          event,
          revision: current.revision,
          epoch: current.epoch,
          mode: current.mode,
        });
        claimed.push({ workflow: updated, event });
        break;
      } catch (error) {
        if (error?.code !== "STALE_REVISION") break;
        try {
          current = readWorkflow(workspaceRoot, current.id);
        } catch {
          break;
        }
        if (
          !current ||
          workflowNotificationEvent(current) !== event ||
          (current.notifiedEvents ?? []).includes(event) ||
          (current.viewedEvents ?? []).includes(event)
        ) {
          break;
        }
      }
    }
  }
  return claimed;
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
  } catch (error) {
    try {
      writeTurnBaseline(workspaceRoot, sessionId, {
        cwd,
        workspaceRoot,
        capturedAt: nowIso(),
        fingerprint: null,
        captureError: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Baseline capture is best-effort. A missing record also keeps Stop fail-open.
    }
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
  try {
    const currentSession = getCurrentSessionMarker(workspaceRoot);
    if (!currentSession || currentSession.sessionId === sessionId) {
      setCurrentSession(workspaceRoot, sessionId, {
        hostOrigin: detectExternalHostOrigin(),
      });
    }
  } catch {
    // Best effort: an invalid session id must not fail a user prompt.
  }
  if (config.stopReviewGate) {
    captureTurnBaseline(workspaceRoot, sessionId, cwd);
  }

  if (isExplicitClaudeStatusRequest(prompt)) {
    return;
  }

  const jobs = selectUnreadTerminalJobs(workspaceRoot, sessionId);
  const workflows = selectUnreadWorkflows(workspaceRoot, sessionId);
  if (jobs.length === 0 && workflows.length === 0) {
    return;
  }

  markJobsNotified(workspaceRoot, jobs);
  const claimedWorkflows = markWorkflowsNotified(workspaceRoot, workflows);
  const sections = [
    ...(claimedWorkflows.length > 0 ? [buildWorkflowContext(claimedWorkflows)] : []),
    ...(jobs.length > 0 ? [buildAdditionalContext(jobs)] : []),
  ];
  if (sections.length === 0) return;
  process.stdout.write(`${sections.join("\n\n")}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
