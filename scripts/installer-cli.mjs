#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { callCodexAppServer } from "./lib/codex-app-server.mjs";
import { ensureNativePluginHooksEnabled } from "./lib/codex-config.mjs";
import { resolveCodexHome } from "./lib/codex-paths.mjs";
import {
  getManagedPluginSignals,
  LEGACY_MARKETPLACE_NAME,
  listManagedPluginCacheEntries,
  pluginIdForMarketplace,
  PLUGIN_NAME,
} from "./lib/plugin-identity.mjs";
import {
  cleanupManagedGlobalIntegrations,
  validateManagedHooks,
  writeTextAtomic,
} from "./lib/managed-global-integration.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
const CODEX_HOME = resolveCodexHome();
const HOME_DIR = os.homedir();
const CODEX_CONFIG_FILE = path.join(CODEX_HOME, "config.toml");
const LEGACY_INSTALL_DIR = path.join(CODEX_HOME, "plugins", PLUGIN_NAME);
const PERSONAL_MARKETPLACE_FILE = path.join(HOME_DIR, ".agents", "plugins", "marketplace.json");
const DEFAULT_MARKETPLACE_NAME = "cbepx";
const DEFAULT_MARKETPLACE_SOURCE = "CBEPX/cc-plugin-codex";

function usage() {
  console.error("Usage: cc-plugin-codex <install|update|uninstall>");
  process.exit(1);
}

function parseArgs(argv) {
  const [command] = argv;
  if (!command || !["install", "update", "uninstall"].includes(command)) {
    usage();
  }
  return { command };
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  return fs.readFileSync(filePath, "utf8");
}

function removeIfEmpty(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return;
  }
  if (fs.readdirSync(dirPath).length === 0) {
    fs.rmdirSync(dirPath);
  }
}

function resolveInstallerMarketplaceConfig() {
  const marketplaceName =
    process.env.CC_PLUGIN_CODEX_MARKETPLACE_NAME?.trim() || DEFAULT_MARKETPLACE_NAME;
  const source =
    process.env.CC_PLUGIN_CODEX_MARKETPLACE_SOURCE?.trim() || DEFAULT_MARKETPLACE_SOURCE;
  const refName = process.env.CC_PLUGIN_CODEX_MARKETPLACE_REF?.trim() || null;
  const sparsePaths = (process.env.CC_PLUGIN_CODEX_MARKETPLACE_SPARSE_PATHS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    marketplaceName,
    source,
    refName,
    sparsePaths: sparsePaths.length > 0 ? sparsePaths : null,
  };
}

function configureNativePluginHooks() {
  const existing = readText(CODEX_CONFIG_FILE);
  const { changed, content } = ensureNativePluginHooksEnabled(existing);
  if (changed || !fs.existsSync(CODEX_CONFIG_FILE)) {
    writeTextAtomic(CODEX_CONFIG_FILE, content);
  }
  return changed;
}

function readPersonalMarketplace() {
  if (!fs.existsSync(PERSONAL_MARKETPLACE_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(PERSONAL_MARKETPLACE_FILE, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot update invalid marketplace JSON at ${PERSONAL_MARKETPLACE_FILE}: ${error.message}`
    );
  }
}

function removePersonalMarketplaceCcEntries() {
  const parsed = readPersonalMarketplace();
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.plugins)) {
    return;
  }
  const nextPlugins = parsed.plugins.filter((plugin) => plugin?.name !== PLUGIN_NAME);
  if (nextPlugins.length === parsed.plugins.length) {
    return;
  }
  if (nextPlugins.length === 0) {
    fs.rmSync(PERSONAL_MARKETPLACE_FILE, { force: true });
    removeIfEmpty(path.dirname(PERSONAL_MARKETPLACE_FILE));
    removeIfEmpty(path.dirname(path.dirname(PERSONAL_MARKETPLACE_FILE)));
    return;
  }
  parsed.plugins = nextPlugins;
  writeTextAtomic(PERSONAL_MARKETPLACE_FILE, `${JSON.stringify(parsed, null, 2)}\n`);
}

function normalizeTrailingNewline(text) {
  return `${String(text).replace(/\s*$/, "")}\n`;
}

function removeManagedPluginConfigSections() {
  if (!fs.existsSync(CODEX_CONFIG_FILE)) {
    return;
  }
  const lines = fs.readFileSync(CODEX_CONFIG_FILE, "utf8").split("\n");
  const kept = [];
  let skip = false;
  let changed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (skip && trimmed.startsWith("[")) {
      skip = false;
    }
    if (!skip && /^\[\s*plugins\s*\.\s*["']?cc@([^"'\]]+)["']?\s*\]\s*(?:#.*)?$/i.test(trimmed)) {
      skip = true;
      changed = true;
      continue;
    }
    if (!skip) {
      kept.push(line);
    }
  }

  if (changed) {
    writeTextAtomic(
      CODEX_CONFIG_FILE,
      normalizeTrailingNewline(kept.join("\n").replace(/\n{3,}/g, "\n\n"))
    );
  }
}

function prepareLegacyLocalCleanup({
  allowInvalidHooksWithoutLegacyInstall = false,
  allowSkipLegacyCleanup = false,
} = {}) {
  if (
    allowSkipLegacyCleanup &&
    process.env.CC_PLUGIN_CODEX_SKIP_LEGACY_CLEANUP === "1"
  ) {
    process.stderr.write(
      "[cc] skipping legacy cleanup by explicit CC_PLUGIN_CODEX_SKIP_LEGACY_CLEANUP=1\n"
    );
    return null;
  }

  readPersonalMarketplace();
  const cacheEntries = listManagedPluginCacheEntries(CODEX_HOME);
  if (!validateManagedHooks(CODEX_HOME)) {
    if (
      allowInvalidHooksWithoutLegacyInstall &&
      !fs.existsSync(LEGACY_INSTALL_DIR) &&
      cacheEntries.length === 0
    ) {
      process.stderr.write(
        `[cc] ${path.join(CODEX_HOME, "hooks.json")} is invalid; installing without legacy managed-hook cleanup\n`
      );
      return [];
    }
    throw new Error(
      `Cannot safely remove managed integrations while ${path.join(CODEX_HOME, "hooks.json")} is invalid.` +
      (allowSkipLegacyCleanup
        ? " Repair it or retry with CC_PLUGIN_CODEX_SKIP_LEGACY_CLEANUP=1."
        : "")
    );
  }
  return [...new Set([
    LEGACY_INSTALL_DIR,
    PACKAGE_ROOT,
    ...cacheEntries.map((entry) => entry.cachePath),
  ])];
}

function cleanupLegacyLocalInstall(pluginRoots) {
  if (pluginRoots === null) {
    return;
  }
  for (const pluginRoot of pluginRoots) {
    if (!cleanupManagedGlobalIntegrations(pluginRoot, CODEX_HOME)) {
      throw new Error(
        `Managed integration cleanup was refused for ${path.join(CODEX_HOME, "hooks.json")}.`
      );
    }
  }
  removePersonalMarketplaceCcEntries();
  fs.rmSync(LEGACY_INSTALL_DIR, { recursive: true, force: true });
}

function isPluginAlreadyAbsent(error) {
  const message = String(error?.rpcMessage ?? "").trim();
  const pluginId = String.raw`["']?cc@[\w.-]+["']?`;
  return new RegExp(
    String.raw`^(?:(?:unknown|no such)\s+plugin\s*:?\s*${pluginId}|plugin\s+${pluginId}\s+(?:is\s+)?(?:not\s+(?:currently\s+)?installed|not\s+found|does\s+not\s+exist)|plugin\s+(?:not\s+found|does\s+not\s+exist)\s*:?\s*${pluginId})\.?$`,
    "i"
  ).test(message);
}

function isPluginUninstallRefused(error) {
  const message = String(error?.rpcMessage ?? "");
  return /\b(?:(?:permission|access)\s+denied|unauthorized|forbidden|not\s+authorized)\b/i.test(
    message
  );
}

async function addMarketplaceThroughCodex({ source, refName, sparsePaths }) {
  const params = { source };
  if (refName) {
    params.refName = refName;
  }
  if (sparsePaths && sparsePaths.length > 0) {
    params.sparsePaths = sparsePaths;
  }

  return await callCodexAppServer({
    cwd: PACKAGE_ROOT,
    method: "marketplace/add",
    params,
  });
}

async function installPluginThroughCodex(marketplacePath) {
  await callCodexAppServer({
    cwd: path.dirname(marketplacePath),
    method: "plugin/install",
    params: {
      marketplacePath,
      pluginName: PLUGIN_NAME,
      forceRemoteSync: false,
    },
  });
}

async function uninstallPluginThroughCodex(marketplaceName) {
  await callCodexAppServer({
    cwd: CODEX_HOME,
    method: "plugin/uninstall",
    params: {
      pluginId: pluginIdForMarketplace(marketplaceName),
      forceRemoteSync: false,
    },
  });
}

async function installOrUpdate() {
  const marketplaceConfig = resolveInstallerMarketplaceConfig();
  const legacyPluginRoots = prepareLegacyLocalCleanup({
    allowInvalidHooksWithoutLegacyInstall: true,
    allowSkipLegacyCleanup: true,
  });
  const hooksChanged = configureNativePluginHooks();

  const marketplace = await addMarketplaceThroughCodex(marketplaceConfig);
  const marketplacePath = path.join(
    marketplace.installedRoot,
    ".agents",
    "plugins",
    "marketplace.json"
  );
  await installPluginThroughCodex(marketplacePath);
  cleanupLegacyLocalInstall(legacyPluginRoots);

  console.log(`Installed ${PLUGIN_NAME} from ${marketplaceConfig.source} into the Codex plugin cache.`);
  if (hooksChanged) {
    console.log("Enabled [features].hooks and [features].plugin_hooks in ~/.codex/config.toml.");
    console.log("Restart Codex to make newly enabled native plugin hooks active in existing sessions.");
  }
}

async function uninstall() {
  const marketplaceConfig = resolveInstallerMarketplaceConfig();
  const legacyPluginRoots = prepareLegacyLocalCleanup({
    allowSkipLegacyCleanup: true,
  });
  const ignoreUninstallRpc =
    process.env.CC_PLUGIN_CODEX_IGNORE_UNINSTALL_RPC === "1";
  const signals = getManagedPluginSignals(CODEX_HOME);
  const observedMarketplaces = new Set([
    ...signals.sections.map((section) => section.marketplaceName),
    ...signals.cacheEntries.map((entry) => entry.marketplaceName),
  ]);
  const marketplaceNames = observedMarketplaces.size > 0
    ? observedMarketplaces
    : new Set([
        marketplaceConfig.marketplaceName,
        DEFAULT_MARKETPLACE_NAME,
        LEGACY_MARKETPLACE_NAME,
      ]);

  for (const marketplaceName of marketplaceNames) {
    try {
      await uninstallPluginThroughCodex(marketplaceName);
    } catch (error) {
      if (isPluginAlreadyAbsent(error)) {
        continue;
      }
      if (isPluginUninstallRefused(error) && !ignoreUninstallRpc) {
        throw new Error(
          `${error.message}\n` +
          "Retry with CC_PLUGIN_CODEX_IGNORE_UNINSTALL_RPC=1 only if local cleanup is intended."
        );
      }
      if (error?.rpcCode == null || error.rpcCode === -32601) {
        process.stderr.write(
          `[cc] Codex plugin/uninstall is unavailable; continuing with validated local cleanup: ${error.message}\n`
        );
        continue;
      }
      process.stderr.write(
        `[cc] plugin/uninstall failed for ${pluginIdForMarketplace(marketplaceName)}; ` +
        `continuing with validated local cleanup: ${error.message}\n`
      );
    }
  }

  cleanupLegacyLocalInstall(legacyPluginRoots);
  removeManagedPluginConfigSections();

  for (const cacheEntry of listManagedPluginCacheEntries(CODEX_HOME)) {
    fs.rmSync(cacheEntry.cachePath, { recursive: true, force: true });
  }

  const cacheDir = path.join(CODEX_HOME, "plugins", "cache");
  if (fs.existsSync(cacheDir)) {
    for (const marketplaceName of fs.readdirSync(cacheDir)) {
      removeIfEmpty(path.join(cacheDir, marketplaceName, PLUGIN_NAME));
      removeIfEmpty(path.join(cacheDir, marketplaceName));
    }
    removeIfEmpty(cacheDir);
  }
  try {
    fs.rmSync(
      path.join(CODEX_HOME, "plugins", "data", "cc", "managed-cleanup-refused"),
      { recursive: true, force: true }
    );
  } catch {
    // Removing a warning marker must not turn a completed uninstall into a failure.
  }

  console.log(`Uninstalled ${PLUGIN_NAME} from Codex plugin cache and removed legacy local installs.`);
}

const { command } = parseArgs(process.argv.slice(2));

if (command === "install" || command === "update") {
  await installOrUpdate();
} else {
  await uninstall();
}
