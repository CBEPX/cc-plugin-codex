/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
/** @type {Array<[string, string[]]>} */
const expectations = [
  ["scripts/lib/process.mjs:9-54", ["runCommand", "runCommandChecked"]],
  ["scripts/lib/process.mjs:75-106", ["isCommandTimeout", "isWindowsIdentityCircuitOpen", "tripWindowsIdentityCircuit"]],
  ["scripts/lib/process.mjs:108-179", ["terminateProcessTree"]],
  ["scripts/lib/process.mjs:185-367", ["terminateProcessTreeIfIdentityMatches"]],
  ["scripts/lib/process.mjs:390-504", ["getProcessIdentity", "getSpawnedProcessIdentity", "validateProcessIdentity", "isProcessAlive", "isProcessGroupAlive"]],
  ["scripts/lib/state.mjs:188-228", ["ensurePluginDataLayout", "resolveWorkspaceHash", "ensureStateDir"]],
  ["scripts/lib/state.mjs:297-388", ["setCurrentSession", "getCurrentSession", "clearCurrentSession", "markSessionCleanupPending", "listPendingSessionCleanups", "clearSessionCleanupPending"]],
  ["scripts/lib/state.mjs:420-468", ["writeJobFile", "normalizeStoredJob"]],
  ["scripts/lib/state.mjs:545-875", ["mostRecentJobTimestamp", "isWithinReapGracePeriod", "reapStaleJobs"]],
  ["scripts/lib/state.mjs:924-1096", ["unlinkLockIfUnchanged", "remainingLockDeadlineMs", "lockProcessTimeout", "recoverStaleLock", "acquireJobLock", "releaseJobLock"]],
  ["scripts/lib/state.mjs:1162-1219", ["casJobStatus", "transitionJob", "writeAtomic"]],
  ["scripts/lib/state.mjs:1225-1271", ["cleanupOldJobs"]],
  ["scripts/lib/tracked-jobs.mjs:30-43", ["transitionTrackedJob"]],
  ["scripts/lib/tracked-jobs.mjs:286-344", ["createJobProgressUpdater"]],
  ["scripts/lib/tracked-jobs.mjs:363-522", ["runTrackedJob"]],
  ["scripts/lib/job-control.mjs:170-273", ["matchJobReference", "buildStatusSnapshot", "resolveCancelableJob"]],
  ["scripts/installer-cli.mjs:96-234", ["readPersonalMarketplace", "prepareLegacyLocalCleanup", "isPluginAlreadyAbsent", "isPluginUninstallRefused"]],
  ["scripts/installer-cli.mjs:275-371", ["installOrUpdate", "uninstall"]],
];

test("mutation line ranges still contain their intended complete functions", () => {
  const config = fs.readFileSync(path.join(PROJECT_ROOT, "stryker.shard.config.mjs"), "utf8");
  for (const [spec, functionNames] of expectations) {
    assert.ok(config.includes(`"${spec}"`), `missing mutation range ${spec}`);
    const [, file, start, end] = spec.match(/^(.*):(\d+)-(\d+)$/);
    const source = fs.readFileSync(path.join(PROJECT_ROOT, file), "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const spans = functionNames.map((functionName) => {
      const declaration = sourceFile.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === functionName
      );
      assert.ok(declaration, `${file} no longer declares ${functionName}`);
      const firstLine =
        sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line + 1;
      const lastLine =
        sourceFile.getLineAndCharacterOfPosition(declaration.end).line + 1;
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
