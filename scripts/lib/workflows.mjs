/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getWorkingTreeFingerprint } from "./git.mjs";
import {
  nowIso,
  resolveStateDir,
  sanitizeId,
  withStateFileLock,
  writeAtomic,
} from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const WORKFLOW_VERSION = 1;
export const MAX_TERMINAL_WORKFLOWS = 100;
export const WORKFLOW_STATUSES = new Set([
  "queued",
  "running",
  "awaiting_user",
  "incomplete",
  "completed",
  "cancelled",
  "cancel_failed",
]);
export const BRANCH_STATUSES = new Set([
  "pending",
  "running",
  "completed",
  "retryable_failed",
  "cancel_failed",
]);
const WORKFLOW_FAILURE_DETAILS = new Set([
  "CLAUDE_API_ERROR",
  "CLAUDE_MAX_TURNS",
  "CLAUDE_MAX_BUDGET",
  "CLAUDE_STRUCTURED_OUTPUT_RETRIES",
  "CLAUDE_ABORTED",
  "CLAUDE_UNKNOWN_TERMINAL",
  "STRUCTURED_JSON_REQUIRED",
  "NON_EMPTY_CONTENT_REQUIRED",
  "REPOSITORY_CITATION_REQUIRED",
  "DIRECT_HTTPS_CITATION_REQUIRED",
  "REPOSITORY_TOOL_EVENT_REQUIRED",
  "WEB_TOOL_EVENT_REQUIRED",
  "TOOL_EVENT_NOT_ALLOWED",
  "SCHEMA_MISSING",
  "SCHEMA_READ_FAILED",
  "SCHEMA_JSON_INVALID",
  "SCHEMA_SHAPE_INVALID",
]);

const WORKFLOWS_DIR_NAME = "workflows";
const TERMINAL_WORKFLOW_STATUSES = new Set([
  "completed",
  "cancelled",
  "cancel_failed",
]);
const RETRYABLE_STATUSES = new Set([
  "pending",
  "retryable_failed",
]);
const ACTIVE_LINKED_JOB_STATUSES = new Set(["queued", "running", "cancelling"]);
const TOP_LEVEL_PAYLOAD_FIELDS = new Set([
  "checkpoint",
  "feedback",
  "critique",
  "finalResult",
]);
const MODEL_MANIFEST_FIELDS = new Set(["role", "requestedModel", "resolvedModel"]);
const TOOL_MANIFEST_FIELDS = new Set([
  "toolId",
  "source",
  "capability",
  "reason",
  "safetyDecision",
  "transport",
  "configFingerprint",
]);
const SAFETY_DECISION_FIELDS = new Set(["eligible", "decision", "reason"]);

function workflowError(code, message, workflow = null) {
  return Object.assign(new Error(`${code}: ${message}`), {
    code,
    ...(workflow ? { workflow } : {}),
  });
}

function canonicalWorkspaceRoot(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  try {
    return fs.realpathSync.native(workspaceRoot);
  } catch {
    return path.resolve(workspaceRoot);
  }
}

function assertMode(mode) {
  if (mode !== "design" && mode !== "research") {
    throw workflowError("INVALID_WORKFLOW_MODE", "Workflow mode must be design or research.");
  }
  return mode;
}

function assertStatus(status) {
  if (!WORKFLOW_STATUSES.has(status)) {
    throw workflowError("INVALID_WORKFLOW_STATUS", `Unsupported workflow status: ${status}`);
  }
  return status;
}

function assertBranchStatus(status) {
  if (!BRANCH_STATUSES.has(status)) {
    throw workflowError("INVALID_BRANCH_STATUS", `Unsupported branch status: ${status}`);
  }
  return status;
}

export function normalizeWorkflowFailureDetail(value) {
  return typeof value === "string" && WORKFLOW_FAILURE_DETAILS.has(value) ? value : null;
}

function assertJsonObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw workflowError("INVALID_STAGE_PAYLOAD", `${label} must be a JSON object.`);
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw workflowError("INVALID_STAGE_PAYLOAD", `${label} must be JSON serializable.`);
  }
}

function assertPublicManifest(value, label, allowedFields) {
  let manifest;
  try {
    manifest = JSON.parse(JSON.stringify(value ?? []));
  } catch {
    throw workflowError("INVALID_MANIFEST", `${label} must be JSON serializable.`);
  }
  if (!Array.isArray(manifest)) {
    throw workflowError("INVALID_MANIFEST", `${label} must be an array.`);
  }
  for (const record of manifest) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw workflowError("INVALID_MANIFEST", `${label} entries must be objects.`);
    }
    for (const [key, fieldValue] of Object.entries(record)) {
      if (!allowedFields.has(key)) {
        throw workflowError(
          "SECRET_BEARING_MANIFEST",
          `${label} contains a non-public field: ${key}`
        );
      }
      if (key === "safetyDecision") {
        if (!fieldValue || typeof fieldValue !== "object" || Array.isArray(fieldValue)) {
          throw workflowError("INVALID_MANIFEST", `${label} safetyDecision must be an object.`);
        }
        for (const [safetyKey, safetyValue] of Object.entries(fieldValue)) {
          if (!SAFETY_DECISION_FIELDS.has(safetyKey)) {
            throw workflowError(
              "SECRET_BEARING_MANIFEST",
              `${label} safetyDecision contains a non-public field: ${safetyKey}`
            );
          }
          const expectedType = safetyKey === "eligible" ? "boolean" : "string";
          if (safetyValue !== null && typeof safetyValue !== expectedType) {
            throw workflowError("INVALID_MANIFEST", `${label} safetyDecision.${safetyKey} is invalid.`);
          }
        }
      } else if (fieldValue !== null && typeof fieldValue !== "string") {
        throw workflowError("INVALID_MANIFEST", `${label} field ${key} must be a string or null.`);
      }
    }
  }
  return manifest;
}

function normalizedNames(values, label) {
  if (values == null) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw workflowError("INVALID_WORKFLOW_SHAPE", `${label} must be an array.`);
  }
  return [...new Set(values.map((value) => sanitizeId(value, label)))];
}

function initialWorkItems(names) {
  return Object.fromEntries(
    names.map((name) => [name, {
      status: "pending",
      payload: null,
      failureReason: null,
      failureDetail: null,
      attempts: 0,
    }])
  );
}

function validateStoredWorkflow(workflow, workspaceRoot, expectedMode = null) {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw workflowError("INVALID_WORKFLOW_RECORD", "Stored workflow is not an object.");
  }
  if (workflow.version !== WORKFLOW_VERSION) {
    throw workflowError(
      "INCOMPATIBLE_WORKFLOW_VERSION",
      `Unsupported workflow version: ${workflow.version}`
    );
  }
  sanitizeId(workflow.id, "workflow ID");
  assertMode(workflow.mode);
  assertStatus(workflow.status);
  if (!Number.isInteger(workflow.revision) || workflow.revision < 0) {
    throw workflowError("INVALID_WORKFLOW_RECORD", "Stored workflow revision is invalid.");
  }
  if (!Number.isInteger(workflow.epoch) || workflow.epoch < 0) {
    throw workflowError("INVALID_WORKFLOW_RECORD", "Stored workflow epoch is invalid.");
  }
  if (workflow.workspaceRoot !== workspaceRoot) {
    throw workflowError(
      "WORKSPACE_MISMATCH",
      `Workflow ${workflow.id} belongs to ${workflow.workspaceRoot}, not ${workspaceRoot}.`
    );
  }
  if (expectedMode && workflow.mode !== expectedMode) {
    throw workflowError(
      "WORKFLOW_MODE_MISMATCH",
      `Workflow ${workflow.id} is ${workflow.mode}, not ${expectedMode}.`
    );
  }
  return workflow;
}

function readWorkflowAt(filePath, workspaceRoot, expectedMode = null, expectedId = null) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw workflowError(
        "UNSAFE_WORKFLOW_PATH",
        `Workflow record is not a regular managed file: ${filePath}`
      );
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const workflow = validateStoredWorkflow(
    JSON.parse(source),
    workspaceRoot,
    expectedMode
  );
  if (expectedId && workflow.id !== expectedId) {
    throw workflowError(
      "WORKFLOW_ID_MISMATCH",
      `Workflow file for ${expectedId} contains ${workflow.id}.`
    );
  }
  return workflow;
}

function assertCas(workflow, options) {
  if (workflow.revision !== options.revision) {
    throw workflowError(
      "STALE_REVISION",
      `Expected revision ${options.revision}, found ${workflow.revision}.`
    );
  }
  assertWorkflowEpoch(workflow, options.epoch);
}

function assertWorkflowEpoch(workflow, expectedEpoch) {
  if (workflow.epoch !== expectedEpoch) {
    throw workflowError(
      "STALE_EPOCH",
      `Expected epoch ${expectedEpoch}, found ${workflow.epoch}.`
    );
  }
}

function leaseDigest(lease) {
  return createHash("sha256").update(String(lease ?? ""), "utf8").digest("hex");
}

function newLease() {
  return randomBytes(32).toString("hex");
}

function assertAttemptFence(workflow, target, options) {
  const reservation = target.state.attemptReservation;
  if (
    reservation?.epoch !== workflow.epoch ||
    typeof options.lease !== "string" ||
    reservation.leaseDigest !== leaseDigest(options.lease)
  ) {
    throw workflowError("STALE_ATTEMPT", `${target.key} attempt lease is stale.`);
  }
}

function attemptActivationTarget(workflow, options) {
  if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
    throw workflowError("WORKFLOW_TERMINAL", `Workflow ${workflow.id} is ${workflow.status}.`);
  }
  const target = targetState(workflow, options.stage, options.branchId);
  if (target.state.status === "completed") {
    throw workflowError("COMPLETED_STAGE_IMMUTABLE", `${target.key} is already completed.`);
  }
  if (target.state.status === "running") {
    throw workflowError("DUPLICATE_CONTINUE", `${target.key} is already running.`);
  }
  assertAttemptFence(workflow, target, options);
  return target;
}

export function workflowPayloadSha256(payload) {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function enterIncomplete(workflow) {
  return {
    incompleteGeneration:
      (workflow.incompleteGeneration ?? 0) + (workflow.status === "incomplete" ? 0 : 1),
  };
}

function mutateWorkflow(cwd, workflowId, options, reducer) {
  const workspaceRoot = canonicalWorkspaceRoot(cwd);
  const filePath = resolveWorkflowFile(workspaceRoot, workflowId);
  let enteredTerminal = false;
  const next = withStateFileLock(filePath, () => {
    const workflow = readWorkflowAt(
      filePath,
      workspaceRoot,
      options.mode ?? null,
      workflowId
    );
    if (!workflow) {
      throw workflowError("WORKFLOW_NOT_FOUND", `No workflow found for ${workflowId}.`);
    }
    assertCas(workflow, options);
    const timestamp = nowIso();
    const reduced = reducer(workflow, timestamp);
    const next = {
      ...reduced,
      id: workflow.id,
      version: WORKFLOW_VERSION,
      workspaceRoot,
      revision: workflow.revision + 1,
      updatedAt: timestamp,
    };
    validateStoredWorkflow(next, workspaceRoot, workflow.mode);
    writeAtomic(filePath, next);
    enteredTerminal =
      !TERMINAL_WORKFLOW_STATUSES.has(workflow.status) &&
      TERMINAL_WORKFLOW_STATUSES.has(next.status);
    return next;
  }, options);
  if (enteredTerminal) {
    cleanupOldWorkflows(workspaceRoot);
  }
  return next;
}

function sameFingerprint(left, right) {
  return Boolean(left?.signature && left.signature === right?.signature);
}

function targetState(workflow, stage, branchId) {
  const safeStage = sanitizeId(stage, "workflow stage");
  if (branchId) {
    const safeBranchId = sanitizeId(branchId, "workflow branch ID");
    const branch = workflow.branches?.[safeBranchId];
    if (!Object.hasOwn(workflow.branches ?? {}, safeBranchId) || !branch) {
      throw workflowError("WORKFLOW_BRANCH_NOT_FOUND", `Unknown workflow branch: ${safeBranchId}`);
    }
    const storedStage = branch.stage == null
      ? safeStage
      : sanitizeId(branch.stage, "stored workflow branch stage");
    if (storedStage !== safeStage) {
      throw workflowError(
        "WORKFLOW_STAGE_MISMATCH",
        `Workflow branch ${safeBranchId} belongs to ${storedStage}, not ${safeStage}.`
      );
    }
    return { collection: "branches", key: safeBranchId, state: branch, stage: storedStage };
  }
  const state = workflow.stages?.[safeStage];
  if (!Object.hasOwn(workflow.stages ?? {}, safeStage) || !state) {
    throw workflowError("WORKFLOW_STAGE_NOT_FOUND", `Unknown workflow stage: ${safeStage}`);
  }
  return { collection: "stages", key: safeStage, state, stage: safeStage };
}

function appendBranchAttempt(workflow, target, event, status, timestamp, extra = {}) {
  if (target.collection !== "branches") {
    return workflow.branchAttempts ?? [];
  }
  return [
    ...(workflow.branchAttempts ?? []),
    {
      branchId: target.key,
      stage: target.stage,
      attempt: target.state.attempts + (event === "started" ? 1 : 0),
      event,
      status,
      epoch: workflow.epoch,
      recordedAt: timestamp,
      ...extra,
    },
  ];
}

function updateTarget(workflow, target, state) {
  return {
    ...workflow,
    [target.collection]: {
      ...workflow[target.collection],
      [target.key]: state,
    },
  };
}

function attemptTargetKey(target) {
  return `${target.collection === "branches" ? "branch" : "stage"}:${target.key}`;
}

function terminalTargetState(state, fields) {
  const { attemptReservation: _attemptReservation, ...rest } = state;
  return { ...rest, ...fields };
}

function invalidatedTargetState(state, status, failureReason, timestamp, failureDetail = null) {
  const {
    attemptReservation: _attemptReservation,
    commitment: _commitment,
    ...rest
  } = state;
  return {
    ...rest,
    status,
    payload: null,
    failureReason,
    failureDetail: normalizeWorkflowFailureDetail(failureDetail),
    completedAt: timestamp,
  };
}

function hasUnfinishedAttempt(state) {
  return state?.status === "running" || Boolean(state?.attemptReservation);
}

function hasUnactivatedRetryReservation(state) {
  return state?.status === "retryable_failed" && Boolean(state.attemptReservation);
}

function shouldPreserveAggregateFailure(workflow, target) {
  if (workflow.status !== "incomplete") return false;
  return [
    ...Object.entries(workflow.branches ?? {}).map(([key, state]) => ["branches", key, state]),
    ...Object.entries(workflow.stages ?? {}).map(([key, state]) => ["stages", key, state]),
  ].some(([collection, key, state]) =>
    (collection !== target.collection || key !== target.key) &&
    ["retryable_failed", "cancel_failed"].includes(state.status)
  );
}

function assertNoActiveAttemptLeaseReflection(workflow, payload) {
  const activeDigests = new Set([
    ...Object.values(workflow.branches ?? {}),
    ...Object.values(workflow.stages ?? {}),
  ].flatMap((target) => {
    const reservation = target?.attemptReservation;
    return reservation?.epoch === workflow.epoch && typeof reservation.leaseDigest === "string"
      ? [reservation.leaseDigest]
      : [];
  }));
  if (activeDigests.size === 0) return;
  const values = [payload];
  while (values.length > 0) {
    const value = values.pop();
    if (typeof value === "string") {
      for (const match of value.matchAll(/(?=([a-f0-9]{64}))/gu)) {
        if (activeDigests.has(leaseDigest(match[1]))) {
          throw workflowError(
            "ATTEMPT_LEASE_REFLECTION",
            "Peer payload contains an active attempt lease."
          );
        }
      }
    } else if (value && typeof value === "object") {
      values.push(...Object.keys(value));
      values.push(...Object.values(value));
    }
  }
}

function workflowSafetyViolation(workflow, target, timestamp, fingerprint) {
  const failedState = invalidatedTargetState(
    target.state,
    "retryable_failed",
    "SAFETY_VIOLATION",
    timestamp
  );
  return {
    ...updateTarget(workflow, target, failedState),
    status: "incomplete",
    phase: target.stage,
    failureReason: "SAFETY_VIOLATION",
    failureDetail: null,
    ...enterIncomplete(workflow),
    branchAttempts: appendBranchAttempt(
      workflow,
      target,
      "failed",
      "retryable_failed",
      timestamp,
      { failureReason: "SAFETY_VIOLATION", failureDetail: null, fingerprint }
    ),
  };
}

export function resolveWorkflowsDir(cwd) {
  return path.join(resolveStateDir(cwd), WORKFLOWS_DIR_NAME);
}

export function resolveWorkflowFile(cwd, workflowId) {
  const safeId = sanitizeId(workflowId, "workflow ID");
  return path.join(resolveWorkflowsDir(cwd), `${safeId}.json`);
}

export function generateWorkflowId() {
  return `workflow-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function reserveWorkflow(cwd, input) {
  const workspaceRoot = canonicalWorkspaceRoot(cwd);
  const id = sanitizeId(input?.id ?? generateWorkflowId(), "workflow ID");
  const mode = assertMode(input?.mode);
  const brief = String(input?.brief ?? "").trim();
  if (!brief) {
    throw workflowError("INVALID_WORKFLOW_BRIEF", "Workflow brief is required.");
  }
  const originSessionId = sanitizeId(input?.originSessionId, "origin session ID");
  const currentOwnerSessionId = sanitizeId(
    input?.currentOwnerSessionId ?? originSessionId,
    "current owner session ID"
  );
  const modelManifest = assertPublicManifest(
    input?.modelManifest ?? [],
    "model manifest",
    MODEL_MANIFEST_FIELDS
  );
  const toolManifest = assertPublicManifest(
    input?.toolManifest ?? [],
    "tool manifest",
    TOOL_MANIFEST_FIELDS
  );
  const stages = normalizedNames(input?.stages ?? [], "workflow stage");
  const branches = normalizedNames(input?.branches ?? [], "workflow branch ID");
  const fingerprint = getWorkingTreeFingerprint(workspaceRoot);
  const timestamp = nowIso();
  const workflow = {
    version: WORKFLOW_VERSION,
    id,
    mode,
    status: "queued",
    phase: "queued",
    revision: 0,
    epoch: 0,
    workspaceRoot,
    fingerprint,
    brief,
    briefHash: createHash("sha256").update(brief, "utf8").digest("hex"),
    originSessionId,
    currentOwnerSessionId,
    modelManifest,
    toolManifest,
    stages: initialWorkItems(stages),
    branches: initialWorkItems(branches),
    branchAttempts: [],
    claudeSessionId: null,
    checkpoint: null,
    feedback: null,
    critique: null,
    finalResult: null,
    failureReason: null,
    failureDetail: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const workflowsDir = resolveWorkflowsDir(workspaceRoot);
  fs.mkdirSync(workflowsDir, { recursive: true, mode: 0o700 });
  const filePath = resolveWorkflowFile(workspaceRoot, id);
  withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      throw workflowError("WORKFLOW_EXISTS", `Workflow ${id} already exists.`);
    }
    writeAtomic(filePath, workflow);
  });
  cleanupOldWorkflows(workspaceRoot);
  return workflow;
}

export function readWorkflow(cwd, workflowId, options = {}) {
  const workspaceRoot = canonicalWorkspaceRoot(cwd);
  return readWorkflowAt(
    resolveWorkflowFile(workspaceRoot, workflowId),
    workspaceRoot,
    options.mode ?? null,
    workflowId
  );
}

export function listWorkflows(cwd, options = {}) {
  const workspaceRoot = canonicalWorkspaceRoot(cwd);
  const workflowsDir = resolveWorkflowsDir(workspaceRoot);
  let names = [];
  try {
    names = fs.readdirSync(workflowsDir)
      .filter((name) => name.endsWith(".json") && !name.endsWith(".lock"));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      try {
        return readWorkflowAt(
          path.join(workflowsDir, name),
          workspaceRoot,
          options.mode ?? null,
          name.slice(0, -".json".length)
        );
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

export function reserveWorkflowAttempts(cwd, workflowId, options, targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw workflowError("INVALID_ATTEMPT_TARGETS", "At least one attempt target is required.");
  }
  const leases = {};
  const workflow = mutateWorkflow(cwd, workflowId, options, (current, timestamp) => {
    if (TERMINAL_WORKFLOW_STATUSES.has(current.status)) {
      throw workflowError("WORKFLOW_TERMINAL", `Workflow ${current.id} is ${current.status}.`);
    }
    const resolved = targets.map(({ stage, branchId }) => targetState(current, stage, branchId));
    const keys = resolved.map(attemptTargetKey);
    if (new Set(keys).size !== keys.length) {
      throw workflowError("DUPLICATE_ATTEMPT_TARGET", "Attempt targets must be unique.");
    }
    let next = current;
    for (const target of resolved) {
      if (target.state.status === "completed") {
        throw workflowError("COMPLETED_STAGE_IMMUTABLE", `${target.key} is already completed.`);
      }
      if (!["pending", "retryable_failed"].includes(target.state.status)) {
        throw workflowError("DUPLICATE_CONTINUE", `${target.key} cannot be reserved from ${target.state.status}.`);
      }
      const lease = newLease();
      leases[attemptTargetKey(target)] = lease;
      next = updateTarget(next, targetState(next, target.stage, target.collection === "branches" ? target.key : null), {
        ...target.state,
        ...(target.collection === "branches" ? { stage: target.stage } : {}),
        attemptReservation: {
          leaseDigest: leaseDigest(lease),
          epoch: current.epoch,
          reservedAt: timestamp,
          previousFailureDetail: normalizeWorkflowFailureDetail(target.state.failureDetail),
        },
      });
    }
    return next;
  });
  return { workflow, leases };
}

export function preflightWorkflowAttempt(cwd, workflowId, options) {
  const workflow = readWorkflow(cwd, workflowId, {
    ...(options.mode ? { mode: options.mode } : {}),
  });
  if (!workflow) {
    throw workflowError("WORKFLOW_NOT_FOUND", `No workflow found for ${workflowId}.`);
  }
  assertWorkflowEpoch(workflow, options.epoch);
  attemptActivationTarget(workflow, options);
  return workflow;
}

export function activateWorkflowAttempt(cwd, workflowId, options) {
  const currentFingerprint = getWorkingTreeFingerprint(cwd);
  let drifted = false;
  const next = mutateWorkflow(cwd, workflowId, options, (workflow, timestamp) => {
    const target = attemptActivationTarget(workflow, options);
    if (!sameFingerprint(workflow.fingerprint, currentFingerprint)) {
      drifted = true;
      return {
        ...workflow,
        status: "incomplete",
        phase: options.stage,
        failureReason: "STALE_WORKSPACE",
        failureDetail: null,
        ...enterIncomplete(workflow),
      };
    }
    const attempts = target.state.attempts + 1;
    const startedState = {
      ...target.state,
      status: "running",
      stage: target.stage,
      attempts,
      failureReason: null,
      failureDetail: null,
      startedAt: timestamp,
      startFingerprint: currentFingerprint,
      commitment: null,
    };
    const preserveAggregateFailure = shouldPreserveAggregateFailure(workflow, target);
    return {
      ...updateTarget(workflow, target, startedState),
      status: preserveAggregateFailure ? workflow.status : "running",
      phase: preserveAggregateFailure ? workflow.phase : target.stage,
      failureReason: preserveAggregateFailure ? workflow.failureReason : null,
      failureDetail: preserveAggregateFailure ? workflow.failureDetail ?? null : null,
      startedAt: workflow.startedAt ?? timestamp,
      branchAttempts: appendBranchAttempt(
        workflow,
        target,
        "started",
        "running",
        timestamp,
        { fingerprint: currentFingerprint }
      ),
    };
  });
  if (drifted) {
    throw workflowError("STALE_WORKSPACE", "Workspace changed before continuation.", next);
  }
  return next;
}

function completeWorkflowStage(cwd, workflowId, options, reveal) {
  const currentFingerprint = getWorkingTreeFingerprint(cwd);
  const payload = assertJsonObject(options.payload, "Stage payload");
  if (options.field && !TOP_LEVEL_PAYLOAD_FIELDS.has(options.field)) {
    throw workflowError("INVALID_PAYLOAD_FIELD", `Unsupported workflow payload field: ${options.field}`);
  }
  if (options.status) {
    assertStatus(options.status);
  }
  let violated = false;
  const next = mutateWorkflow(cwd, workflowId, options, (workflow, timestamp) => {
    if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
      throw workflowError("WORKFLOW_TERMINAL", `Workflow ${workflow.id} is ${workflow.status}.`);
    }
    assertNoActiveAttemptLeaseReflection(workflow, payload);
    const target = targetState(workflow, options.stage, options.branchId);
    if (target.state.status === "completed") {
      throw workflowError("COMPLETED_STAGE_IMMUTABLE", `${target.key} is already completed.`);
    }
    if (!options.oneShot && target.state.status !== "running") {
      throw workflowError("STAGE_NOT_RUNNING", `${target.key} is not running.`);
    }
    if (options.oneShot && !["pending", "retryable_failed"].includes(target.state.status)) {
      throw workflowError("DUPLICATE_CONTINUE", `${target.key} cannot be submitted from ${target.state.status}.`);
    }
    if (!options.oneShot) assertAttemptFence(workflow, target, options);
    if (reveal) {
      if (!target.state.commitment || target.state.commitment !== workflowPayloadSha256(payload)) {
        throw workflowError("COMMITMENT_MISMATCH", `${target.key} payload does not match its commitment.`);
      }
    } else if (target.state.commitment) {
      throw workflowError("STAGE_REVEAL_REQUIRED", `${target.key} requires the trusted reveal path.`);
    }
    const startFingerprint = options.oneShot ? workflow.fingerprint : target.state.startFingerprint;
    if (!sameFingerprint(startFingerprint, currentFingerprint)) {
      violated = true;
      return workflowSafetyViolation(workflow, target, timestamp, currentFingerprint);
    }
    if (
      workflow.claudeSessionId &&
      options.claudeSessionId &&
      workflow.claudeSessionId !== options.claudeSessionId
    ) {
      throw workflowError(
        "CLAUDE_SESSION_MISMATCH",
        `Workflow ${workflow.id} already owns another Claude session.`
      );
    }
    const completedState = terminalTargetState(target.state, {
      status: "completed",
      payload,
      attempts: target.state.attempts + (options.oneShot ? 1 : 0),
      failureReason: null,
      failureDetail: null,
      ...(options.oneShot ? {
        stage: target.stage,
        startedAt: timestamp,
        startFingerprint: currentFingerprint,
      } : {}),
      completedAt: timestamp,
    });
    const requestedStatus = options.status ??
      (options.field === "finalResult" ? "completed" : "running");
    const preserveAggregateFailure = shouldPreserveAggregateFailure(workflow, target);
    const status = preserveAggregateFailure ? workflow.status : requestedStatus;
    const phase = preserveAggregateFailure
      ? workflow.phase
      : options.phase ?? (status === "completed" ? "done" : target.stage);
    return {
      ...updateTarget(workflow, target, completedState),
      status,
      phase,
      fingerprint: currentFingerprint,
      failureReason: preserveAggregateFailure ? workflow.failureReason : null,
      failureDetail: preserveAggregateFailure ? workflow.failureDetail ?? null : null,
      ...(options.field ? { [options.field]: payload } : {}),
      ...(options.claudeSessionId ? { claudeSessionId: options.claudeSessionId } : {}),
      ...(status === "completed" ? { completedAt: timestamp } : {}),
      branchAttempts: options.oneShot
        ? appendBranchAttempt(
            {
              ...workflow,
              branchAttempts: appendBranchAttempt(
                workflow, target, "started", "running", timestamp,
                { fingerprint: currentFingerprint }
              ),
            },
            { ...target, state: completedState },
            "completed", "completed", timestamp, { payload }
          )
        : appendBranchAttempt(
            workflow, target, "completed", "completed", timestamp, { payload }
          ),
    };
  });
  if (violated) {
    throw workflowError("SAFETY_VIOLATION", "Workspace changed while a worker was running.", next);
  }
  return next;
}

export function submitWorkflowStage(cwd, workflowId, options) {
  return completeWorkflowStage(cwd, workflowId, options, false);
}

export function commitWorkflowStage(cwd, workflowId, options) {
  const payload = assertJsonObject(options.payload, "Stage payload");
  const currentFingerprint = getWorkingTreeFingerprint(cwd);
  let violated = false;
  const next = mutateWorkflow(cwd, workflowId, options, (workflow, timestamp) => {
    if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
      throw workflowError("WORKFLOW_TERMINAL", `Workflow ${workflow.id} is ${workflow.status}.`);
    }
    assertNoActiveAttemptLeaseReflection(workflow, payload);
    const target = targetState(workflow, options.stage, options.branchId);
    if (target.state.status !== "running") {
      throw workflowError("STAGE_NOT_RUNNING", `${target.key} is not running.`);
    }
    assertAttemptFence(workflow, target, options);
    if (target.state.commitment) {
      throw workflowError("ATTEMPT_ALREADY_COMMITTED", `${target.key} is already committed.`);
    }
    if (
      workflow.claudeSessionId &&
      options.claudeSessionId &&
      workflow.claudeSessionId !== options.claudeSessionId
    ) {
      throw workflowError(
        "CLAUDE_SESSION_MISMATCH",
        `Workflow ${workflow.id} already owns another Claude session.`
      );
    }
    if (!sameFingerprint(target.state.startFingerprint, currentFingerprint)) {
      violated = true;
      return workflowSafetyViolation(workflow, target, timestamp, currentFingerprint);
    }
    return {
      ...updateTarget(workflow, target, {
        ...target.state,
        commitment: workflowPayloadSha256(payload),
        committedAt: timestamp,
      }),
      ...(options.claudeSessionId ? { claudeSessionId: options.claudeSessionId } : {}),
    };
  });
  if (violated) {
    throw workflowError("SAFETY_VIOLATION", "Workspace changed while a worker was running.", next);
  }
  return next;
}

export function revealWorkflowStage(cwd, workflowId, options) {
  return completeWorkflowStage(cwd, workflowId, options, true);
}

export function markWorkflowBranchFailure(cwd, workflowId, options) {
  const currentFingerprint = getWorkingTreeFingerprint(cwd);
  const status = assertBranchStatus(options.cancelFailed ? "cancel_failed" : "retryable_failed");
  const reason = String(options.reason ?? "").trim();
  const failureDetail = normalizeWorkflowFailureDetail(options.failureDetail);
  if (!reason) {
    throw workflowError("INVALID_FAILURE_REASON", "A branch failure reason is required.");
  }
  let violated = false;
  const next = mutateWorkflow(cwd, workflowId, options, (workflow, timestamp) => {
    if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
      throw workflowError("WORKFLOW_TERMINAL", `Workflow ${workflow.id} is ${workflow.status}.`);
    }
    const target = targetState(workflow, options.stage, options.branchId);
    if (target.state.status === "completed") {
      throw workflowError("COMPLETED_STAGE_IMMUTABLE", `${target.key} is already completed.`);
    }
    if (!options.oneShot && target.state.status !== "running") {
      throw workflowError("STAGE_NOT_RUNNING", `${target.key} is not running.`);
    }
    if (options.oneShot && !["pending", "retryable_failed"].includes(target.state.status)) {
      throw workflowError("DUPLICATE_CONTINUE", `${target.key} cannot fail from ${target.state.status}.`);
    }
    if (!options.oneShot) assertAttemptFence(workflow, target, options);
    const startFingerprint = options.oneShot ? workflow.fingerprint : target.state.startFingerprint;
    if (!sameFingerprint(startFingerprint, currentFingerprint)) {
      violated = true;
      return workflowSafetyViolation(workflow, target, timestamp, currentFingerprint);
    }
    const failedState = {
      ...invalidatedTargetState(target.state, status, reason, timestamp, failureDetail),
      attempts: target.state.attempts + (options.oneShot ? 1 : 0),
      ...(options.oneShot ? {
        stage: target.stage,
        startedAt: timestamp,
        startFingerprint: currentFingerprint,
      } : {}),
    };
    return {
      ...updateTarget(workflow, target, failedState),
      status: options.cancelFailed ? "cancel_failed" : "incomplete",
      phase: target.stage,
      failureReason: reason,
      failureDetail,
      ...enterIncomplete(workflow),
      branchAttempts: options.oneShot
        ? appendBranchAttempt(
            {
              ...workflow,
              branchAttempts: appendBranchAttempt(
                workflow, target, "started", "running", timestamp,
                { fingerprint: currentFingerprint }
              ),
            },
            { ...target, state: failedState },
            "failed", status, timestamp, { failureReason: reason, failureDetail }
          )
        : appendBranchAttempt(
            workflow, target, "failed", status, timestamp, { failureReason: reason, failureDetail }
          ),
    };
  });
  if (violated) {
    throw workflowError("SAFETY_VIOLATION", "Workspace changed while a worker was running.", next);
  }
  return next;
}

export function reconcilePeerRetry(cwd, workflowId, options, linkedJobs = []) {
  let workflow = readWorkflow(cwd, workflowId, options);
  if (!workflow) {
    throw workflowError("WORKFLOW_NOT_FOUND", `No workflow found for ${workflowId}.`);
  }
  assertCas(workflow, options);
  if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
    return { workflow, retryTargets: [] };
  }
  const claudeJobs = (Array.isArray(linkedJobs) ? linkedJobs : []).filter(
    (job) => job?.workflowId === workflow.id && job?.workflowStage === "memo"
  );
  const latestClaudeJob = claudeJobs.reduce((latest, job) => {
    if (!latest) return job;
    const jobCreatedAt = Date.parse(job.createdAt ?? "");
    const latestCreatedAt = Date.parse(latest.createdAt ?? "");
    return Number.isFinite(jobCreatedAt) &&
      (!Number.isFinite(latestCreatedAt) || jobCreatedAt > latestCreatedAt)
      ? job
      : latest;
  }, null);
  const activeClaudeWaiter = Boolean(
    latestClaudeJob &&
    ACTIVE_LINKED_JOB_STATUSES.has(latestClaudeJob.status) &&
    !latestClaudeJob.reapedBy &&
    latestClaudeJob.reapedUnverifiable !== true
  );
  const claudeCancellationFailed = latestClaudeJob?.status === "cancel_failed";
  const preserveClaudeWaiter = Boolean(
    workflow.branches?.claude?.status === "running" &&
    workflow.branches.claude.commitment &&
    activeClaudeWaiter
  );
  /** @type {Array<{stage: string, branchId?: string}>} */
  const invalidatedTargets = [
    ...Object.entries(workflow.branches ?? {}).flatMap(([branchId, state]) =>
      state.status === "running" && !(branchId === "claude" && preserveClaudeWaiter)
        ? [{ stage: state.stage ?? "memo", branchId }]
        : []
    ),
    ...Object.entries(workflow.stages ?? {}).flatMap(([stage, state]) =>
      state.status === "running" ? [{ stage }] : []
    ),
  ];
  if (
    claudeCancellationFailed &&
    workflow.branches?.claude &&
    !["running", "completed", "cancel_failed"].includes(workflow.branches.claude.status)
  ) {
    invalidatedTargets.push({ stage: workflow.branches.claude.stage ?? "memo", branchId: "claude" });
  }
  if (invalidatedTargets.length > 0 || claudeCancellationFailed) {
    workflow = mutateWorkflow(cwd, workflowId, options, (current, timestamp) => {
      let next = current;
      for (const { stage, branchId } of invalidatedTargets) {
        const target = targetState(next, stage, branchId);
        const cancelFailed = branchId === "claude" && claudeCancellationFailed;
        const status = cancelFailed ? "cancel_failed" : "retryable_failed";
        const failureReason = cancelFailed ? "CANCEL_FAILED" : "EXPLICIT_RETRY";
        const branchAttempts = target.state.status === "running"
          ? appendBranchAttempt(
              next,
              target,
              "failed",
              status,
              timestamp,
              { failureReason }
            )
          : next.branchAttempts;
        next = {
          ...updateTarget(
            next,
            target,
            invalidatedTargetState(target.state, status, failureReason, timestamp)
          ),
          branchAttempts,
        };
      }
      return {
        ...next,
        status: claudeCancellationFailed ? "cancel_failed" : "incomplete",
        phase: claudeCancellationFailed ? "cancel_failed" : current.phase,
        failureReason: claudeCancellationFailed ? "CANCEL_FAILED" : "EXPLICIT_RETRY",
        failureDetail: null,
        ...(claudeCancellationFailed ? {} : enterIncomplete(current)),
      };
    });
  }
  if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
    return { workflow, retryTargets: [] };
  }
  const retryable = (target) => ["pending", "retryable_failed"].includes(target?.status);
  /** @type {Array<{stage: string, branchId?: string}>} */
  const retryTargets = ["codex", "claude"]
    .filter((branchId) => retryable(workflow.branches?.[branchId]))
    .map((branchId) => ({ stage: "memo", branchId }));
  if (retryTargets.length > 0) {
    if (retryable(workflow.stages?.checkpoint)) retryTargets.push({ stage: "checkpoint" });
    return { workflow, retryTargets };
  }
  if (retryable(workflow.stages?.checkpoint)) {
    return { workflow, retryTargets: [{ stage: "checkpoint" }] };
  }
  if (workflow.stages?.feedback?.status === "completed" && retryable(workflow.stages?.critique)) {
    retryTargets.push({ stage: "critique" });
    if (retryable(workflow.stages?.synthesis)) retryTargets.push({ stage: "synthesis" });
    return { workflow, retryTargets };
  }
  if (workflow.stages?.critique?.status === "completed" && retryable(workflow.stages?.synthesis)) {
    retryTargets.push({ stage: "synthesis" });
  }
  return { workflow, retryTargets };
}

export function getWorkflowRetryContext(cwd, workflowId, options = {}) {
  const workflow = readWorkflow(cwd, workflowId, options);
  if (!workflow) {
    throw workflowError("WORKFLOW_NOT_FOUND", `No workflow found for ${workflowId}.`);
  }
  if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
    return {
      workflowId: workflow.id,
      mode: workflow.mode,
      revision: workflow.revision,
      epoch: workflow.epoch,
      claudeSessionId: workflow.claudeSessionId,
      stages: [],
      branches: [],
      hasRetryWork: false,
    };
  }
  const requiredStages = normalizedNames(
    options.requiredStages ?? Object.keys(workflow.stages ?? {}),
    "workflow stage"
  );
  const requiredBranches = normalizedNames(
    options.requiredBranches ?? Object.keys(workflow.branches ?? {}),
    "workflow branch ID"
  );
  const select = (names, items, keyName) => names.flatMap((name) => {
    const item = items?.[name];
    if (!item) {
      return [{ [keyName]: name, status: "missing", failureReason: null, failureDetail: null }];
    }
    if (!RETRYABLE_STATUSES.has(item.status)) {
      return [];
    }
    return [{
      [keyName]: name,
      status: item.status,
      failureReason: item.failureReason ?? null,
      failureDetail: normalizeWorkflowFailureDetail(item.failureDetail),
    }];
  });
  const stages = select(requiredStages, workflow.stages, "stage");
  const branches = select(requiredBranches, workflow.branches, "branchId");
  return {
    workflowId: workflow.id,
    mode: workflow.mode,
    revision: workflow.revision,
    epoch: workflow.epoch,
    claudeSessionId: workflow.claudeSessionId,
    stages,
    branches,
    hasRetryWork: stages.length > 0 || branches.length > 0,
  };
}

export function rebindWorkflowOwner(cwd, workflowId, options) {
  const currentOwnerSessionId = sanitizeId(
    options.currentOwnerSessionId,
    "current owner session ID"
  );
  return mutateWorkflow(cwd, workflowId, options, (workflow, timestamp) => {
    if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
      throw workflowError("WORKFLOW_TERMINAL", `Workflow ${workflow.id} is ${workflow.status}.`);
    }
    let invalidated = false;
    let onlyUnactivatedRetries = true;
    const invalidate = (items) => Object.fromEntries(Object.entries(items ?? {}).map(([key, item]) => {
      if (!hasUnfinishedAttempt(item)) return [key, item];
      invalidated = true;
      const preserveFailure = hasUnactivatedRetryReservation(item);
      onlyUnactivatedRetries &&= preserveFailure;
      return [key, invalidatedTargetState(
        item,
        "retryable_failed",
        preserveFailure ? item.failureReason : "OWNER_REBOUND",
        timestamp,
        preserveFailure ? item.failureDetail : null
      )];
    }));
    return {
      ...workflow,
      currentOwnerSessionId,
      epoch: workflow.epoch + 1,
      branches: invalidate(workflow.branches),
      stages: invalidate(workflow.stages),
      ...(invalidated ? {
        status: "incomplete",
        failureReason: onlyUnactivatedRetries ? workflow.failureReason : "OWNER_REBOUND",
        failureDetail: onlyUnactivatedRetries
          ? normalizeWorkflowFailureDetail(workflow.failureDetail)
          : null,
        ...enterIncomplete(workflow),
      } : {}),
    };
  });
}

export function reserveWorkflowCancellation(cwd, workflowId, options) {
  const lease = newLease();
  const workflow = mutateWorkflow(cwd, workflowId, options, (current, timestamp) => {
    if (TERMINAL_WORKFLOW_STATUSES.has(current.status)) {
      throw workflowError("WORKFLOW_TERMINAL", `Workflow ${current.id} is ${current.status}.`);
    }
    return {
      ...current,
      epoch: current.epoch + 1,
      cancellation: {
        leaseDigest: leaseDigest(lease),
        reservedAt: timestamp,
      },
    };
  });
  return { workflow, lease };
}

export function completeWorkflowCancellation(cwd, workflowId, options) {
  const failedJobIds = normalizedNames(options.failedJobIds ?? [], "linked job ID");
  return mutateWorkflow(cwd, workflowId, options, (workflow, timestamp) => {
    if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
      throw workflowError("WORKFLOW_TERMINAL", `Workflow ${workflow.id} is ${workflow.status}.`);
    }
    if (
      !workflow.cancellation?.leaseDigest ||
      typeof options.lease !== "string" ||
      workflow.cancellation.leaseDigest !== leaseDigest(options.lease)
    ) {
      throw workflowError("STALE_CANCELLATION", "Cancellation lease is stale.");
    }
    const invalidate = (items) => Object.fromEntries(Object.entries(items ?? {}).map(([key, item]) => {
      if (item.status === "completed") return [key, item];
      const cancellationFailed = failedJobIds.length > 0 || item.status === "cancel_failed";
      return [key, invalidatedTargetState(
        item,
        cancellationFailed ? "cancel_failed" : "retryable_failed",
        cancellationFailed ? "CANCEL_FAILED" : "CANCELLED",
        timestamp
      )];
    }));
    return {
      ...workflow,
      branches: invalidate(workflow.branches),
      stages: invalidate(workflow.stages),
      status: failedJobIds.length > 0 ? "cancel_failed" : "cancelled",
      phase: failedJobIds.length > 0 ? "cancel_failed" : "cancelled",
      failureReason: failedJobIds.length > 0 ? "CANCEL_FAILED" : null,
      failureDetail: null,
      cancelFailedJobIds: failedJobIds,
      cancellation: {
        ...workflow.cancellation,
        completedAt: timestamp,
      },
      completedAt: timestamp,
    };
  });
}

export function completeWorkflowSessionEnd(cwd, workflowId, options) {
  const cancelFailedTargets = new Set(options.cancelFailedTargets ?? []);
  return mutateWorkflow(cwd, workflowId, options, (workflow, timestamp) => {
    if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
      throw workflowError("WORKFLOW_TERMINAL", `Workflow ${workflow.id} is ${workflow.status}.`);
    }
    if (
      !workflow.cancellation?.leaseDigest ||
      typeof options.lease !== "string" ||
      workflow.cancellation.leaseDigest !== leaseDigest(options.lease)
    ) {
      throw workflowError("STALE_CANCELLATION", "SessionEnd lease is stale.");
    }
    let changed = false;
    let cancellationFailed = false;
    let onlyUnactivatedRetries = true;
    const finalize = (items, kind) => Object.fromEntries(Object.entries(items ?? {}).map(([key, item]) => {
      if (!hasUnfinishedAttempt(item)) return [key, item];
      changed = true;
      const failed = cancelFailedTargets.has(`${kind}:${key}`);
      cancellationFailed ||= failed;
      const preserveFailure = !failed && hasUnactivatedRetryReservation(item);
      onlyUnactivatedRetries &&= preserveFailure;
      return [key, invalidatedTargetState(
        item,
        failed ? "cancel_failed" : "retryable_failed",
        failed
          ? "SESSION_END_CANCEL_FAILED"
          : preserveFailure ? item.failureReason : "SESSION_ENDED",
        timestamp,
        preserveFailure ? item.failureDetail : null
      )];
    }));
    return {
      ...workflow,
      branches: finalize(workflow.branches, "branch"),
      stages: finalize(workflow.stages, "stage"),
      ...(changed ? {
        status: cancellationFailed ? "cancel_failed" : "incomplete",
        phase: cancellationFailed ? "cancel_failed" : workflow.phase,
        failureReason: cancellationFailed
          ? "SESSION_END_CANCEL_FAILED"
          : onlyUnactivatedRetries ? workflow.failureReason : "SESSION_ENDED",
        failureDetail: cancellationFailed || !onlyUnactivatedRetries
          ? null
          : normalizeWorkflowFailureDetail(workflow.failureDetail),
        ...(cancellationFailed ? {} : enterIncomplete(workflow)),
      } : {}),
      cancellation: {
        ...workflow.cancellation,
        completedAt: timestamp,
      },
    };
  });
}

export function workflowNotificationEvent(workflow) {
  if (workflow.status === "awaiting_user" && workflow.checkpoint) return "checkpoint";
  if (workflow.status === "incomplete") return `incomplete:${workflow.incompleteGeneration ?? 1}`;
  if (workflow.status === "completed" && workflow.finalResult) return "completed";
  return null;
}

export function markWorkflowNotification(cwd, workflowId, options) {
  const event = String(options.event ?? "").trim();
  if (!event) throw workflowError("INVALID_NOTIFICATION_EVENT", "Notification event is required.");
  const field = options.viewed ? "viewedEvents" : "notifiedEvents";
  return mutateWorkflow(cwd, workflowId, options, (workflow) => {
    if (workflowNotificationEvent(workflow) !== event) {
      throw workflowError("STALE_MILESTONE", `Workflow milestone ${event} is no longer current.`);
    }
    return {
      ...workflow,
      [field]: [...new Set([...(workflow[field] ?? []), event])],
    };
  });
}

export function cleanupOldWorkflows(cwd) {
  const workflows = listWorkflows(cwd);
  const terminal = workflows.filter((workflow) => TERMINAL_WORKFLOW_STATUSES.has(workflow.status));
  for (const workflow of terminal.slice(MAX_TERMINAL_WORKFLOWS)) {
    try {
      fs.unlinkSync(resolveWorkflowFile(cwd, workflow.id));
    } catch {}
  }
}
