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

const WORKFLOWS_DIR_NAME = "workflows";
const TERMINAL_WORKFLOW_STATUSES = new Set([
  "completed",
  "cancelled",
  "cancel_failed",
]);
const RETRYABLE_STATUSES = new Set([
  "pending",
  "retryable_failed",
  "cancel_failed",
]);
const TOP_LEVEL_PAYLOAD_FIELDS = new Set([
  "checkpoint",
  "feedback",
  "critique",
  "finalResult",
]);
const SENSITIVE_MANIFEST_KEY = /(?:api[-_]?key|authorization|credential|env|headers?|mcpServers|password|rawConfig|secret|token)/iu;

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

function assertSecretFreeManifest(value, label) {
  const visit = (current) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      if (SENSITIVE_MANIFEST_KEY.test(key)) {
        throw workflowError(
          "SECRET_BEARING_MANIFEST",
          `${label} contains a secret-bearing field: ${key}`
        );
      }
      visit(child);
    }
  };
  visit(value);
  try {
    return JSON.parse(JSON.stringify(value ?? []));
  } catch {
    throw workflowError("INVALID_MANIFEST", `${label} must be JSON serializable.`);
  }
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
  if (workflow.epoch !== options.epoch) {
    throw workflowError(
      "STALE_EPOCH",
      `Expected epoch ${options.epoch}, found ${workflow.epoch}.`
    );
  }
}

function mutateWorkflow(cwd, workflowId, options, reducer) {
  const workspaceRoot = canonicalWorkspaceRoot(cwd);
  const filePath = resolveWorkflowFile(workspaceRoot, workflowId);
  return withStateFileLock(filePath, () => {
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
    return next;
  });
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
    return { collection: "branches", key: safeBranchId, state: branch, stage: safeStage };
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
  const modelManifest = assertSecretFreeManifest(input?.modelManifest ?? [], "model manifest");
  const toolManifest = assertSecretFreeManifest(input?.toolManifest ?? [], "tool manifest");
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

export function casStartWorkflowStage(cwd, workflowId, options) {
  const currentFingerprint = getWorkingTreeFingerprint(cwd);
  let drifted = false;
  const next = mutateWorkflow(cwd, workflowId, options, (workflow, timestamp) => {
    if (!sameFingerprint(workflow.fingerprint, currentFingerprint)) {
      drifted = true;
      return {
        ...workflow,
        status: "incomplete",
        phase: options.stage,
        failureReason: "STALE_WORKSPACE",
      };
    }
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
    const attempts = target.state.attempts + 1;
    const startedState = {
      ...target.state,
      status: "running",
      stage: target.stage,
      attempts,
      failureReason: null,
      startedAt: timestamp,
      startFingerprint: currentFingerprint,
    };
    return {
      ...updateTarget(workflow, target, startedState),
      status: "running",
      phase: target.stage,
      failureReason: null,
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

export function submitWorkflowStage(cwd, workflowId, options) {
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
    const target = targetState(workflow, options.stage, options.branchId);
    if (target.state.status === "completed") {
      throw workflowError("COMPLETED_STAGE_IMMUTABLE", `${target.key} is already completed.`);
    }
    if (target.state.status !== "running") {
      throw workflowError("STAGE_NOT_RUNNING", `${target.key} is not running.`);
    }
    if (!sameFingerprint(target.state.startFingerprint, currentFingerprint)) {
      violated = true;
      const failedState = {
        ...target.state,
        status: "retryable_failed",
        failureReason: "SAFETY_VIOLATION",
        completedAt: timestamp,
      };
      return {
        ...updateTarget(workflow, target, failedState),
        status: "incomplete",
        phase: target.stage,
        failureReason: "SAFETY_VIOLATION",
        branchAttempts: appendBranchAttempt(
          workflow,
          target,
          "failed",
          "retryable_failed",
          timestamp,
          { failureReason: "SAFETY_VIOLATION", fingerprint: currentFingerprint }
        ),
      };
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
    const completedState = {
      ...target.state,
      status: "completed",
      payload,
      failureReason: null,
      completedAt: timestamp,
    };
    const status = options.status ?? (options.field === "finalResult" ? "completed" : "running");
    const phase = options.phase ?? (status === "completed" ? "done" : target.stage);
    return {
      ...updateTarget(workflow, target, completedState),
      status,
      phase,
      fingerprint: currentFingerprint,
      failureReason: null,
      ...(options.field ? { [options.field]: payload } : {}),
      ...(options.claudeSessionId ? { claudeSessionId: options.claudeSessionId } : {}),
      ...(status === "completed" ? { completedAt: timestamp } : {}),
      branchAttempts: appendBranchAttempt(
        workflow,
        target,
        "completed",
        "completed",
        timestamp,
        { payload }
      ),
    };
  });
  if (violated) {
    throw workflowError("SAFETY_VIOLATION", "Workspace changed while a worker was running.", next);
  }
  if (TERMINAL_WORKFLOW_STATUSES.has(next.status)) {
    cleanupOldWorkflows(cwd);
  }
  return next;
}

export function markWorkflowBranchFailure(cwd, workflowId, options) {
  const status = assertBranchStatus(options.cancelFailed ? "cancel_failed" : "retryable_failed");
  const reason = String(options.reason ?? "").trim();
  if (!reason) {
    throw workflowError("INVALID_FAILURE_REASON", "A branch failure reason is required.");
  }
  return mutateWorkflow(cwd, workflowId, options, (workflow, timestamp) => {
    const target = targetState(workflow, options.stage, options.branchId);
    if (target.state.status === "completed") {
      throw workflowError("COMPLETED_STAGE_IMMUTABLE", `${target.key} is already completed.`);
    }
    if (target.state.status !== "running") {
      throw workflowError("STAGE_NOT_RUNNING", `${target.key} is not running.`);
    }
    const failedState = {
      ...target.state,
      status,
      failureReason: reason,
      completedAt: timestamp,
    };
    return {
      ...updateTarget(workflow, target, failedState),
      status: options.cancelFailed ? "cancel_failed" : "incomplete",
      phase: target.stage,
      failureReason: reason,
      branchAttempts: appendBranchAttempt(
        workflow,
        target,
        "failed",
        status,
        timestamp,
        { failureReason: reason }
      ),
    };
  });
}

export function getWorkflowRetryContext(cwd, workflowId, options = {}) {
  const workflow = readWorkflow(cwd, workflowId, options);
  if (!workflow) {
    throw workflowError("WORKFLOW_NOT_FOUND", `No workflow found for ${workflowId}.`);
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
      return [{ [keyName]: name, status: "missing", failureReason: null }];
    }
    if (!RETRYABLE_STATUSES.has(item.status)) {
      return [];
    }
    return [{
      [keyName]: name,
      status: item.status,
      failureReason: item.failureReason ?? null,
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
  return mutateWorkflow(cwd, workflowId, options, (workflow) => ({
    ...workflow,
    currentOwnerSessionId,
    epoch: workflow.epoch + 1,
  }));
}

export function completeWorkflowCancellation(cwd, workflowId, options) {
  const failedJobIds = normalizedNames(options.failedJobIds ?? [], "linked job ID");
  const next = mutateWorkflow(cwd, workflowId, options, (workflow, timestamp) => ({
    ...workflow,
    status: failedJobIds.length > 0 ? "cancel_failed" : "cancelled",
    phase: failedJobIds.length > 0 ? "cancel_failed" : "cancelled",
    failureReason: failedJobIds.length > 0 ? "CANCEL_FAILED" : null,
    cancelFailedJobIds: failedJobIds,
    completedAt: timestamp,
  }));
  cleanupOldWorkflows(cwd);
  return next;
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
