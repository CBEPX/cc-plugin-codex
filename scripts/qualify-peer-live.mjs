/**
 * Copyright 2026 CBEPX contributors.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { readWorkflow } from "./lib/workflows.mjs";
import { getWorkingTreeFingerprint } from "./lib/git.mjs";
import { validatePeerMemo, PEER_CLAUDE_ALLOWED_BASE_TOOLS } from "./lib/peer-orchestration.mjs";

const BRAVE = ["mcp__brave-search__brave_web_search", "mcp__brave-search__brave_llm_context"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
function requireEvidence(condition, message) {
  if (!condition) throw new Error(`QUALIFICATION_FAILED: ${message}`);
}

/** Inventory every entry, including ignored files. Never follow symlinks. */
export function inventoryWorkspace(workspace) {
  const entries = [];
  function visit(relative) {
    const file = path.join(workspace, relative);
    const stat = fs.lstatSync(file);
    const entry = { path: relative, mode: stat.mode & 0o7777 };
    if (stat.isSymbolicLink()) entries.push({ ...entry, type: "symlink", target: fs.readlinkSync(file) });
    else if (stat.isFile()) entries.push({ ...entry, type: "file", sha256: hash(fs.readFileSync(file)) });
    else if (stat.isDirectory()) {
      entries.push({ ...entry, type: "directory" });
      for (const name of fs.readdirSync(file).sort()) visit(relative === "." ? name : `${relative}/${name}`);
    } else throw new Error("QUALIFICATION_FAILED: unsupported workspace entry type");
  }
  visit(".");
  return entries;
}

/** Compare shipped runtime files with a local immutable Git revision. No remote lookup. */
export function verifyRuntimeIdentity({ sourceRepo, runtimeRoot, revision, mode }) {
  requireEvidence(mode === "installed" || mode === "candidate", "mode must be installed or candidate");
  requireEvidence(typeof revision === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(revision), "invalid revision");
  requireEvidence(mode !== "candidate" || /^[a-f0-9]{40}$/.test(revision), "candidate revision must be an exact commit ID");
  const git = (...args) => execFileSync("git", args, { cwd: sourceRepo, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
  const ref = mode === "installed" ? `refs/tags/${revision}` : revision;
  let commit;
  try { commit = git("rev-parse", "--verify", `${ref}^{commit}`).toString().trim(); }
  catch { throw new Error("QUALIFICATION_FAILED: revision or local installed tag not found"); }
  const packageBytes = git("show", `${commit}:package.json`);
  const pkg = JSON.parse(packageBytes.toString());
  requireEvidence(Array.isArray(pkg.files) && pkg.files.length > 0, "package file list missing");
  requireEvidence(pkg.files.every((prefix) => typeof prefix === "string" && /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*|\.[A-Za-z0-9_-][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/.test(prefix)), "unsupported shipped path prefix");
  const shipped = ["package.json", ...pkg.files];
  const names = git("ls-tree", "-r", "--name-only", "-z", commit).toString().split("\0").filter(Boolean)
    .filter((name) => shipped.some((prefix) => name === prefix || name.startsWith(`${prefix}/`)));
  const expectedFiles = new Set(names);
  const expectedDirectories = new Set();
  for (const name of names) {
    for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) expectedDirectories.add(parent);
  }
  for (const prefix of new Set(shipped)) {
    const root = path.join(runtimeRoot, prefix);
    if (!fs.existsSync(root)) continue; // Missing expected files are rejected below.
    for (const entry of inventoryWorkspace(root)) {
      const name = entry.path === "." ? prefix : `${prefix}/${entry.path}`;
      requireEvidence(entry.type === "file" ? expectedFiles.has(name) : entry.type === "directory" && expectedDirectories.has(name), "unexpected runtime entry in shipped paths");
    }
  }
  const files = [];
  for (const name of names) {
    const file = path.join(runtimeRoot, name);
    requireEvidence(fs.existsSync(file) && fs.lstatSync(file).isFile(), "runtime file missing or symlink");
    const expected = hash(git("show", `${commit}:${name}`));
    requireEvidence(hash(fs.readFileSync(file)) === expected, "runtime byte mismatch");
    files.push([name, expected]);
  }
  for (const kind of ["design", "research", "critique"]) {
    const name = `schemas/peer-${kind}-output.schema.json`;
    requireEvidence(names.includes(name), "native peer schema is not pinned");
    const schema = JSON.parse(fs.readFileSync(path.join(runtimeRoot, name), "utf8"));
    requireEvidence(schema.$schema === "http://json-schema.org/draft-07/schema#" && schema.type === "object", "native peer schema must use Draft-07");
  }
  return { mode, revision, commit, version: pkg.version, schemaDialect: "draft-07", fileCount: files.length, filesSha256: hash(JSON.stringify(files)) };
}

/** Verify accepted peer records; return bounded evidence without memo or advice content. */
export function verifyPeerEvidence(workflow) {
  requireEvidence(["design", "research"].includes(workflow?.mode), "unsupported peer mode");
  requireEvidence(workflow.status === "completed", "workflow is not completed");
  const attempts = { codex: workflow.branches?.codex?.attempts, claude: workflow.branches?.claude?.attempts, critique: workflow.stages?.critique?.attempts };
  requireEvidence(Object.values(attempts).every((count) => count === 1), "qualification requires one attempt per native stage and memo");
  requireEvidence(Array.isArray(workflow.branchAttempts) && workflow.branchAttempts.every((entry) => ["running", "completed"].includes(entry.status)), "workflow contains failed attempt history");
  requireEvidence(!workflow.failureReason && !workflow.failureDetail && [...Object.values(workflow.branches ?? {}), ...Object.values(workflow.stages ?? {})].every((stage) => !stage.failureReason && !stage.failureDetail), "workflow contains failure evidence");
  const selected = (workflow.toolManifest ?? []).map(({ toolId }) => toolId);
  requireEvidence(BRAVE.every((tool) => selected.includes(tool)), "both exact Brave tools must be in the frozen manifest");
  const allowed = new Set([...PEER_CLAUDE_ALLOWED_BASE_TOOLS, ...selected, "ToolSearch", "StructuredOutput"]);
  for (const role of ["codex", "claude"]) {
    const branch = workflow.branches?.[role];
    requireEvidence(branch?.status === "completed", `${role} memo is incomplete`);
    validatePeerMemo(workflow, branch.payload, { role });
  }
  const memo = workflow.branches.claude.payload;
  requireEvidence(BRAVE.every((tool) => memo.toolEvents.some((event) => event.tool === tool)), "both exact Brave tool events are required");
  const critique = workflow.stages?.critique;
  requireEvidence(critique?.status === "completed" && critique.payload?.content && Object.keys(critique.payload.content).length > 0, "critique is incomplete");
  const models = [];
  const advisorPolicy = workflow.modelManifest?.find((entry) => entry.role === "claude-advisor");
  for (const payload of [memo, critique.payload]) {
    requireEvidence(Array.isArray(payload.toolEvents) && payload.toolEvents.every(({ tool }) => allowed.has(tool)), "unselected tool event");
    const model = payload.model;
    requireEvidence(model && typeof model.requestedModel === "string" && typeof model.finalModel === "string" && model.finalModel.length > 0 && model.finalModel.length <= 160, "model evidence missing");
    requireEvidence(model.requestedModel === workflow.modelManifest?.find((entry) => entry.role === "claude")?.requestedModel, "requested model differs from frozen manifest");
    requireEvidence(/^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(model.requestedModel) && model.requestedModel === model.finalModel, "qualification requires an exact Claude model ID matching the actual model");
    requireEvidence(Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0, "model context evidence missing");
    requireEvidence(Array.isArray(model.modelFallbacks) && model.modelFallbacks.length === 0, "model fallback needs separate qualification");
    let advisor;
    if (advisorPolicy) {
      const observation = model.advisor;
      requireEvidence(typeof observation?.requested === "string" && observation.requested.length <= 160 && observation.requested === (advisorPolicy.requestedModel ?? "inherit"), "advisor policy evidence missing or differs from frozen manifest");
      requireEvidence(Number.isSafeInteger(observation.calls) && observation.calls >= 0 && observation.countExact === true && observation.observedModel === null && observation.status === (observation.calls > 0 ? "observed" : "not_observed") && (observation.requested !== "off" || observation.calls === 0), "advisor observations incomplete or contradictory");
      advisor = { requested: observation.requested, calls: observation.calls, countExact: observation.countExact, observedModel: null, status: observation.status };
    }
    models.push({ requestedModel: model.requestedModel.slice(0, 160), finalModel: model.finalModel, contextWindow: model.contextWindow, fallbackCount: 0, ...(advisor ? { advisor } : {}) });
  }
  return { id: workflow.id, mode: workflow.mode, epoch: workflow.epoch, revision: workflow.revision, attempts, memoModel: models[0], critiqueModel: models[1], braveTools: BRAVE, repoCitationCount: memo.repoCitations.length, webCitationCount: memo.webCitations.length, failure: null, nativeOutputEvidence: "accepted-by-pinned-peer-parser" };
}

function outsideOutput(output, workspace) {
  requireEvidence(typeof output === "string" && output.length > 0, "output path required");
  const file = path.join(fs.realpathSync(path.dirname(path.resolve(output))), path.basename(output));
  const relative = path.relative(workspace, file);
  requireEvidence(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "output must be outside workspace");
  return file;
}
function manifestHash(workflow) {
  return hash(JSON.stringify([workflow.modelManifest, workflow.toolManifest]));
}
function saveReport(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

/** Manual capture/verify gate. It never starts a model or changes runtime settings. */
export function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    live: { type: "boolean" }, workspace: { type: "string" }, "runtime-root": { type: "string" },
    "source-repo": { type: "string" }, revision: { type: "string" }, mode: { type: "string" },
    "workflow-id": { type: "string" }, output: { type: "string" }, baseline: { type: "string" },
  } });
  requireEvidence(values.live === true, "explicit --live opt-in is required");
  requireEvidence(positionals.length === 1, "use capture or verify");
  if (positionals[0] === "capture") {
    const workspace = fs.realpathSync(values.workspace);
    requireEvidence(fs.lstatSync(path.join(workspace, ".git")).isFile(), "use a disposable linked worktree");
    const output = outsideOutput(values.output, workspace);
    const runtimeOptions = { sourceRepo: fs.realpathSync(values["source-repo"]), runtimeRoot: fs.realpathSync(values["runtime-root"]), revision: values.revision, mode: values.mode };
    const runtime = verifyRuntimeIdentity(runtimeOptions);
    const workflow = readWorkflow(workspace, values["workflow-id"]);
    requireEvidence(workflow && ["design", "research"].includes(workflow.mode), "peer workflow missing");
    requireEvidence(Object.values(workflow.branches).every((branch) => branch.attempts === 0), "capture before any memo starts");
    // Warm Git's index cache before inventory, as the peer's first read will do.
    getWorkingTreeFingerprint(workspace);
    const baseline = { schema: 1, workspace, runtimeOptions, runtime, workflowId: workflow.id, epoch: workflow.epoch, revision: workflow.revision, createdAt: workflow.createdAt, manifestSha256: manifestHash(workflow), inventory: inventoryWorkspace(workspace) };
    saveReport(output, baseline);
    return { captured: true, output, mode: runtime.mode, commit: runtime.commit };
  }
  requireEvidence(positionals[0] === "verify", "use capture or verify");
  const baseline = JSON.parse(fs.readFileSync(values.baseline, "utf8"));
  requireEvidence(baseline.schema === 1, "unsupported baseline");
  const workspace = fs.realpathSync(baseline.workspace);
  const output = outsideOutput(values.output, workspace);
  const runtime = verifyRuntimeIdentity(baseline.runtimeOptions);
  requireEvidence(JSON.stringify(runtime) === JSON.stringify(baseline.runtime), "runtime changed after capture");
  requireEvidence(JSON.stringify(inventoryWorkspace(workspace)) === JSON.stringify(baseline.inventory), "workspace entries changed");
  const workflow = readWorkflow(workspace, baseline.workflowId);
  requireEvidence(workflow && workflow.epoch === baseline.epoch && workflow.createdAt === baseline.createdAt && workflow.revision > baseline.revision, "workflow identity or epoch changed");
  requireEvidence(manifestHash(workflow) === baseline.manifestSha256, "frozen manifest changed");
  const evidence = verifyPeerEvidence(workflow);
  requireEvidence(runtime.mode !== "candidate" || (evidence.memoModel.advisor && evidence.critiqueModel.advisor), "candidate requires frozen advisor policy evidence");
  const report = { schema: 1, qualified: true, runtime, workspaceEntriesUnchanged: true, frozenManifestSha256: baseline.manifestSha256, ...evidence, boundary: "Local shipped paths and accepted peer records only; no workflow-to-runtime binding, publication, installation activation, client restart, or external Git metadata proof." };
  saveReport(output, report);
  return { qualified: true, output, mode: runtime.mode, commit: runtime.commit };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.error(error instanceof Error ? error.message : "Qualification failed"); process.exitCode = 1; }
}
