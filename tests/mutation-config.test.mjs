/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const ARTIFACT_ACTION_SHA = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

function readWorkflow(name) {
  return fs.readFileSync(path.join(PROJECT_ROOT, ".github", "workflows", name), "utf8").replaceAll("\r\n", "\n");
}

function workflowJob(source, name) {
  const start = source.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `missing workflow job ${name}`);
  const next = source.slice(start + 1).search(/^ {2}[\w-]+:\n/mu);
  return next === -1 ? source.slice(start) : source.slice(start, start + next + 1);
}

function actionStep(job, action) {
  const marker = `uses: ${action}@`;
  const actionOffset = job.indexOf(marker);
  assert.notEqual(actionOffset, -1, `missing ${action} step`);
  const start = job.lastIndexOf("\n      - ", actionOffset);
  const next = job.indexOf("\n      - ", actionOffset);
  return job.slice(start + 1, next === -1 ? undefined : next + 1);
}

function actionRef(step, action) {
  return step.match(new RegExp(`uses: ${action.replaceAll("/", "\\/")}@([^ #\\n]+)`, "u"))?.[1];
}

function actionInputs(step) {
  return Object.fromEntries(
    [...step.matchAll(/^ {10}([\w-]+): (.+)$/gmu)].map((match) => [match[1], match[2]])
  );
}
/** @type {Array<[string, string[]]>} */
const expectations = [
  ["scripts/lib/process.mjs:9-54", ["runCommand", "runCommandChecked"]],
  ["scripts/lib/process.mjs:75-123", ["isCommandTimeout", "isWindowsIdentityCircuitOpen", "tripWindowsIdentityCircuit"]],
  ["scripts/lib/process.mjs:125-196", ["terminateProcessTree"]],
  ["scripts/lib/process.mjs:202-385", ["terminateProcessTreeIfIdentityMatches"]],
  ["scripts/lib/process.mjs:408-543", ["getProcessIdentity", "getSpawnedProcessIdentity", "validateProcessIdentity", "isProcessAlive", "isProcessGroupAlive"]],
  ["scripts/lib/state.mjs:189-229", ["ensurePluginDataLayout", "resolveWorkspaceHash", "ensureStateDir"]],
  ["scripts/lib/state.mjs:298-389", ["setCurrentSession", "getCurrentSession", "clearCurrentSession", "markSessionCleanupPending", "listPendingSessionCleanups", "clearSessionCleanupPending"]],
  ["scripts/lib/state.mjs:421-471", ["writeJobFile", "normalizeStoredJob"]],
  ["scripts/lib/state.mjs:548-934", ["mostRecentJobTimestamp", "isWithinReapGracePeriod", "reapStaleJobs"]],
  ["scripts/lib/state.mjs:983-1156", ["unlinkLockIfUnchanged", "remainingLockDeadlineMs", "lockProcessTimeout", "recoverStaleLock", "acquireJobLock", "releaseJobLock"]],
  ["scripts/lib/state.mjs:1222-1287", ["casJobStatus", "transitionJob", "writeAtomic", "withStateFileLock"]],
  ["scripts/lib/state.mjs:1293-1339", ["cleanupOldJobs"]],
  ["scripts/lib/tracked-jobs.mjs:30-78", ["transitionTrackedJob", "isStatusReaperFailure", "transitionTrackedJobTerminal"]],
  ["scripts/lib/tracked-jobs.mjs:308-392", ["createJobRecord", "createJobProgressUpdater"]],
  ["scripts/lib/tracked-jobs.mjs:411-544", ["runTrackedJob"]],
  ["scripts/lib/job-control.mjs:212-478", ["matchJobReference", "buildStatusSnapshot", "resolveCancelableJob"]],
  ["scripts/installer-cli.mjs:98-236", ["readPersonalMarketplace", "prepareLegacyLocalCleanup", "isPluginAlreadyAbsent", "isPluginUninstallRefused"]],
  ["scripts/installer-cli.mjs:277-377", ["installOrUpdate", "uninstall"]],
];

test("mutation line ranges still contain their intended complete functions", () => {
  const config = fs.readFileSync(path.join(PROJECT_ROOT, "stryker.shard.config.mjs"), "utf8");
  for (const [spec, functionNames] of expectations) {
    assert.ok(config.includes(`"${spec}"`), `missing mutation range ${spec}`);
    const [, file, start, end] = spec.match(/^(.*):(\d+)-(\d+)$/);
    const source = fs.readFileSync(path.join(PROJECT_ROOT, file), "utf8");
    const program = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    });
    const spans = functionNames.map((functionName) => {
      // Match the complete top-level statement so an `export` wrapper keeps its offsets.
      const declaration = program.body.find(
        (node) =>
          (node.type === "FunctionDeclaration" && node.id.name === functionName) ||
          (node.type === "ExportNamedDeclaration" &&
            node.declaration?.type === "FunctionDeclaration" &&
            node.declaration.id.name === functionName)
      );
      assert.ok(declaration, `${file} no longer declares ${functionName}`);
      const firstLine = declaration.loc.start.line;
      const lastLine = declaration.loc.end.line;
      assert.ok(
        firstLine >= Number(start) && lastLine <= Number(end),
        `${spec} excludes part of ${functionName} (${firstLine}-${lastLine})`
      );
      return { firstLine, lastLine };
    });
    assert.equal(spans[0].firstLine, Number(start), `${spec} has a stale start boundary`);
    assert.equal(
      spans.at(-1).lastLine,
      Number(end),
      `${spec} has a stale end boundary`
    );
  }
});

test("Windows lifecycle gate patterns stay aligned with their tests", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")
  );
  const lifecycleScript = packageJson.scripts["test:lifecycle-contract"];
  const expected = [
    ["tests/state.test.mjs", "keeps a running job while its owning worker is alive"],
    ["tests/state.test.mjs", "falls back to the identity-checked Claude PID"],
    ["tests/state.test.mjs", "terminates a live Claude child"],
    ["tests/state.test.mjs", "waits briefly for a signalled Claude child"],
    ["tests/state.test.mjs", "bounds Windows Claude child cleanup"],
    ["tests/state.test.mjs", "clears a recycled Claude child PID"],
    ["tests/state.test.mjs", "clears an identity-unavailable Claude child"],
    ["tests/state.test.mjs", "reports cancel_failed when a live Claude child"],
    ["tests/tracked-jobs.test.mjs", "tracks the worker separately"],
    ["tests/tracked-jobs.test.mjs", "logs when worker identity is unavailable"],
    ["tests/tracked-jobs.test.mjs", "does not bypass a terminal writer"],
    ["tests/tracked-jobs.test.mjs", "ignores progress after its job file disappears"],
  ];
  for (const [file, name] of expected) {
    assert.match(lifecycleScript, new RegExp(name));
    assert.match(fs.readFileSync(path.join(PROJECT_ROOT, file), "utf8"), new RegExp(name));
  }
});

test("state mutation targets are split by source file without changing their test command", async () => {
  const previous = process.env.CC_MUTATION_SHARD;
  const load = async (shard) => {
    process.env.CC_MUTATION_SHARD = shard;
    return (await import(`../stryker.shard.config.mjs?test-shard=${shard}`)).default;
  };

  try {
    const state = await load("state");
    const trackedJobs = await load("tracked-jobs");

    assert.deepEqual(state.mutate, expectations.slice(5, 12).map(([target]) => target));
    assert.deepEqual(trackedJobs.mutate, expectations.slice(12, 15).map(([target]) => target));
    assert.equal(state.commandRunner.command, "npm run test:mutation:state:unit");
    assert.equal(trackedJobs.commandRunner.command, state.commandRunner.command);
    assert.equal(state.thresholds.break, 55);
    assert.equal(trackedJobs.thresholds.break, 55);
  } finally {
    if (previous === undefined) delete process.env.CC_MUTATION_SHARD;
    else process.env.CC_MUTATION_SHARD = previous;
  }
});

test("full mutation runs every force shard independently and merges available reports", () => {
  const workflow = readWorkflow("mutation.yml");
  const full = workflowJob(workflow, "full");
  const expectedShards = [
    ["critical", "test:mutation:critical:force"],
    ["render", "test:mutation:shard:render:force"],
    ["claude-cli", "test:mutation:shard:claude-cli:force"],
    ["state", "test:mutation:shard:state:force"],
    ["tracked-jobs", "test:mutation:shard:tracked-jobs:force"],
    ["job-control", "test:mutation:shard:job-control:force"],
    ["managed", "test:mutation:shard:managed:force"],
    ["installer", "test:mutation:shard:installer:force"],
  ];
  const shards = [...full.matchAll(
    /^ {10}- shard: ([\w-]+)\n {12}script: ([\w:-]+)$/gmu
  )].map((match) => match.slice(1));

  assert.deepEqual(shards, expectedShards);
  assert.match(full, /^ {6}fail-fast: false$/mu);
  assert.match(full, /^ {4}timeout-minutes: 45$/mu);
  assert.match(full, /^ {6}- run: npm run \$\{\{ matrix\.script \}\}$/mu);
  assert.doesNotMatch(full, /test:mutation:full:force/u);

  const upload = actionStep(full, "actions/upload-artifact");
  assert.equal(actionRef(upload, "actions/upload-artifact"), ARTIFACT_ACTION_SHA);
  assert.match(upload, /^ {6}- if: always\(\)$/mu);
  assert.deepEqual(actionInputs(upload), {
    name: "mutation-full-${{ matrix.shard }}",
    path: "reports/mutation/",
    "if-no-files-found": "error",
    "retention-days": "14",
    archive: "true",
  });

  const merge = workflowJob(workflow, "merge");
  assert.match(merge, /^ {4}needs: full$/mu);
  assert.match(merge, /^ {4}if: \$\{\{ always\(\) && github\.event_name != 'pull_request' \}\}$/mu);
  const mergeStep = actionStep(merge, "actions/upload-artifact/merge");
  assert.equal(actionRef(mergeStep, "actions/upload-artifact/merge"), ARTIFACT_ACTION_SHA);
  assert.deepEqual(actionInputs(mergeStep), {
    name: "mutation-full",
    pattern: "mutation-full-*",
    "separate-directories": "false",
    "delete-merged": "true",
    "retention-days": "14",
  });
  assert.equal(Object.hasOwn(actionInputs(mergeStep), "archive"), false);
});

test("coverage and pull-request mutation preserve archived failure evidence", () => {
  const cases = [
    ["ci.yml", "linux-coverage", "coverage", "reports/coverage/"],
    ["mutation.yml", "pull-request", "mutation-pull-request", "reports/mutation/"],
  ];
  for (const [workflowName, jobName, artifactName, artifactPath] of cases) {
    const job = workflowJob(readWorkflow(workflowName), jobName);
    const upload = actionStep(job, "actions/upload-artifact");
    assert.equal(actionRef(upload, "actions/upload-artifact"), ARTIFACT_ACTION_SHA);
    assert.match(upload, /^ {6}- if: always\(\)$/mu);
    assert.deepEqual(actionInputs(upload), {
      name: artifactName,
      path: artifactPath,
      "if-no-files-found": "error",
      "retention-days": "14",
      archive: "true",
    });
  }
});
