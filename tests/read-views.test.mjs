import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, it } from "node:test";
import { writeJobFile, readJobFile } from "../scripts/lib/state.mjs";
import { buildInitialAgentPlan, buildRetryAgentPlan, buildContinuationAgentPlan } from "../scripts/lib/peer-orchestration.mjs";
import { reserveWorkflow, resolveWorkflowsDir } from "../scripts/lib/workflows.mjs";

const companion = new URL("../scripts/claude-companion.mjs", import.meta.url).pathname;
const cleanup = [];
afterEach(() => { for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-read-"));
  cleanup.push(root);
  for (const args of [["init", "-q"], ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "initial"]]) {
    assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
  }
  const job = { id: "large-job", workspaceRoot: root, kind: "task", jobClass: "task", status: "completed", summary: "done", result: { finalMessage: "😀漢字".repeat(140000) }, resultViewedAt: null };
  writeJobFile(root, job.id, job);
  const workflow = reserveWorkflow(root, { id: "large-workflow", mode: "design", brief: "Compare", originSessionId: "reader", stages: ["checkpoint", "critique", "synthesis"], branches: ["codex", "claude"] });
  Object.assign(workflow, { status: "completed", phase: "done", finalResult: { answer: job.result.finalMessage }, checkpoint: { agreements: Array(1000).fill("agreed") } });
  workflow.branches.codex.status = "completed";
  workflow.branches.claude.status = "completed";
  workflow.branches.codex.payload = { content: { memo: job.result.finalMessage } };
  workflow.branches.claude.payload = { content: { memo: "SIBLING_SECRET" } };
  workflow.branches.claude.attemptHistory = Array(30).fill({ payload: { content: "SIBLING_SECRET" }, lease: "RAW_LEASE_SECRET" });
  const workflowFile = path.join(resolveWorkflowsDir(root), `${workflow.id}.json`);
  fs.writeFileSync(workflowFile, JSON.stringify(workflow));
  return { root, job, workflow, workflowFile };
}
function run(root, args, extra = {}) {
  return spawnSync(process.execPath, [companion, ...args, "--cwd", root], { encoding: "utf8", env: { ...process.env, CODEX_THREAD_ID: "", CLAUDE_COMPANION_SESSION_ID: "" }, maxBuffer: 20 * 1024 * 1024, ...extra });
}
function json(root, args) {
  const result = run(root, [...args, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
it("bounds historical large Unicode reads for every command without consuming results or rewriting payloads", () => {
  const { root, job, workflow, workflowFile } = fixture();
  const before = fs.readFileSync(workflowFile);
  for (const args of [["status", job.id], ["status", "--all"], ["result", job.id], ["status", workflow.id], ["result", workflow.id], ["workflow-read", workflow.id], ["workflow-list"], ["peer-wait", workflow.id]]) {
    for (const format of [[], ["--json"]]) {
      const result = run(root, [...args, ...format]);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(Buffer.byteLength(result.stdout) <= 8192, `${args}: ${Buffer.byteLength(result.stdout)} bytes`);
      if (format.length) {
        const value = JSON.parse(result.stdout);
        assert.equal(value.truncated, true);
        assert.ok(value.omissions);
      } else assert.match(result.stdout, /truncated|Truncated/u);
      assert.doesNotMatch(result.stdout, /RAW_LEASE_SECRET/u);
    }
  }
  assert.equal(readJobFile(root, job.id).resultViewedAt, null);
  assert.equal(readJobFile(root, job.id).result.finalMessage, job.result.finalMessage);
  assert.deepEqual(fs.readFileSync(workflowFile), before);
});
it("exports exact full JSON with checksum and private permissions, then acknowledges delivery", () => {
  const { root, job } = fixture();
  const output = path.join(root, "export.json");
  const receipt = json(root, ["result", job.id, "--output", output]);
  const bytes = fs.readFileSync(output);
  assert.equal(receipt.outputFile, output);
  assert.equal(receipt.bytes, bytes.length);
  assert.equal(receipt.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(JSON.parse(bytes.toString("utf8")).storedJob.result.finalMessage, job.result.finalMessage);
  if (process.platform !== "win32") assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.ok(readJobFile(root, job.id).resultViewedAt);
});
it("refuses existing files, symlinks and failed writes without consuming a result", () => {
  const { root, job } = fixture();
  const existing = path.join(root, "existing.json");
  const link = path.join(root, "link.json");
  fs.writeFileSync(existing, "keep");
  fs.symlinkSync(existing, link);
  for (const output of [existing, link, path.join(root, "missing", "out.json")]) {
    const result = run(root, ["result", job.id, "--output", output, "--json"]);
    assert.notEqual(result.status, 0);
    assert.equal(readJobFile(root, job.id).resultViewedAt, null);
  }
  assert.equal(fs.readFileSync(existing, "utf8"), "keep");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
});
it("redacts pre-seal sibling content and leases through every read and export, including linked historical jobs", () => {
  const { root, job, workflow, workflowFile } = fixture();
  workflow.branches.codex.status = "pending";
  fs.writeFileSync(workflowFile, JSON.stringify(workflow));
  writeJobFile(root, job.id, { ...job, workflowId: workflow.id, workflowBranch: "claude", result: { finalMessage: "SIBLING_SECRET" } });
  for (const args of [["status", workflow.id], ["result", workflow.id], ["workflow-read", workflow.id], ["workflow-list"], ["peer-wait", workflow.id], ["status", job.id], ["result", job.id], ["status", "--all"]]) {
    for (const format of [[], ["--json"]]) {
      const result = run(root, [...args, ...format]);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /SIBLING_SECRET|RAW_LEASE_SECRET/u);
    }
    const output = path.join(root, `export-${Math.random()}.json`);
    json(root, [...args, "--output", output]);
    assert.doesNotMatch(fs.readFileSync(output, "utf8"), /SIBLING_SECRET|RAW_LEASE_SECRET/u);
  }
});
it("keeps small default result delivery complete and acknowledges only after result access", () => {
  const { root, job } = fixture();
  writeJobFile(root, job.id, { ...job, result: { finalMessage: "small complete answer" } });
  const status = json(root, ["status", job.id]);
  assert.equal(status.job.result, undefined);
  assert.equal(readJobFile(root, job.id).resultViewedAt, null);
  const result = json(root, ["result", job.id]);
  assert.equal(result.storedJob.result.finalMessage, "small complete answer");
  assert.equal(result.truncated, false);
  assert.ok(readJobFile(root, job.id).resultViewedAt);
});
it("bounds --all lists and reports how many records were omitted", () => {
  const { root, job } = fixture();
  for (let index = 0; index < 50; index++) {
    writeJobFile(root, `job-${index}`, { ...job, id: `job-${index}`, title: "長".repeat(20000), result: { finalMessage: "done" } });
  }
  for (const format of [[], ["--json"]]) {
    const result = run(root, ["status", "--all", ...format]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) <= 8192);
    if (format.length) {
      const value = JSON.parse(result.stdout);
      assert.equal(value.totalJobs, 51);
      assert.equal(value.omissions.records, 50 - value.recent.length);
    }
  }
});
it("cleans a partially created export after write failure and leaves notification unread", () => {
  const { root, job } = fixture();
  const output = path.join(root, "partial.json");
  const preload = path.join(root, "fail-write.mjs");
  fs.writeFileSync(preload, `import fs from "node:fs";
const write = fs.writeFileSync;
fs.writeFileSync = function(file, ...args) {
  if (typeof file === "number") {
    fs.writeSync(file, "partial");
    throw new Error("injected disk full");
  }
  return write.call(this, file, ...args);
};`);
  const result = run(root, ["result", job.id, "--output", output, "--json"], { env: { ...process.env, NODE_OPTIONS: `--import=${preload}` } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /injected disk full/u);
  assert.equal(fs.existsSync(output), false);
  assert.equal(readJobFile(root, job.id).resultViewedAt, null);
});

it("executes generated checkpoint and synthesis exports with complete frozen inputs outside the workspace", { skip: process.platform === "win32" }, () => {
  const { root, workflow } = fixture();
  for (const worker of [
    buildInitialAgentPlan(workflow, { companionPath: companion })[0],
    buildRetryAgentPlan(workflow, [{ stage: "checkpoint" }], { companionPath: companion })[0],
    buildContinuationAgentPlan(workflow, { companionPath: companion })[1],
  ]) {
    const match = worker.message.match(/node - <<'CC_PEER_READ_EXPORT'\n[\s\S]+?\nCC_PEER_READ_EXPORT/u);
    assert.ok(match, "worker must export complete frozen inputs before comparing or synthesizing");
    const result = spawnSync("sh", ["-c", match[0]], { encoding: "utf8", cwd: root, env: process.env });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    cleanup.push(path.dirname(receipt.outputFile));
    assert.equal(path.relative(root, receipt.outputFile).startsWith(".."), true);
    const frozen = JSON.parse(fs.readFileSync(receipt.outputFile, "utf8"));
    assert.equal(frozen.branches.codex.payload.content.memo, workflow.branches.codex.payload.content.memo);
    assert.equal(frozen.finalResult.answer, workflow.finalResult.answer);
    const inspect = worker.message.match(/node - CC_PEER_OUTPUT_FILE branches.codex.payload 0 <<'CC_PEER_READ_SECTION'\n[\s\S]+?\nCC_PEER_READ_SECTION/u);
    assert.ok(inspect, "worker must inspect bounded sections of the full file");
    const section = spawnSync("sh", ["-c", inspect[0].replace("CC_PEER_OUTPUT_FILE", JSON.stringify(receipt.outputFile))], { encoding: "utf8", cwd: root });
    assert.equal(section.status, 0, section.stderr);
    const page = JSON.parse(section.stdout);
    assert.ok(page.nextOffset > 0);
    assert.ok(page.totalChars > 100000);
    assert.ok(Buffer.byteLength(section.stdout) <= 8192);
  }
});
it("acknowledges only exports that deliver the matching complete aggregate event", () => {
  const { root, workflow, workflowFile } = fixture();
  const viewed = () => JSON.parse(fs.readFileSync(workflowFile, "utf8")).viewedEvents;
  for (const [status, event] of [["completed", "completed"], ["awaiting_user", "checkpoint"]]) {
    workflow.status = status;
    workflow.viewedEvents = [];
    fs.writeFileSync(workflowFile, JSON.stringify(workflow));
    json(root, ["peer-wait", workflow.id, "--output", path.join(root, `${event}-wait.json`)]);
    assert.deepEqual(viewed(), []);
    json(root, ["result", workflow.id]);
    assert.deepEqual(viewed(), []);
    for (const command of ["status", "result", "workflow-read", "workflow-list"]) {
      workflow.branches.codex.status = "pending";
      workflow.viewedEvents = [];
      fs.writeFileSync(workflowFile, JSON.stringify(workflow));
      json(root, [command, ...(command === "workflow-list" ? [] : [workflow.id]), "--output", path.join(root, `${event}-${command}-hidden.json`)]);
      assert.deepEqual(viewed(), [], `${command} cannot acknowledge a withheld aggregate`);
      workflow.branches.codex.status = "completed";
      fs.writeFileSync(workflowFile, JSON.stringify(workflow));
      json(root, [command, ...(command === "workflow-list" ? [] : [workflow.id]), "--output", path.join(root, `${event}-${command}-full.json`)]);
      assert.deepEqual(viewed(), [event], `${command} acknowledges a delivered full aggregate`);
    }
  }
});
it("keeps globally resolved linked jobs private in their owning workflow before seal", () => {
  const { root, job, workflow, workflowFile } = fixture();
  workflow.branches.codex.status = "pending";
  fs.writeFileSync(workflowFile, JSON.stringify(workflow));
  writeJobFile(root, job.id, { ...job, workflowId: workflow.id, workflowBranch: "claude", result: { finalMessage: "SIBLING_SECRET" } });
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "cc-read-other-"));
  cleanup.push(other);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: other }).status, 0);
  const output = path.join(other, "global.json");
  json(other, ["result", job.id, "--output", output]);
  assert.equal(fs.readFileSync(output, "utf8").includes("SIBLING_SECRET"), false);
  assert.equal(readJobFile(root, job.id).resultViewedAt, null);
});
it("retains failure and model information in a status summary while withholding result bodies", () => {
  const { root, job } = fixture();
  writeJobFile(root, job.id, { ...job, status: "failed", result: {
    finalMessage: "FULL_RESULT_BODY",
    failure: { kind: "claude_api", terminalCategory: "CLAUDE_API_ERROR", message: "API failure" },
    requestedModel: "claude-fable-5-1", finalModel: "claude-opus-4-6", contextWindow: 200000,
  } });
  const view = json(root, ["status", job.id]);
  assert.equal(view.job.failure.terminalCategory, "CLAUDE_API_ERROR");
  assert.equal(view.job.finalModel, "claude-opus-4-6");
  assert.equal(view.job.result, undefined);
  assert.equal(readJobFile(root, job.id).resultViewedAt, null);
});
it("keeps critique readiness visible in a summary poll without leaking its payload", () => {
  const { root, workflow, workflowFile } = fixture();
  workflow.stages.critique = { status: "completed", payload: { content: "CRITIQUE_BODY" } };
  fs.writeFileSync(workflowFile, JSON.stringify(workflow));
  const view = json(root, ["peer-wait", workflow.id]);
  assert.equal(view.workflowId, workflow.id);
  assert.equal(view.stages.critique.status, "completed");
  assert.equal(JSON.stringify(view).includes("CRITIQUE_BODY"), false);
});

it("exposes workflow readiness, evidence counts and actual model without memo bodies in status", () => {
  const { root, workflow, workflowFile } = fixture();
  workflow.branches.claude.payload = {
    content: "MODEL_MEMO_BODY", repoCitations: [{ path: "one", line: 1 }], webCitations: ["https://example.test"], toolEvents: [{ tool: "Read" }, { tool: "WebSearch" }],
    model: { requestedModel: "fable", finalModel: "opus", modelFallbacks: [] },
  };
  fs.writeFileSync(workflowFile, JSON.stringify(workflow));
  const view = json(root, ["status", workflow.id]);
  assert.equal(view.workflow.readyForCheckpoint, true);
  assert.equal(view.workflow.terminalIncomplete, false);
  assert.equal(view.workflow.branches.claude.model.finalModel, "opus");
  assert.deepEqual(view.workflow.branches.claude.evidenceCounts, { repo: 1, web: 1, tools: 2 });
  const human = run(root, ["status", workflow.id]);
  assert.match(human.stdout, /opus/u);
  assert.equal(human.stdout.includes("MODEL_MEMO_BODY"), false);
});
