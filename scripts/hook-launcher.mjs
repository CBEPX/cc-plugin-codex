#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOOK_FILES = Object.freeze({
  "session-lifecycle": "session-lifecycle-hook.mjs",
  "stop-review-gate": "stop-review-gate-hook.mjs",
  "unread-result": "unread-result-hook.mjs",
});

function resolveHook(root, hookFile) {
  if (!root || !path.isAbsolute(root)) {
    return null;
  }
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const hooksRoot = path.join(root, "hooks");
    const hookPath = path.join(root, "hooks", hookFile);
    if (
      packageJson.name === "cc-plugin-codex" &&
      fs.lstatSync(root).isDirectory() &&
      fs.lstatSync(hooksRoot).isDirectory() &&
      fs.lstatSync(hookPath).isFile()
    ) {
      return { root, hookPath, mtimeMs: fs.statSync(root).mtimeMs };
    }
  } catch {}
  return null;
}

function resolveCurrentHook(pluginRoot, hookFile) {
  const direct = resolveHook(pluginRoot, hookFile);
  if (direct) {
    return direct;
  }

  if (!pluginRoot || !path.isAbsolute(pluginRoot)) {
    return null;
  }
  const versionsRoot = path.dirname(pluginRoot);
  if (
    path.basename(versionsRoot) !== "cc" ||
    path.basename(path.dirname(path.dirname(versionsRoot))) !== "cache"
  ) {
    return null;
  }
  let entries;
  try {
    entries = fs.readdirSync(versionsRoot);
  } catch {
    entries = [];
  }
  const candidates = entries
    .map((entry) => resolveHook(path.join(versionsRoot, entry), hookFile))
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.root.localeCompare(left.root));
  return candidates[0] ?? null;
}

const [hookName, ...hookArgs] = process.argv.slice(2);
const hookFile = HOOK_FILES[hookName];
if (!hookFile) {
  throw new Error(`Unknown cc hook: ${hookName || "<missing>"}`);
}

const resolved = resolveCurrentHook(process.env.PLUGIN_ROOT, hookFile);
if (!resolved) {
  throw new Error(`Unable to locate the active cc plugin hook: ${hookFile}`);
}

process.env.PLUGIN_ROOT = resolved.root;
process.argv = [process.execPath, resolved.hookPath, ...hookArgs];
await import(pathToFileURL(resolved.hookPath).href);
