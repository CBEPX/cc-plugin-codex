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
  ["scripts/lib/process.mjs:390-500", ["getProcessIdentity", "getSpawnedProcessIdentity", "validateProcessIdentity", "isProcessAlive", "isProcessGroupAlive"]],
  ["scripts/lib/state.mjs:178-218", ["ensurePluginDataLayout", "resolveWorkspaceHash", "ensureStateDir"]],
  ["scripts/lib/state.mjs:341-389", ["writeJobFile", "normalizeStoredJob"]],
  ["scripts/lib/state.mjs:466-707", ["mostRecentJobTimestamp", "isWithinReapGracePeriod", "reapStaleJobs"]],
  ["scripts/lib/state.mjs:756-893", ["unlinkLockIfUnchanged", "recoverStaleLock", "acquireJobLock", "releaseJobLock"]],
  ["scripts/lib/state.mjs:959-1009", ["casJobStatus", "transitionJob", "writeAtomic"]],
  ["scripts/lib/state.mjs:1015-1061", ["cleanupOldJobs"]],
  ["scripts/lib/tracked-jobs.mjs:26-39", ["transitionTrackedJob"]],
  ["scripts/lib/tracked-jobs.mjs:356-482", ["runTrackedJob"]],
  ["scripts/lib/job-control.mjs:144-247", ["matchJobReference", "buildStatusSnapshot", "resolveCancelableJob"]],
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
