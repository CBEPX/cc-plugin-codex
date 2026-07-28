/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  cleanupManagedGlobalIntegrations,
  getManagedPluginSignals,
} from "../../scripts/lib/managed-global-integration.mjs";
import { resolveCodexHome } from "../../scripts/lib/codex-paths.mjs";

function clearRefusalMarker(refusalMarker) {
  try {
    fs.rmSync(refusalMarker, { recursive: true, force: true });
  } catch {
    // A cosmetic warning marker must never make a native hook fail.
  }
}

export function cleanupAfterOfficialUninstall(pluginRoot, codexHome) {
  const resolvedCodexHome = codexHome ?? resolveCodexHome();
  const signals = getManagedPluginSignals(resolvedCodexHome);
  const refusalMarker = path.join(
    resolvedCodexHome,
    "plugins",
    "data",
    "cc",
    "managed-cleanup-refused"
  );

  if (signals.configState === "active") {
    clearRefusalMarker(refusalMarker);
    return false;
  }

  if (signals.configState !== "inactive" || signals.cachePresent) {
    if (signals.cachePresent) {
      clearRefusalMarker(refusalMarker);
    }
    return false;
  }

  const cleaned = cleanupManagedGlobalIntegrations(
    pluginRoot,
    resolvedCodexHome,
    { reportRefusal: false }
  );
  if (!cleaned) {
    const refusalReason = `${signals.reason}\n`;
    let previousReason = null;
    try {
      previousReason = fs.readFileSync(refusalMarker, "utf8");
    } catch {}
    if (previousReason !== refusalReason) {
      process.stderr.write(
        `[cc] managed hook cleanup refused after explicit uninstall signals (${signals.reason}, cache missing); repair ${path.join(resolvedCodexHome, "hooks.json")}\n`
      );
      try {
        clearRefusalMarker(refusalMarker);
        fs.mkdirSync(path.dirname(refusalMarker), { recursive: true });
        fs.writeFileSync(refusalMarker, refusalReason, "utf8");
      } catch {
        // The hook still exits early even when the warning marker cannot be persisted.
      }
    }
    return true;
  }

  clearRefusalMarker(refusalMarker);
  process.stderr.write(
    `[cc] removed managed hooks after explicit uninstall signals (${signals.reason}, cache missing)\n`
  );
  return true;
}
