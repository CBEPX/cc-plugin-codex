/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { normalizePathSlashes, resolveCodexHome } from "./codex-paths.mjs";
import {
  getManagedPluginSignals as getManagedPluginSignalsBase,
  LEGACY_MARKETPLACE_NAME,
  listManagedPluginCacheEntries,
  PLUGIN_NAME,
} from "./plugin-identity.mjs";

const HOME_DIR = os.homedir();
const MANAGED_WRAPPER_SKILLS = [
  "review",
  "adversarial-review",
  "rescue",
  "status",
  "result",
  "cancel",
  "setup",
];

function readText(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

export function writeTextAtomic(filePath, content) {
  let targetFile = filePath;
  let linkStats = null;
  try {
    linkStats = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (linkStats?.isSymbolicLink()) {
    targetFile = fs.realpathSync(filePath);
  }

  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  let targetStats = null;
  try {
    targetStats = fs.statSync(targetFile);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const mode = targetStats ? targetStats.mode & 0o777 : 0o600;
  if (targetStats?.nlink > 1) {
    // ponytail: atomic rename cannot preserve hard-link identity; back up the in-place rewrite.
    const backupFile =
      `${targetFile}.bak.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString("hex")}`;
    const originalContent = fs.readFileSync(targetFile);
    let preserveBackup = false;
    const rewriteInPlace = (data) => {
      const descriptor = fs.openSync(targetFile, "w");
      try {
        fs.writeFileSync(descriptor, data);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    };
    try {
      const backupDescriptor = fs.openSync(backupFile, "wx", 0o600);
      try {
        fs.writeFileSync(backupDescriptor, originalContent);
        fs.fchmodSync(backupDescriptor, 0o600);
        fs.fsyncSync(backupDescriptor);
      } finally {
        fs.closeSync(backupDescriptor);
      }

      try {
        rewriteInPlace(content);
      } catch (writeError) {
        try {
          rewriteInPlace(originalContent);
        } catch (restoreError) {
          preserveBackup = true;
          throw new AggregateError(
            [writeError, restoreError],
            `Failed to rewrite ${targetFile}; original content retained at ${backupFile}`
          );
        }
        throw writeError;
      }
    } catch (error) {
      if (!preserveBackup) {
        try {
          fs.rmSync(backupFile, { force: true });
        } catch {
          // Preserve the original rewrite failure.
        }
      }
      throw error;
    }
    fs.rmSync(backupFile, { force: true });
    return;
  }

  const temporaryFile =
    `${targetFile}.tmp.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString("hex")}`;
  try {
    const descriptor = fs.openSync(temporaryFile, "wx", mode);
    try {
      fs.writeFileSync(descriptor, content, "utf8");
      fs.fchmodSync(descriptor, mode);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryFile, targetFile);
  } catch (error) {
    try {
      fs.rmSync(temporaryFile, { force: true });
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

function removeIfEmpty(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return;
  }
  if (fs.readdirSync(dirPath).length === 0) {
    fs.rmdirSync(dirPath);
  }
}

function readManagedHooksDocument(codexHome) {
  const hooksFile = path.join(codexHome, "hooks.json");
  const raw = readText(hooksFile);
  if (!raw) {
    return { hooksFile, parsed: null, refusal: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { hooksFile, parsed: null, refusal: "invalid JSON" };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed.hooks != null &&
      (typeof parsed.hooks !== "object" ||
        Array.isArray(parsed.hooks)))
  ) {
    return { hooksFile, parsed: null, refusal: "invalid hooks data" };
  }

  return { hooksFile, parsed, refusal: null };
}

export function validateManagedHooks(codexHome = resolveCodexHome()) {
  return readManagedHooksDocument(codexHome).refusal === null;
}

export function removeManagedHooks(
  pluginRoot,
  codexHome = resolveCodexHome(),
  { reportRefusal = true, platform = process.platform } = {}
) {
  const { hooksFile, parsed, refusal } = readManagedHooksDocument(codexHome);
  if (refusal) {
    if (reportRefusal) {
      process.stderr.write(`[cc] refusing managed hook cleanup: ${refusal} in ${hooksFile}\n`);
    }
    return false;
  }
  if (!parsed) {
    return true;
  }

  const nextHooks = {};
  let changed = false;
  const normalizeForComparison = (value) => {
    const normalized = normalizePathSlashes(String(value));
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const hookPrefixes = [
    normalizeForComparison(path.join(pluginRoot, "hooks")) + "/",
    ...listManagedPluginCacheEntries(codexHome).map(
      (cacheEntry) => normalizeForComparison(path.join(cacheEntry.cachePath, "hooks")) + "/"
    ),
  ];

  for (const [eventName, entries] of Object.entries(parsed.hooks ?? {})) {
    if (!Array.isArray(entries)) {
      nextHooks[eventName] = entries;
      continue;
    }

    const keptEntries = [];
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        !Array.isArray(entry.hooks)
      ) {
        keptEntries.push(entry);
        continue;
      }

      const keptNested = entry.hooks.filter((hook) => {
        const command = normalizeForComparison(hook?.command ?? "");
        const shouldRemove = hookPrefixes.some((hookPrefix) => command.includes(hookPrefix));
        return !shouldRemove;
      });
      const removed = keptNested.length !== entry.hooks.length;
      changed ||= removed;
      if (!removed || keptNested.length > 0) {
        keptEntries.push({ ...entry, hooks: keptNested });
      }
    }
    if (keptEntries.length > 0 || entries.length === 0) {
      nextHooks[eventName] = keptEntries;
    }
  }

  if (!changed) {
    return true;
  }

  const otherKeys = Object.keys(parsed).filter((key) => key !== "hooks");
  if (Object.keys(nextHooks).length === 0 && otherKeys.length === 0) {
    fs.rmSync(hooksFile, { force: true });
    return true;
  }

  writeTextAtomic(hooksFile, `${JSON.stringify({ ...parsed, hooks: nextHooks }, null, 2)}\n`);
  return true;
}

function formatWrapperName(skillName) {
  return `${PLUGIN_NAME}-${skillName}`;
}

export function removeManagedSkillWrappers(codexHome = resolveCodexHome()) {
  const skillsDir = path.join(codexHome, "skills");
  const promptsDir = path.join(codexHome, "prompts");
  for (const skillName of MANAGED_WRAPPER_SKILLS) {
    fs.rmSync(path.join(skillsDir, formatWrapperName(skillName)), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(promptsDir, `${formatWrapperName(skillName)}.md`), {
      force: true,
    });
  }

  removeIfEmpty(skillsDir);
  removeIfEmpty(promptsDir);
}

export function getManagedPluginSignals(codexHome = resolveCodexHome()) {
  return getManagedPluginSignalsBase(codexHome);
}

export function isCodexPluginActive(codexHome = resolveCodexHome()) {
  return getManagedPluginSignals(codexHome).configState === "active";
}

export function cleanupManagedGlobalIntegrations(
  pluginRoot,
  codexHome = resolveCodexHome(),
  options = {}
) {
  if (!removeManagedHooks(pluginRoot, codexHome, options)) {
    return false;
  }
  removeManagedSkillWrappers(codexHome);
  return true;
}

export function resolveManagedMarketplacePluginPath(pluginRoot) {
  const relative = path.relative(HOME_DIR, pluginRoot);
  if (!relative || relative === "") {
    throw new Error(
      `Plugin root must not be the marketplace root itself: ${pluginRoot}`
    );
  }
  if (path.isAbsolute(relative)) {
    throw new Error(
      `Unable to express plugin root as a relative personal marketplace path: ${pluginRoot}`
    );
  }
  return `./${normalizePathSlashes(relative)}`;
}

export { LEGACY_MARKETPLACE_NAME, PLUGIN_NAME };
