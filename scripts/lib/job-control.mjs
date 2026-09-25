/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Derived from OpenAI's codex-plugin-cc and modified for Claude Code delegation.
 *
 * Job control — adapted from codex-plugin-cc.
 * Replaced Codex references with Claude Code.
 * Added cancel_failed/cancelling status support.
 */

import fs from "node:fs";
import path from "node:path";

import { resolvePluginStateRoot } from "./codex-paths.mjs";

import {
  getConfig,
  getCurrentSession,
  listJobs,
  readJobFile,
  resolveJobsDir,
  resolveJobFile,
  resolveJobLogFile,
  TERMINAL_JOB_STATUSES,
  sanitizeId,
} from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { listWorkflows } from "./workflows.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 15;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
}

function getCurrentSessionId(options = {}) {
  return (
    options.env?.[SESSION_ID_ENV] ??
    process.env[SESSION_ID_ENV] ??
    (options.cwd ? getCurrentSession(options.cwd) : null)
  );
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) return jobs;
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) return job.kindLabel;
  if (job.kind === "adversarial-review") return "adversarial-review";
  if (job.jobClass === "review") return "review";
  if (job.jobClass === "task") return "rescue";
  if (job.kind === "review") return "review";
  if (job.kind === "task") return "rescue";
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) return [];
  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .filter((l) => l.startsWith("["))
    .map(stripLogPrefix)
    .filter(Boolean);
  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) return null;
  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) return null;
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function resolveProgressFreshness(job, logFile, now = Date.now()) {
  const candidates = [
    job.lastProgressAt,
    job.updatedAt,
    job.startedAt,
    job.createdAt,
  ]
    .map((value) => Date.parse(value ?? ""))
    .filter(Number.isFinite);
  try {
    candidates.push(fs.statSync(logFile).mtimeMs);
  } catch {}
  if (candidates.length === 0) {
    return { lastProgressAt: null, progressAgeMs: null };
  }
  const lastProgressMs = Math.max(...candidates);
  return {
    lastProgressAt: new Date(lastProgressMs).toISOString(),
    progressAgeMs: Math.max(0, now - lastProgressMs),
  };
}

const ACTIVE_STATUSES = new Set(["running", "cancelling"]);

function inferJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "cancelled": return "cancelled";
    case "cancel_failed": return "cancel_failed";
    case "cancelling": return "cancelling";
    case "failed": return "failed";
    case "completed": return "done";
    case "unknown": return "unknown";
    default: break;
  }
  for (let i = progressPreview.length - 1; i >= 0; i--) {
    const line = progressPreview[i].toLowerCase();
    if (line.startsWith("starting claude")) return "starting";
    if (line.includes("review")) return "reviewing";
    if (line.startsWith("running command:") || line.startsWith("tool_use:")) return "investigating";
    if (line.startsWith("editing") || line.startsWith("writing")) return "editing";
    if (line.startsWith("turn completed")) return "finalizing";
    if (line.includes("error") || line.includes("failed")) return "failed";
  }
  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const managedLogFile =
    job?.workspaceRoot && job?.id ? resolveJobLogFile(job.workspaceRoot, job.id) : null;
  const progressFreshness = ACTIVE_STATUSES.has(job.status)
    ? resolveProgressFreshness(job, managedLogFile, options.now ?? Date.now())
    : { lastProgressAt: null, progressAgeMs: null };
  const telemetry = job.result?.codex ?? job.result;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    failure: job.failure ?? telemetry?.failure ?? null,
    requestedModel: job.requestedModel ?? telemetry?.requestedModel ?? null,
    finalModel: job.finalModel ?? telemetry?.finalModel ?? null,
    contextWindow: job.contextWindow ?? telemetry?.contextWindow ?? null,
    progressPreview:
      ACTIVE_STATUSES.has(job.status) || job.status === "failed"
        ? readJobProgressPreview(managedLogFile, maxProgressLines)
        : [],
    logFile: managedLogFile,
    ...progressFreshness,
    elapsed: formatElapsedDuration(
      job.startedAt ?? job.createdAt,
      TERMINAL_JOB_STATUSES.has(job.status) ? (job.completedAt ?? null) : null
    ),
    duration: TERMINAL_JOB_STATUSES.has(job.status)
      ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
      : null,
  };
  return {
    ...enriched,
    phase: enriched.phase ?? inferJobPhase(enriched, enriched.progressPreview),
  };
}

export function enrichWorkflow(workflow) {
  return {
    ...workflow,
    entityType: "workflow",
    kindLabel: `peer ${workflow.mode}`,
    summary: workflow.brief,
    elapsed: formatElapsedDuration(workflow.startedAt ?? workflow.createdAt),
    duration: workflow.completedAt
      ? formatElapsedDuration(workflow.startedAt ?? workflow.createdAt, workflow.completedAt)
      : null,
  };
}

function summarizeWorkflow(workflow) {
  const enriched = enrichWorkflow(workflow);
  return {
    id: enriched.id,
    entityType: enriched.entityType,
    kindLabel: enriched.kindLabel,
    status: enriched.status,
    phase: enriched.phase,
    summary: enriched.summary,
    createdAt: enriched.createdAt,
    startedAt: enriched.startedAt,
    updatedAt: enriched.updatedAt,
    completedAt: enriched.completedAt,
    elapsed: enriched.elapsed,
    duration: enriched.duration,
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  return readJobFile(workspaceRoot, jobId);
}

function matchJobReference(jobs, reference, predicate = (_job) => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) return filtered[0] ?? null;
  const exact = filtered.find((job) => job.id === reference);
  if (exact) return exact;
  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  throw new Error(`No job found for "${reference}". Run status to list known jobs.`);
}

function findExactJobAcrossWorkspaces(reference) {
  const jobId = sanitizeId(reference, "job ID");
  const stateRoot = resolvePluginStateRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(stateRoot, entry.name, "jobs", `${jobId}.json`);
    try {
      if (!fs.lstatSync(candidate).isFile()) continue;
      const stored = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (
        stored?.id !== jobId ||
        typeof stored.workspaceRoot !== "string" ||
        path.resolve(resolveJobsDir(stored.workspaceRoot), `${jobId}.json`) !==
          path.resolve(candidate)
      ) {
        continue;
      }
      const job = listJobs(stored.workspaceRoot).find(
        (knownJob) => knownJob.id === jobId
      );
      if (job) {
        matches.push({ workspaceRoot: stored.workspaceRoot, job });
      }
    } catch {}
  }

  if (matches.length > 1) {
    throw new Error(
      `Job ${jobId} exists in multiple workspaces. Run status from the intended workspace.`
    );
  }
  return matches[0] ?? null;
}

function resolveReferencedJob(workspaceRoot, jobs, reference) {
  const exact = jobs.find((job) => job.id === reference);
  if (exact) return { workspaceRoot, job: exact };
  const global = findExactJobAcrossWorkspaces(reference);
  if (global) return global;
  return { workspaceRoot, job: matchJobReference(jobs, reference) };
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const sessionId = getCurrentSessionId({ ...options, cwd: workspaceRoot });
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const jobs = sortJobsNewestFirst(
    options.all
      ? listJobs(workspaceRoot)
      : filterJobsForCurrentSession(listJobs(workspaceRoot), {
          ...options,
          cwd: workspaceRoot,
        }).filter((job) => !job.workflowId)
  );
  const allWorkflows = listWorkflows(workspaceRoot)
    .filter((workflow) => options.all || !sessionId || workflow.currentOwnerSessionId === sessionId);
  const workflows = allWorkflows.map(summarizeWorkflow)
    .slice(0, options.all ? undefined : maxJobs);
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => ACTIVE_STATUSES.has(job.status))
    .map((job) => enrichJob(job, { maxProgressLines }));

  const finishedJobs = jobs.filter((job) => TERMINAL_JOB_STATUSES.has(job.status));
  const latestFinishedRaw = finishedJobs[0] ?? null;
  const latestFinished = latestFinishedRaw
    ? enrichJob(latestFinishedRaw, { maxProgressLines })
    : null;

  const recent = (options.all ? finishedJobs.slice(1) : finishedJobs.slice(1, maxJobs))
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    workflows,
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate),
    totalJobs: jobs.length,
    totalWorkflows: allWorkflows.length,
    omittedJobs: Math.max(0, finishedJobs.length - recent.length - (latestFinished ? 1 : 0)),
    omittedWorkflows: allWorkflows.length - workflows.length,
  };
}

function matchStatusTarget(workspaceRoot, reference) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const workflows = listWorkflows(workspaceRoot);
  const exact = [
    ...jobs.filter(({ id }) => id === reference).map((job) => ({ targetType: "job", workspaceRoot, job })),
    ...workflows.filter(({ id }) => id === reference).map((workflow) => ({ targetType: "workflow", workspaceRoot, workflow })),
  ];
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`Reference "${reference}" matches both a job and workflow. Use an exact unique id.`);
  }
  const global = findExactJobAcrossWorkspaces(reference);
  if (global) {
    return { targetType: "job", ...global };
  }
  const prefixed = [
    ...jobs.filter(({ id }) => id.startsWith(reference)).map((job) => ({ targetType: "job", workspaceRoot, job })),
    ...workflows.filter(({ id }) => id.startsWith(reference)).map((workflow) => ({ targetType: "workflow", workspaceRoot, workflow })),
  ];
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new Error(`Reference "${reference}" is ambiguous. Use a longer id.`);
  }
  return null;
}

export function buildSingleStatusSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const target = matchStatusTarget(workspaceRoot, reference);
  if (target && "workflow" in target) {
    return {
      targetType: "workflow",
      workspaceRoot: target.workspaceRoot,
      workflow: enrichWorkflow(target.workflow),
    };
  }
  if (target && "job" in target) {
    return {
      targetType: "job",
      workspaceRoot: target.workspaceRoot,
      job: enrichJob(target.job, { maxProgressLines: options.maxProgressLines }),
    };
  }
  throw new Error(`No job or workflow found for "${reference}". Run status to list known work.`);
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const resolved = reference
    ? resolveReferencedJob(workspaceRoot, jobs, reference)
    : { workspaceRoot, job: matchJobReference(jobs, reference) };
  if (!resolved.job) throw new Error(`No job found for "${reference}".`);
  return {
    workspaceRoot: resolved.workspaceRoot,
    job: enrichJob(resolved.job, { maxProgressLines: options.maxProgressLines }),
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(
    reference
      ? listJobs(workspaceRoot)
      : filterJobsForCurrentSession(listJobs(workspaceRoot), {
          cwd: workspaceRoot,
        })
  );
  if (reference) {
    const resolved = resolveReferencedJob(workspaceRoot, jobs, reference);
    const enriched = enrichJob(resolved.job);
    if (TERMINAL_JOB_STATUSES.has(enriched.status)) {
      return { workspaceRoot: resolved.workspaceRoot, job: enriched, state: "terminal" };
    }
    if (enriched.status === "queued" || ACTIVE_STATUSES.has(enriched.status)) {
      return { workspaceRoot: resolved.workspaceRoot, job: enriched, state: "active" };
    }
    throw new Error(
      `Job ${enriched.id} is ${enriched.status}. Check status for more details.`
    );
  }

  const selected = matchJobReference(jobs, reference, (job) =>
    TERMINAL_JOB_STATUSES.has(job.status)
  );
  if (selected) {
    return { workspaceRoot, job: enrichJob(selected), state: "terminal" };
  }
  throw new Error("No finished Claude Code jobs found for this repository yet.");
}

export function resolveResultTarget(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (reference) {
    const resolved = buildSingleStatusSnapshot(workspaceRoot, reference);
    if (resolved.targetType === "job") {
      const job = resolved.job;
      if (TERMINAL_JOB_STATUSES.has(job.status)) return { ...resolved, state: "terminal" };
      if (job.status === "queued" || ACTIVE_STATUSES.has(job.status)) {
        return { ...resolved, state: "active" };
      }
      throw new Error(`Job ${job.id} is ${job.status}. Check status for more details.`);
    }
    const workflow = resolved.workflow;
    return {
      ...resolved,
      state: workflow.checkpoint || workflow.finalResult || workflow.status === "incomplete"
        ? "available"
        : "active",
    };
  }

  const sessionId = getCurrentSessionId({ cwd: workspaceRoot });
  const workflowTargets = listWorkflows(workspaceRoot)
    .filter((workflow) => !sessionId || workflow.currentOwnerSessionId === sessionId)
    .filter((workflow) => workflow.checkpoint || workflow.finalResult || workflow.status === "incomplete")
    .map((workflow) => ({
      targetType: "workflow",
      workspaceRoot,
      workflow: enrichWorkflow(workflow),
      updatedAt: workflow.updatedAt,
      state: "available",
    }));
  const jobTargets = filterJobsForCurrentSession(listJobs(workspaceRoot), { cwd: workspaceRoot })
    .filter((job) => !job.workflowId && TERMINAL_JOB_STATUSES.has(job.status))
    .map((job) => ({
      targetType: "job",
      workspaceRoot,
      job: enrichJob(job),
      updatedAt: job.updatedAt,
      state: "terminal",
    }));
  const selected = [...workflowTargets, ...jobTargets]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))[0];
  if (selected) return selected;
  throw new Error("No finished Claude Code jobs or peer workflow results found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "running" || job.status === "queued");
  if (reference) {
    const localExact = jobs.find((job) => job.id === reference);
    const resolved = localExact
      ? { workspaceRoot, job: localExact }
      : findExactJobAcrossWorkspaces(reference) ?? {
          workspaceRoot,
          job: matchJobReference(activeJobs, reference),
        };
    if (resolved.job.status !== "running" && resolved.job.status !== "queued") {
      throw new Error(`No active job found for "${reference}".`);
    }
    return resolved;
  }
  if (activeJobs.length === 1) return { workspaceRoot, job: activeJobs[0] };
  if (activeJobs.length > 1) throw new Error("Multiple Claude Code jobs are active. Pass a job id to $cc:cancel.");
  throw new Error("No active Claude Code jobs to cancel.");
}

export function resolveCancelableTarget(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (reference) {
    const resolved = buildSingleStatusSnapshot(workspaceRoot, reference);
    if ("workflow" in resolved) {
      if (!["queued", "running", "awaiting_user", "incomplete", "cancel_failed"].includes(resolved.workflow.status)) {
        throw new Error(`No active workflow found for "${reference}".`);
      }
      return resolved;
    }
    if (resolved.job.status !== "running" && resolved.job.status !== "queued") {
      throw new Error(`No active job found for "${reference}".`);
    }
    return resolved;
  }

  const workflows = listWorkflows(workspaceRoot)
    .filter(({ status }) => ["queued", "running", "awaiting_user", "incomplete", "cancel_failed"].includes(status))
    .map((workflow) => ({ targetType: "workflow", workspaceRoot, workflow: enrichWorkflow(workflow) }));
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot))
    .filter((job) => !job.workflowId && (job.status === "running" || job.status === "queued"))
    .map((job) => ({ targetType: "job", workspaceRoot, job: enrichJob(job) }));
  const targets = [...workflows, ...jobs];
  if (targets.length === 1) return targets[0];
  if (targets.length > 1) throw new Error("Multiple Claude Code jobs or peer workflows are active. Pass an id to $cc:cancel.");
  throw new Error("No active Claude Code jobs or peer workflows to cancel.");
}
