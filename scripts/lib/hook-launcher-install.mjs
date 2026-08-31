/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";
import path from "node:path";
import { resolvePluginRuntimeRoot } from "./codex-paths.mjs";
import { writeTextAtomic } from "./managed-global-integration.mjs";

export function hookLauncherStatus(pluginRoot, namespace) {
  const source = path.join(pluginRoot, "scripts", "hook-launcher.mjs");
  const destination = path.join(resolvePluginRuntimeRoot(namespace), "hook-launcher.mjs");
  let sourceContent;
  try {
    sourceContent = fs.readFileSync(source, "utf8");
  } catch {
    return { installed: false, detail: `hook launcher source missing at ${source}`, destination };
  }
  try {
    if (fs.lstatSync(destination).isFile() && fs.readFileSync(destination, "utf8") === sourceContent) {
      return { installed: true, detail: "stable hook launcher installed", destination };
    }
  } catch {}
  return { installed: false, detail: `stable hook launcher missing or stale at ${destination}`, destination };
}

export function installHookLauncher(pluginRoot, namespace) {
  const status = hookLauncherStatus(pluginRoot, namespace);
  if (status.installed) {
    return { ...status, changed: false };
  }
  const source = path.join(pluginRoot, "scripts", "hook-launcher.mjs");
  writeTextAtomic(status.destination, fs.readFileSync(source, "utf8"));
  return { ...hookLauncherStatus(pluginRoot, namespace), changed: true };
}
