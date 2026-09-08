/** Copyright 2026 Sendbird, Inc. SPDX-License-Identifier: Apache-2.0 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildPeerWaitView, isPeerWorkflow } from "./peer-orchestration.mjs";

export const PUBLIC_READ_BYTES = 8192;
const PRIVATE_FIELDS = new Set(["logFile", "lease", "leases", "leaseDigest"]);
const SUMMARY_PAYLOAD_FIELDS = new Set([
  "result", "rendered", "payload", "memos", "checkpoint", "critique", "finalResult",
  "feedback", "attemptHistory", "attemptReservation", "history", "brief", "toolManifest",
]);

// Apply authorization before either previewing or exporting, including historical records.
/** @param {any} value @param {(id: string, workspaceRoot?: string) => any} [lookupWorkflow] */
export function publicReadPayload(value, lookupWorkflow = () => null) {
  if (Array.isArray(value)) return value.map((item) => publicReadPayload(item, lookupWorkflow));
  if (!value || typeof value !== "object") return value;
  if (value.id && !value.workflowId && isPeerWorkflow(value)) {
    const wait = buildPeerWaitView(value);
    value = value.branches.codex.status !== "completed"
      ? { id: value.id, ...wait }
      : { ...value, readyForCheckpoint: wait.readyForCheckpoint, terminalIncomplete: wait.terminalIncomplete };
  } else if (value.workflowId && value.id) {
    const workflow = lookupWorkflow(value.workflowId, value.workspaceRoot);
    if (isPeerWorkflow(workflow) && workflow.branches.codex.status !== "completed") {
      // Old linked job records may contain sibling output in arbitrary text fields.
      value = Object.fromEntries(["id", "workflowId", "status", "phase", "kind", "jobClass", "workspaceRoot"]
        .filter((key) => key in value).map((key) => [key, value[key]]));
    }
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_FIELDS.has(key))
    .map(([key, item]) => [key, publicReadPayload(item, lookupWorkflow)]));
}

function project(value, omissions, limits, summary, location = "", depth = 0) {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) <= limits.string) return value;
    let end = Math.min(value.length, limits.string);
    while (Buffer.byteLength(value.slice(0, end)) > limits.string) end--;
    if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1])) end--;
    omissions.strings++;
    return value.slice(0, end) + "…";
  }
  if (!value || typeof value !== "object") return value;
  if (depth > 12) { omissions.fields++; return null; }
  if (Array.isArray(value)) {
    omissions.records += Math.max(0, value.length - limits.items);
    return value.slice(0, limits.items).map((item, index) => project(item, omissions, limits, summary, `${location}[${index}]`, depth + 1));
  }
  if (summary && /\.branches\.(codex|claude)$/u.test(location) && value.payload) {
    const payload = value.payload;
    value = { ...value,
      evidenceCounts: { repo: payload.repoCitations?.length ?? 0, web: payload.webCitations?.length ?? 0, tools: payload.toolEvents?.length ?? 0 },
      ...(payload.model ? { model: payload.model } : {}),
    };
  }
  const entries = Object.entries(value);
  const result = {};
  for (const [key, item] of entries) {
    if (summary && !location.endsWith(".stages") && SUMMARY_PAYLOAD_FIELDS.has(key) && item != null) {
      omissions.fields++;
      if (Array.isArray(item)) omissions.records += item.length;
      if (!omissions.fieldNames.includes(key)) omissions.fieldNames.push(key);
      continue;
    }
    result[key] = project(item, omissions, limits, summary, `${location}.${key}`, depth + 1);
  }
  return result;
}

export function boundedReadView(payload, { summary = false, render = null, asJson = true } = {}) {
  const source = Array.isArray(payload) ? { workflows: payload, total: payload.length } : payload;
  let limits = { string: Infinity, items: Infinity };
  while (true) {
    const omissions = { fields: 0, fieldNames: [], records: (source.omittedJobs ?? 0) + (source.omittedWorkflows ?? 0), strings: 0 };
    const projected = project(source, omissions, limits, summary);
    const truncated = omissions.fields + omissions.records + omissions.strings > 0;
    const view = { ...projected, truncated, omissions,
      ...(truncated ? { nextStep: "Use --output <new-path> for the complete public JSON payload." } : {}) };
    const json = JSON.stringify(view, null, 2) + "\n";
    if (Buffer.byteLength(json) <= PUBLIC_READ_BYTES) {
      let text = json;
      if (!asJson && render) {
        text = render(projected);
        if (truncated) text = text.trimEnd() + `\n\nTruncated: ${JSON.stringify(omissions)}\n${view.nextStep}\n`;
        if (Buffer.byteLength(text) > PUBLIC_READ_BYTES) text = json;
      }
      return { view, text, complete: !truncated };
    }
    // Shrink values before serialization; JSON is never cut mid-token.
    limits = limits.string === Infinity ? { string: 512, items: 8 }
      : { string: Math.floor(limits.string / 2), items: Math.floor(limits.items / 2) };
    if (limits.string === 0 && limits.items === 0) {
      // An unusually wide historical object can exceed the cap even with empty values.
      const view = { truncated: true, omissions: { fields: Object.keys(source).length, records: Array.isArray(payload) ? payload.length : 0 }, nextStep: "Use --output <new-path> for the complete public JSON payload." };
      return { view, text: JSON.stringify(view, null, 2) + "\n", complete: false };
    }
  }
}

export function exportReadPayload(payload, outputPath) {
  const outputFile = path.resolve(outputPath);
  const bytes = Buffer.from(JSON.stringify(payload, null, 2) + "\n", "utf8");
  const fd = fs.openSync(outputFile, "wx", 0o600);
  const created = fs.fstatSync(fd);
  try {
    fs.writeFileSync(fd, bytes);
    fs.closeSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    try {
      const current = fs.lstatSync(outputFile);
      if (current.dev === created.dev && current.ino === created.ino) fs.unlinkSync(outputFile);
    } catch {}
    throw error;
  }
  return { outputFile, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
