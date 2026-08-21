/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * State management — adapted for Codex plugin.
 * Key changes from original:
 * - Plugin-owned state under the cc plugin data namespace
 * - Legacy claude-code namespace migration
 * - Workspace-hash isolation
 * - Config/job separation in filesystem
 * - CAS for job status transitions
 * - Workspace-scoped stop-review gate config
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

import {
  LEGACY_PLUGIN_DATA_NAMESPACES,
  resolvePluginDataRoot,
  resolvePluginStateRoot,
  resolvePluginsDataRoot,
} from "./codex-paths.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import {
  getProcessIdentity,
  isProcessAlive,
  terminateProcessTreeIfIdentityMatches,
} from "./process.mjs";

const STATE_VERSION = 1;
let ensuredPluginDataRoot = null;
const CONFIG_FILE_NAME = "config.json";
const JOBS_DIR_NAME = "jobs";
const CURRENT_SESSION_FILE_NAME = "current-session.json";
const STOP_REVIEW_LAST_FILE_NAME = "stop-review-last.json";
const STOP_REVIEW_HISTORY_FILE_NAME = "stop-review-history.jsonl";
const TURN_BASELINE_FILE_PREFIX = "turn-baseline";
const MAX_TERMINAL_JOBS_PER_SESSION = 100;
export const MAX_STOP_REVIEW_HISTORY_ENTRIES = 200;
const REAP_GRACE_MS = 2_000;
const WINDOWS_IDENTITY_RECHECK_MS = 5 * 60 * 1000;
const WINDOWS_IDENTITY_UNVERIFIABLE_MAX_MS =
  WINDOWS_IDENTITY_RECHECK_MS * 3;
const WINDOWS_IDENTITY_CHECK_SUFFIX = ".identity-check";
const WINDOWS_IDENTITY_PROBE_SUFFIX = ".identity-probe";
const WINDOWS_IDENTITY_UNAVAILABLE_SUFFIX = ".identity-unavailable";
const WINDOWS_REAPER_IDENTITY_TIMEOUT_MS = 2_000;
const QUEUED_WITHOUT_PID_REAP_GRACE_MS = 30_000;
const INVALID_LOCK_STALE_MS = 15_000;
const LIVE_LOCK_LEASE_MS = 30_000;
const LOCK_HARD_STALE_MS = LIVE_LOCK_LEASE_MS * 4;
const RESERVED_JOB_FILE_MAX_AGE_MS = 60 * 60 * 1000;
const SESSION_CLEANUP_MARKER_PREFIX = "session-cleanup-pending-";
const HARD_LINK_UNSUPPORTED_CODES = new Set([
  "EPERM",
  "ENOSYS",
  "EOPNOTSUPP",
  "ENOTSUP",
  "EXDEV",
]);
let hardLinksUnsupported = false;
export const JOB_RESERVATION_SUFFIX = ".reserve";
export const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "cancelling"]);
export const TERMINAL_JOB_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "cancel_failed",
  "unknown",
]);
const NO_SESSION_RETENTION_BUCKET = "__no-session__";

export function nowIso() {
  return new Date().toISOString();
}

function defaultConfig() {
  return {
    version: STATE_VERSION,
    stopReviewGate: false,
  };
}

function movePath(sourcePath, destinationPath) {
  try {
    fs.renameSync(sourcePath, destinationPath);
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
    fs.cpSync(sourcePath, destinationPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
    fs.rmSync(sourcePath, { recursive: true, force: true });
  }
}

function removeIfEmpty(dirPath) {
  try {
    if (fs.readdirSync(dirPath).length === 0) {
      fs.rmdirSync(dirPath);
    }
  } catch {}
}

function mergeDirectory(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      if (fs.existsSync(destinationPath) && !fs.statSync(destinationPath).isDirectory()) {
        fs.rmSync(destinationPath, { recursive: true, force: true });
      }
      mergeDirectory(sourcePath, destinationPath);
      removeIfEmpty(sourcePath);
      continue;
    }

    if (!fs.existsSync(destinationPath)) {
      movePath(sourcePath, destinationPath);
      continue;
    }

    const sourceStat = fs.statSync(sourcePath);
    const destinationStat = fs.statSync(destinationPath);
    if (sourceStat.mtimeMs > destinationStat.mtimeMs) {
      fs.rmSync(destinationPath, { recursive: true, force: true });
      movePath(sourcePath, destinationPath);
    } else {
      fs.rmSync(sourcePath, { recursive: true, force: true });
    }
  }
}

function migrateLegacyPluginDataRoots() {
  const pluginsDataRoot = resolvePluginsDataRoot();
  const destinationRoot = resolvePluginDataRoot();
  fs.mkdirSync(pluginsDataRoot, { recursive: true, mode: 0o700 });

  for (const legacyNamespace of LEGACY_PLUGIN_DATA_NAMESPACES) {
    const legacyRoot = resolvePluginDataRoot(legacyNamespace);
    if (!fs.existsSync(legacyRoot) || legacyRoot === destinationRoot) {
      continue;
    }

    if (!fs.existsSync(destinationRoot)) {
      movePath(legacyRoot, destinationRoot);
      continue;
    }

    mergeDirectory(legacyRoot, destinationRoot);
    fs.rmSync(legacyRoot, { recursive: true, force: true });
  }
}

function cleanupLegacyStateArtifacts(stateRoot) {
  if (!fs.existsSync(stateRoot)) {
    return;
  }

  for (const workspaceEntry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
    if (!workspaceEntry.isDirectory()) {
      continue;
    }

    const workspaceDir = path.join(stateRoot, workspaceEntry.name);
    for (const child of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!child.isFile() || !child.name.startsWith("armed-")) {
        continue;
      }
      try {
        fs.unlinkSync(path.join(workspaceDir, child.name));
      } catch {}
    }
  }
}

function ensurePluginDataLayout() {
  const destinationRoot = resolvePluginDataRoot();
  if (ensuredPluginDataRoot === destinationRoot) {
    return;
  }
  migrateLegacyPluginDataRoots();
  cleanupLegacyStateArtifacts(resolvePluginStateRoot());
  ensuredPluginDataRoot = destinationRoot;
}

function resolveStateRoot() {
  ensurePluginDataLayout();
  return resolvePluginStateRoot();
}

// ---------------------------------------------------------------------------
// Workspace directory resolution
// ---------------------------------------------------------------------------

export function resolveWorkspaceHash(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export function resolveStateDir(cwd) {
  return path.join(resolveStateRoot(), resolveWorkspaceHash(cwd));
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Config (separate from jobs — minimal write contention)
// ---------------------------------------------------------------------------

function resolveConfigFile(cwd) {
  return path.join(resolveStateDir(cwd), CONFIG_FILE_NAME);
}

function resolveCurrentSessionFile(cwd) {
  return path.join(resolveStateDir(cwd), CURRENT_SESSION_FILE_NAME);
}

function resolveSessionCleanupMarkerFile(cwd, sessionId) {
  sanitizeId(sessionId, "session ID");
  return path.join(
    resolveStateDir(cwd),
    `${SESSION_CLEANUP_MARKER_PREFIX}${sessionId}.json`
  );
}

function resolveStopReviewLastFile(cwd) {
  return path.join(resolveStateDir(cwd), STOP_REVIEW_LAST_FILE_NAME);
}

function resolveStopReviewHistoryFile(cwd) {
  return path.join(resolveStateDir(cwd), STOP_REVIEW_HISTORY_FILE_NAME);
}

function resolveTurnBaselineFile(cwd, sessionId = null) {
  const sessionKey = sessionId ? sanitizeId(sessionId, "session ID") : NO_SESSION_RETENTION_BUCKET;
  return path.join(resolveStateDir(cwd), `${TURN_BASELINE_FILE_PREFIX}.${sessionKey}.json`);
}

export function loadConfig(cwd) {
  const configFile = resolveConfigFile(cwd);
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (parsed.version !== STATE_VERSION) {
      throw new Error(`Incompatible config version: ${parsed.version}`);
    }
    return { ...defaultConfig(), ...parsed };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(cwd, config) {
  ensureStateDir(cwd);
  const data = { ...defaultConfig(), ...config, version: STATE_VERSION };
  writeAtomic(resolveConfigFile(cwd), data);
  return data;
}

export function setConfig(cwd, key, value) {
  const config = loadConfig(cwd);
  config[key] = value;
  return saveConfig(cwd, config);
}

export function getConfig(cwd) {
  return loadConfig(cwd);
}

// ---------------------------------------------------------------------------
// Current session marker (fallback when Codex does not propagate env vars)
// ---------------------------------------------------------------------------

export function setCurrentSession(cwd, sessionId, options = {}) {
  sanitizeId(sessionId, "session ID");
  ensureStateDir(cwd);
  writeAtomic(resolveCurrentSessionFile(cwd), {
    sessionId,
    ...(options.hostOrigin ? { hostOrigin: String(options.hostOrigin) } : {}),
    updatedAt: nowIso(),
  });
}

function readCurrentSessionPayload(cwd) {
  const filePath = resolveCurrentSessionFile(cwd);
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    sanitizeId(payload.sessionId, "session ID");
    return payload;
  } catch {
    return null;
  }
}

export function getCurrentSession(cwd) {
  return readCurrentSessionPayload(cwd)?.sessionId ?? null;
}

export function getCurrentSessionMarker(cwd) {
  const payload = readCurrentSessionPayload(cwd);
  if (!payload) {
    return null;
  }
  return {
    sessionId: payload.sessionId,
    hostOrigin: typeof payload.hostOrigin === "string" ? payload.hostOrigin : null,
  };
}

export function clearCurrentSession(cwd, sessionId = null) {
  const filePath = resolveCurrentSessionFile(cwd);
  if (sessionId != null) {
    const current = getCurrentSession(cwd);
    if (current !== sessionId) {
      return;
    }
  }
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

export function markSessionCleanupPending(cwd, sessionId) {
  ensureStateDir(cwd);
  writeAtomic(resolveSessionCleanupMarkerFile(cwd, sessionId), {
    sessionId,
    updatedAt: nowIso(),
  });
}

export function listPendingSessionCleanups(cwd) {
  const stateDir = resolveStateDir(cwd);
  try {
    return [
      ...new Set(
        fs
          .readdirSync(stateDir)
          .filter(
            (name) =>
              name.startsWith(SESSION_CLEANUP_MARKER_PREFIX) &&
              name.endsWith(".json")
          )
          .map((name) => {
            try {
              const payload = JSON.parse(
                fs.readFileSync(path.join(stateDir, name), "utf8")
              );
              return sanitizeId(payload.sessionId, "session ID");
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      ),
    ];
  } catch {
    return [];
  }
}

export function clearSessionCleanupPending(cwd, sessionId) {
  try {
    fs.unlinkSync(resolveSessionCleanupMarkerFile(cwd, sessionId));
  } catch {}
}

// ---------------------------------------------------------------------------
// Input sanitization
// ---------------------------------------------------------------------------

export function sanitizeId(id, label = "ID") {
  if (typeof id !== "string" || !/^[\w\-.]+$/.test(id)) {
    throw new Error(`Invalid ${label}: ${String(id).slice(0, 50)}`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Job files (per-job isolation)
// ---------------------------------------------------------------------------

export function resolveJobFile(cwd, jobId) {
  sanitizeId(jobId, "job ID");
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  sanitizeId(jobId, "job ID");
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeAtomic(jobFile, { ...payload, updatedAt: nowIso() });
  return jobFile;
}

function normalizeStoredJob(job) {
  const isTask = job?.jobClass === "task" || job?.kind === "task";
  if (
    !job.result ||
    typeof job.result !== "object" ||
    Array.isArray(job.result)
  ) {
    return job;
  }
  if (isTask) {
    return {
      ...job,
      result: {
        ...job.result,
        contextWindow: job.result.contextWindow ?? null,
      },
    };
  }

  const isReview =
    job?.jobClass === "review" ||
    job?.kind === "review" ||
    job?.kind === "adversarial-review";
  if (
    !isReview ||
    !job.result.codex ||
    typeof job.result.codex !== "object" ||
    Array.isArray(job.result.codex)
  ) {
    return job;
  }
  return {
    ...job,
    result: {
      ...job.result,
      codex: {
        ...job.result.codex,
        contextWindow: job.result.codex.contextWindow ?? null,
      },
    },
  };
}

export function readJobFile(cwd, jobId) {
  const jobFile = resolveJobFile(cwd, jobId);
  try {
    return normalizeStoredJob(JSON.parse(fs.readFileSync(jobFile, "utf8")));
  } catch {
    return null;
  }
}

function readAllJobs(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  if (!fs.existsSync(jobsDir)) return [];
  return fs
    .readdirSync(jobsDir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".lock"))
    .map((f) => {
      try {
        return normalizeStoredJob(
          JSON.parse(fs.readFileSync(path.join(jobsDir, f), "utf8"))
        );
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        new Date(b.createdAt ?? 0).getTime() -
        new Date(a.createdAt ?? 0).getTime()
    );
}

export function listStoredJobs(cwd) {
  return readAllJobs(cwd);
}

export function listJobs(cwd) {
  const jobs = reapStaleJobs(cwd, readAllJobs(cwd));
  return partitionJobsForRetention(jobs).retained;
}

function getRetentionBucketKey(job) {
  if (typeof job.sessionId === "string" && job.sessionId.trim()) {
    return job.sessionId.trim();
  }
  return NO_SESSION_RETENTION_BUCKET;
}

function partitionJobsForRetention(jobs) {
  const terminalSeenBySession = new Map();
  const retained = [];
  const pruned = [];

  for (const job of jobs) {
    if (ACTIVE_JOB_STATUSES.has(job.status)) {
      retained.push(job);
      continue;
    }

    const bucketKey = getRetentionBucketKey(job);
    const terminalSeen = terminalSeenBySession.get(bucketKey) ?? 0;
    if (terminalSeen < MAX_TERMINAL_JOBS_PER_SESSION) {
      terminalSeenBySession.set(bucketKey, terminalSeen + 1);
      retained.push(job);
      continue;
    }

    pruned.push(job);
  }

  return { retained, pruned };
}

const REAPABLE_STATUSES = new Set(["queued", "running", "cancelling"]);

function mostRecentJobTimestamp(job) {
  const candidates = [job.updatedAt, job.startedAt, job.createdAt]
    .map((value) => Date.parse(value ?? ""))
    .filter(Number.isFinite);
  if (candidates.length === 0) {
    return null;
  }
  return Math.max(...candidates);
}

function isWithinReapGracePeriod(job, now = Date.now(), graceMs = REAP_GRACE_MS) {
  const timestamp = mostRecentJobTimestamp(job);
  return Number.isFinite(timestamp) && now - timestamp < graceMs;
}

/**
 * Detect zombie jobs whose PID has died and auto-transition them to "failed".
 * Called from listJobs() so every job-reading path benefits automatically.
 */
export function reapStaleJobs(cwd, jobs, options = {}) {
  const platform = options.platform ?? process.platform;
  const isProcessAliveImpl = options.isProcessAliveImpl ?? isProcessAlive;
  const childExitWaitMs = Number.isFinite(options.childExitWaitMs)
    ? Math.max(0, Math.min(options.childExitWaitMs, 1_000))
    : 1_000;
  const sleepSyncImpl = options.sleepSyncImpl ?? sleepSync;
  const getProcessIdentityImpl =
    options.getProcessIdentityImpl ?? getProcessIdentity;
  const terminateProcessTreeIfIdentityMatchesImpl =
    options.terminateProcessTreeIfIdentityMatchesImpl ??
    terminateProcessTreeIfIdentityMatches;
  const childExitDeadline = Date.now() + childExitWaitMs;

  return jobs.map((job) => {
    if (isWithinReapGracePeriod(job)) return job;
    if (!REAPABLE_STATUSES.has(job.status)) return job;
    const workerPid = Number.isInteger(job.workerPid) && job.workerPid > 0
      ? job.workerPid
      : null;
    const workerPidIdentity =
      typeof job.workerPidIdentity === "string" && job.workerPidIdentity
        ? job.workerPidIdentity
        : null;
    const trackWorker = Boolean(
      workerPid &&
      (workerPidIdentity || !job.pid || job.pid === workerPid)
    );
    const trackedPid = trackWorker ? workerPid : job.pid;
    const trackedPidIdentity = trackWorker
      ? workerPidIdentity ?? job.pidIdentity
      : job.pidIdentity;
    if (!trackedPid) {
      if (job.status !== "queued") return job;
      const current = readJobFile(cwd, job.id) ?? job;
      if (
        current.status !== "queued" ||
        current.pid ||
        current.workerPid ||
        isWithinReapGracePeriod(current, Date.now(), QUEUED_WITHOUT_PID_REAP_GRACE_MS)
      ) {
        return current;
      }
      try {
        transitionJob(cwd, job.id, ["queued"], "failed", {
          errorMessage: "Worker did not start before the startup grace period elapsed. Auto-reaped.",
          completedAt: nowIso(),
          pid: null,
          pidIdentity: null,
          workerPid: null,
          workerPidIdentity: null,
          phase: "failed",
        });
        return readJobFile(cwd, job.id) ?? job;
      } catch {
        return job;
      }
    }

    const now = Date.now();
    const processExists = isProcessAliveImpl(trackedPid);
    let withinWindowsIdentityLease = false;
    let windowsIdentityCheckFile = null;
    let windowsIdentityProbeFile = null;
    let windowsIdentityUnavailableFile = null;
    let windowsIdentityUnavailableExists = false;
    let windowsIdentityUnavailableAgeMs = null;
    if (platform === "win32") {
      windowsIdentityCheckFile =
        resolveJobFile(cwd, job.id) + WINDOWS_IDENTITY_CHECK_SUFFIX;
      windowsIdentityProbeFile =
        resolveJobFile(cwd, job.id) + WINDOWS_IDENTITY_PROBE_SUFFIX;
      windowsIdentityUnavailableFile =
        resolveJobFile(cwd, job.id) + WINDOWS_IDENTITY_UNAVAILABLE_SUFFIX;
      let windowsIdentityCheckAgeMs = null;
      try {
        windowsIdentityCheckAgeMs =
          now - fs.statSync(windowsIdentityCheckFile).mtimeMs;
      } catch {}
      let windowsIdentityProbeAgeMs = windowsIdentityCheckAgeMs;
      try {
        windowsIdentityProbeAgeMs =
          now - fs.statSync(windowsIdentityProbeFile).mtimeMs;
      } catch {}
      try {
        windowsIdentityUnavailableAgeMs =
          now - fs.statSync(windowsIdentityUnavailableFile).mtimeMs;
        windowsIdentityUnavailableExists = true;
      } catch {}
      if (Number.isFinite(windowsIdentityProbeAgeMs)) {
        withinWindowsIdentityLease =
          windowsIdentityProbeAgeMs < WINDOWS_IDENTITY_RECHECK_MS;
      } else {
        withinWindowsIdentityLease = isWithinReapGracePeriod(
          job,
          now,
          WINDOWS_IDENTITY_RECHECK_MS
        );
      }
    }
    const needsIdentityCheck =
      processExists &&
      trackedPidIdentity &&
      (platform !== "win32" || !withinWindowsIdentityLease);
    let identityMatches = true;
    let identityUnavailable = false;
    if (needsIdentityCheck) {
      try {
        identityMatches =
          getProcessIdentityImpl(
            trackedPid,
            platform === "win32"
              ? { timeout: WINDOWS_REAPER_IDENTITY_TIMEOUT_MS }
              : undefined
          ) === trackedPidIdentity;
      } catch {
        identityMatches = false;
        identityUnavailable = true;
        if (
          windowsIdentityUnavailableFile &&
          !windowsIdentityUnavailableExists
        ) {
          let inheritedLegacyMarker = false;
          try {
            if (
              windowsIdentityCheckFile &&
              fs.readFileSync(windowsIdentityCheckFile, "utf8") ===
                "unavailable\n"
            ) {
              windowsIdentityUnavailableAgeMs =
                now - fs.statSync(windowsIdentityCheckFile).mtimeMs;
              inheritedLegacyMarker = true;
            }
          } catch {}
          try {
            if (!inheritedLegacyMarker) {
              fs.writeFileSync(
                windowsIdentityUnavailableFile,
                "unavailable\n",
                {
                  mode: 0o600,
                  flag: "wx",
                }
              );
              windowsIdentityUnavailableExists = true;
              windowsIdentityUnavailableAgeMs = 0;
            }
          } catch {
            try {
              windowsIdentityUnavailableAgeMs =
                now - fs.statSync(windowsIdentityUnavailableFile).mtimeMs;
              windowsIdentityUnavailableExists = true;
            } catch {}
          }
        }
        if (windowsIdentityProbeFile) {
          try {
            fs.writeFileSync(windowsIdentityProbeFile, "unavailable\n", {
              mode: 0o600,
            });
          } catch {}
        }
      }
    }
    // POSIX stays fail-open: a restricted `ps` is indistinguishable from a
    // transient identity lookup failure and is not evidence of PID reuse.
    const identityUnavailableTooLong =
      platform === "win32" &&
      identityUnavailable &&
      Number.isFinite(windowsIdentityUnavailableAgeMs) &&
      windowsIdentityUnavailableAgeMs >=
        WINDOWS_IDENTITY_UNVERIFIABLE_MAX_MS;
    const alive =
      processExists &&
      (!needsIdentityCheck ||
        identityMatches ||
        (identityUnavailable && !identityUnavailableTooLong));
    if (alive) {
      if (
        windowsIdentityCheckFile &&
        needsIdentityCheck &&
        identityMatches &&
        !identityUnavailable
      ) {
        try {
          fs.writeFileSync(
            windowsIdentityCheckFile,
            "verified\n",
            { mode: 0o600 }
          );
        } catch {}
        if (windowsIdentityProbeFile) {
          try {
            fs.writeFileSync(windowsIdentityProbeFile, "verified\n", {
              mode: 0o600,
            });
          } catch {}
        }
        if (windowsIdentityUnavailableFile) {
          try {
            fs.unlinkSync(windowsIdentityUnavailableFile);
          } catch {}
        }
      }
      return job;
    }

    // Process is dead — transition via CAS
    try {
      const hasDistinctClaudeChild = Boolean(
        workerPid && job.pid && job.pid !== workerPid
      );
      let childCleanup = null;
      if (hasDistinctClaudeChild) {
        try {
          childCleanup = terminateProcessTreeIfIdentityMatchesImpl(
            job.pid,
            job.pidIdentity,
            {
              platform,
              getProcessIdentityImpl,
              isProcessAliveImpl,
              ...(platform === "win32"
                ? { timeout: WINDOWS_REAPER_IDENTITY_TIMEOUT_MS }
                : {}),
            }
          );
        } catch (error) {
          childCleanup = {
            attempted: true,
            delivered: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }
      let childResolved = Boolean(
        childCleanup?.reason === "process-missing" ||
        childCleanup?.reason === "identity-mismatch"
      );
      if (childCleanup && !childResolved) {
        do {
          childResolved = !isProcessAliveImpl(job.pid);
          if (
            !childResolved &&
            childCleanup.delivered &&
            Date.now() < childExitDeadline
          ) {
            sleepSyncImpl(Math.min(50, childExitDeadline - Date.now()));
          }
        } while (
          !childResolved &&
          childCleanup.delivered &&
          Date.now() < childExitDeadline
        );
      }
      const unresolvedClaudeChild = hasDistinctClaudeChild && !childResolved;
      const nextStatus = job.status === "cancelling"
        ? (identityUnavailableTooLong || unresolvedClaudeChild
            ? "cancel_failed"
            : "cancelled")
        : "failed";
      const terminalData = identityUnavailableTooLong
        ? {
            errorMessage:
              `Process ${trackedPid} identity remained unverifiable beyond the bounded Windows recheck window. Manual cleanup may be required.`,
            completedAt: nowIso(),
            phase: nextStatus,
            reapedUnverifiable: true,
            workerPid: null,
            workerPidIdentity: null,
            ...(nextStatus === "cancel_failed"
              ? { pgid: job.pgid ?? job.pid ?? trackedPid }
              : {}),
          }
        : {
            errorMessage: nextStatus === "cancel_failed"
              ? `Cancellation could not verify cleanup of Claude child ${job.pid}; manual cleanup is required.`
              : job.status === "cancelling"
              ? "Cancelled by user. Auto-reaped after process exit."
              : `${trackWorker ? "Worker" : "Process"} ${trackedPid} died without completing. Auto-reaped.${
                  unresolvedClaudeChild
                    ? ` Claude child ${job.pid} may still be running; manual cleanup is required.`
                    : ""
                }`,
            completedAt: nowIso(),
            ...(unresolvedClaudeChild
              ? {}
              : { pid: null, pidIdentity: null }),
            workerPid: null,
            workerPidIdentity: null,
            ...(nextStatus === "cancel_failed"
              ? { pgid: job.pgid ?? job.pid ?? trackedPid }
              : {}),
            phase: nextStatus,
          };
      const transitioned = transitionJob(
        cwd,
        job.id,
        [job.status],
        nextStatus,
        terminalData
      );
      if (transitioned.transitioned) {
        return readJobFile(cwd, job.id) ?? job;
      }
      // CAS miss — another actor already transitioned; re-read current state
      return readJobFile(cwd, job.id) ?? job;
    } catch {
      return job; // Reaper failure is non-fatal — return original
    }
  });
}

export function upsertJob(cwd, jobPatch) {
  const existing = jobPatch.id ? readJobFile(cwd, jobPatch.id) : null;
  const timestamp = nowIso();
  const job = existing
    ? { ...existing, ...jobPatch, updatedAt: timestamp }
    : { createdAt: timestamp, updatedAt: timestamp, ...jobPatch };
  writeJobFile(cwd, job.id, job);
  return job;
}

export function patchJob(cwd, jobId, patch) {
  const existing = readJobFile(cwd, jobId);
  if (!existing) {
    return null;
  }
  const next = {
    ...existing,
    ...patch,
    id: jobId,
    updatedAt: nowIso(),
  };
  writeJobFile(cwd, jobId, next);
  return next;
}

// ---------------------------------------------------------------------------
// CAS (Compare-And-Swap) for job status transitions
// ---------------------------------------------------------------------------

const CAS_MAX_RETRIES = 3;
const CAS_RETRY_DELAY_MS = 100;

function sleepSync(ms) {
  const boundedMs = Math.max(0, Math.min(Number(ms) || 0, 1_000));
  if (typeof SharedArrayBuffer === "function" && typeof Atomics.wait === "function") {
    const shared = new SharedArrayBuffer(4);
    const view = new Int32Array(shared);
    Atomics.wait(view, 0, 0, boundedMs);
    return;
  }

  const start = Date.now();
  while (Date.now() - start < boundedMs) {
    // Bounded busy-wait fallback when SharedArrayBuffer is unavailable.
  }
}

function unlinkLockIfUnchanged(lockFile, expectedSource) {
  try {
    if (fs.readFileSync(lockFile, "utf8") === expectedSource) {
      fs.unlinkSync(lockFile);
    }
  } catch {}
}

function remainingLockDeadlineMs(options) {
  if (!Number.isFinite(options.deadlineAt)) {
    return null;
  }
  const remaining = Math.floor(options.deadlineAt - performance.now());
  if (remaining > 0) {
    return remaining;
  }
  throw Object.assign(new Error("Job state lock deadline expired"), {
    code: "ELOCKTIMEOUT",
  });
}

function lockProcessTimeout(options) {
  return remainingLockDeadlineMs(options) ?? undefined;
}

function recoverStaleLock(lockFile, options = {}) {
  let lockSource;
  let lockFileAgeMs;
  try {
    lockSource = fs.readFileSync(lockFile, "utf8");
    lockFileAgeMs = Date.now() - fs.statSync(lockFile).mtimeMs;
  } catch {
    return;
  }

  if (lockFileAgeMs >= LOCK_HARD_STALE_MS) {
    unlinkLockIfUnchanged(lockFile, lockSource);
    return;
  }

  let lockData;
  try {
    lockData = JSON.parse(lockSource);
  } catch {
    if (lockFileAgeMs >= INVALID_LOCK_STALE_MS) {
      unlinkLockIfUnchanged(lockFile, lockSource);
    }
    return;
  }

  const pid = lockData?.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    if (lockFileAgeMs >= INVALID_LOCK_STALE_MS) {
      unlinkLockIfUnchanged(lockFile, lockSource);
    }
    return;
  }

  if (!isProcessAlive(pid)) {
    unlinkLockIfUnchanged(lockFile, lockSource);
    return;
  }

  const timestamp = Number(lockData.timestamp);
  const liveLockLeaseExpired =
    Number.isFinite(timestamp) &&
    Date.now() - timestamp >= LIVE_LOCK_LEASE_MS;
  if (!liveLockLeaseExpired) {
    return;
  }
  if (typeof lockData.identity !== "string" || !lockData.identity) {
    return;
  }

  try {
    if (getProcessIdentity(pid, { timeout: lockProcessTimeout(options) }) !== lockData.identity) {
      unlinkLockIfUnchanged(lockFile, lockSource);
    }
  } catch (error) {
    if (error?.code === "ELOCKTIMEOUT") {
      throw error;
    }
  }
}

function acquireJobLock(lockFile, options = {}) {
  let lockOwnerIdentity = null;
  if (!options.skipLockOwnerIdentity) {
    try {
      lockOwnerIdentity = getProcessIdentity(process.pid, {
        timeout: lockProcessTimeout(options),
      });
    } catch (error) {
      if (error?.code === "ELOCKTIMEOUT") {
        throw error;
      }
    }
  }
  const token = randomBytes(16).toString("hex");
  const stagedLockFile =
    `${lockFile}.publish.${process.pid}.${token}`;
  const lockSource = JSON.stringify({
    pid: process.pid,
    identity: lockOwnerIdentity,
    timestamp: Date.now(),
    token,
  });

  try {
    fs.writeFileSync(
      stagedLockFile,
      lockSource,
      { encoding: "utf8", mode: 0o600, flag: "wx" }
    );

    for (let attempt = 0; ; attempt += 1) {
      remainingLockDeadlineMs(options);
      recoverStaleLock(lockFile, options);
      remainingLockDeadlineMs(options);
      try {
        if (hardLinksUnsupported) {
          fs.writeFileSync(lockFile, lockSource, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          });
        } else {
          fs.linkSync(stagedLockFile, lockFile);
        }
        return token;
      } catch (err) {
        if (
          !hardLinksUnsupported &&
          HARD_LINK_UNSUPPORTED_CODES.has(err.code)
        ) {
          hardLinksUnsupported = true;
          attempt -= 1;
          continue;
        }
        if (err.code === "EEXIST" && attempt < CAS_MAX_RETRIES - 1) {
          let delay =
            CAS_RETRY_DELAY_MS + Math.random() * CAS_RETRY_DELAY_MS;
          const remaining = remainingLockDeadlineMs(options);
          if (remaining !== null) {
            delay = Math.min(delay, remaining);
          }
          sleepSync(delay);
          continue;
        }
        if (err.code === "EEXIST") {
          throw Object.assign(
            new Error(`Job state lock remained busy: ${lockFile}`),
            { code: "ELOCKBUSY", cause: err }
          );
        }
        throw err;
      }
    }
  } finally {
    try {
      fs.unlinkSync(stagedLockFile);
    } catch {}
  }
}

function releaseJobLock(lockFile, token) {
  try {
    const current = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (current.token === token) {
      fs.unlinkSync(lockFile);
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Stop review observability
// ---------------------------------------------------------------------------

export function writeStopReviewSnapshot(cwd, payload) {
  ensureStateDir(cwd);
  const snapshot = { ...payload, updatedAt: nowIso() };
  writeAtomic(resolveStopReviewLastFile(cwd), snapshot);
  return snapshot;
}

export function readStopReviewSnapshot(cwd) {
  const filePath = resolveStopReviewLastFile(cwd);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function appendStopReviewHistory(cwd, payload) {
  ensureStateDir(cwd);
  const event = { ...payload, recordedAt: nowIso() };
  const filePath = resolveStopReviewHistoryFile(cwd);
  const nextLine = JSON.stringify(event);
  let retainedLines = [];
  try {
    retainedLines = fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {}
  retainedLines.push(nextLine);
  if (retainedLines.length > MAX_STOP_REVIEW_HISTORY_ENTRIES) {
    retainedLines = retainedLines.slice(-MAX_STOP_REVIEW_HISTORY_ENTRIES);
  }
  fs.writeFileSync(filePath, retainedLines.join("\n") + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  return event;
}

export function writeTurnBaseline(cwd, sessionId, payload) {
  ensureStateDir(cwd);
  const baseline = { ...payload, sessionId, updatedAt: nowIso() };
  writeAtomic(resolveTurnBaselineFile(cwd, sessionId), baseline);
  return baseline;
}

export function readTurnBaseline(cwd, sessionId) {
  const filePath = resolveTurnBaselineFile(cwd, sessionId);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Atomically transition job status from `expected` to `next`.
 * Returns true on success, false if current status !== expected.
 * Throws on persistent lock contention.
 */
export function casJobStatus(cwd, jobId, expected, next, extra = {}) {
  return transitionJob(cwd, jobId, [expected], next, extra).transitioned;
}

export function transitionJob(
  cwd,
  jobId,
  expectedStatuses,
  next,
  extra = {},
  options = {}
) {
  const jobFile = resolveJobFile(cwd, jobId);
  const lockFile = jobFile + ".lock";
  const expectedList = Array.isArray(expectedStatuses)
    ? expectedStatuses
    : [expectedStatuses];
  const lockToken = acquireJobLock(lockFile, options);

  try {
    const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    if (!expectedList.includes(job.status)) {
      return {
        transitioned: false,
        previousStatus: job.status,
        job,
      };
    }

    const updatedJob = {
      ...job,
      status: next,
      ...extra,
      updatedAt: nowIso(),
    };
    writeAtomic(jobFile, updatedJob);
    return {
      transitioned: true,
      previousStatus: job.status,
      job: updatedJob,
    };
  } finally {
    releaseJobLock(lockFile, lockToken);
  }
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

function writeAtomic(filePath, data) {
  const tmp = filePath + `.tmp.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

export function cleanupOldJobs(cwd) {
  const jobs = reapStaleJobs(cwd, readAllJobs(cwd));
  const { pruned: toRemove } = partitionJobsForRetention(jobs);
  for (const job of toRemove) {
    const jobFile = resolveJobFile(cwd, job.id);
    try {
      fs.unlinkSync(jobFile);
    } catch {}
    try {
      fs.unlinkSync(jobFile + WINDOWS_IDENTITY_CHECK_SUFFIX);
    } catch {}
    try {
      fs.unlinkSync(jobFile + WINDOWS_IDENTITY_PROBE_SUFFIX);
    } catch {}
    try {
      fs.unlinkSync(jobFile + WINDOWS_IDENTITY_UNAVAILABLE_SUFFIX);
    } catch {}
    const defaultLogFile = resolveJobLogFile(cwd, job.id);
    try {
      fs.unlinkSync(defaultLogFile);
    } catch {}
  }

  const jobsDir = resolveJobsDir(cwd);
  try {
    for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
      const maxAgeMs = entry.name.endsWith(JOB_RESERVATION_SUFFIX)
        ? RESERVED_JOB_FILE_MAX_AGE_MS
        : /\.json\.lock\.publish\.\d+\.[0-9a-f]{32}$/u.test(entry.name)
          ? LOCK_HARD_STALE_MS
          : null;
      if (!entry.isFile() || maxAgeMs === null) {
        continue;
      }
      try {
        const transientPath = path.join(jobsDir, entry.name);
        const stat = fs.statSync(transientPath);
        if (Date.now() - stat.mtimeMs <= maxAgeMs) {
          continue;
        }
        fs.unlinkSync(transientPath);
      } catch {
        continue;
      }
    }
  } catch {}
}
