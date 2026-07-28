/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

const tempHomes = [];
const tempSources = [];
const tempTarballs = [];
const tempHelpers = [];

function makeTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-installer-home-"));
  tempHomes.push(homeDir);
  return homeDir;
}

function makeTempSource() {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-installer-src-"));
  tempSources.push(sourceDir);
  return sourceDir;
}

function makeTempTarball() {
  const tarballPath = path.join(
    os.tmpdir(),
    `cc-installer-tarball-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`
  );
  tempTarballs.push(tarballPath);
  return tarballPath;
}

function makeTempHelper(name) {
  const helperPath = path.join(
    os.tmpdir(),
    `cc-installer-${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`
  );
  tempHelpers.push(helperPath);
  return helperPath;
}

function copyFixture(sourceRoot) {
  const includePaths = [
    ".codex-plugin",
    "CHANGELOG.md",
    "LICENSE",
    "NOTICE",
    "README.md",
    "agents",
    "assets",
    "hooks",
    "internal-skills",
    "package.json",
    "prompts",
    "schemas",
    "scripts",
    "skills",
  ];

  for (const relativePath of includePaths) {
    const sourcePath = path.join(PROJECT_ROOT, relativePath);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    const destinationPath = path.join(sourceRoot, relativePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.cpSync(sourcePath, destinationPath, { recursive: true });
  }
}

function copyMarketplaceFixture(sourceRoot, marketplaceName = "sendbird") {
  const marketplaceRoot = path.join(sourceRoot, "sendbird-marketplace");
  const pluginRoot = path.join(marketplaceRoot, "plugins", "cc");
  copyFixture(pluginRoot);
  fs.mkdirSync(path.join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    `${JSON.stringify(
      {
        name: marketplaceName,
        interface: { displayName: "Sendbird Plugins" },
        plugins: [
          {
            name: "cc",
            source: {
              source: "local",
              path: "./plugins/cc",
            },
            policy: {
              installation: "AVAILABLE",
              authentication: "ON_USE",
            },
            category: "Coding",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return marketplaceRoot;
}

function spawnInstaller(command, homeDir, sourceRoot, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [path.join(sourceRoot, "scripts", "installer-cli.mjs"), command],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        CODEX_HOME: path.join(homeDir, ".codex"),
        ...extraEnv,
      },
      encoding: "utf8",
    }
  );
}

function spawnProjectInstaller(command, homeDir, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [path.join(PROJECT_ROOT, "scripts", "installer-cli.mjs"), command],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        CODEX_HOME: path.join(homeDir, ".codex"),
        ...extraEnv,
      },
      encoding: "utf8",
    }
  );
}

function runInstaller(command, homeDir, sourceRoot, extraEnv = {}) {
  const result = spawnInstaller(command, homeDir, sourceRoot, extraEnv);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function runLocalPluginInstaller(command, pluginRoot, homeDir, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(pluginRoot, "scripts", "local-plugin-install.mjs"), command, "--plugin-root", pluginRoot],
    {
      cwd: pluginRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        CODEX_HOME: path.join(homeDir, ".codex"),
        ...extraEnv,
      },
      encoding: "utf8",
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function runLocalPluginInstallerExpectFailure(command, pluginRoot, homeDir, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(pluginRoot, "scripts", "local-plugin-install.mjs"), command, "--plugin-root", pluginRoot],
    {
      cwd: pluginRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        CODEX_HOME: path.join(homeDir, ".codex"),
        ...extraEnv,
      },
      encoding: "utf8",
    }
  );

  assert.notEqual(result.status, 0, "expected local-plugin-install to fail");
  return result;
}

function createFakeCodex(homeDir, codexHome = path.join(homeDir, ".codex")) {
  const scriptPath = makeTempHelper("fake-codex-app-server");
  const logPath = path.join(codexHome, "fake-codex-requests.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    String.raw`import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [, , codexHome, logPath] = process.argv;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function readConfig(configPath) {
  return fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
}

function normalizeTrailingNewline(text) {
  return text.replace(/\s*$/, "") + "\n";
}

function removeSection(content, header) {
  const lines = content.split("\n");
  const kept = [];
  let skip = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (skip && trimmed.startsWith("[")) {
      skip = false;
    }
    if (!skip && trimmed === header) {
      skip = true;
      continue;
    }
    if (!skip) {
      kept.push(line);
    }
  }

  return normalizeTrailingNewline(kept.join("\n").replace(/\n{3,}/g, "\n\n"));
}

function appendPluginSection(configPath, pluginId) {
  const header = '[plugins."' + pluginId + '"]';
  const base = removeSection(readConfig(configPath), header).replace(/\s*$/, "");
  const next = [header, "enabled = true", ""].join("\n");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, (base ? base + "\n\n" : "") + next + "\n", "utf8");
}

function clearPluginSection(configPath, pluginId) {
  const header = '[plugins."' + pluginId + '"]';
  const next = removeSection(readConfig(configPath), header);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, next, "utf8");
}

function copyPlugin(sourceRoot, destinationRoot) {
  fs.rmSync(destinationRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destinationRoot), { recursive: true });
  fs.cpSync(sourceRoot, destinationRoot, { recursive: true });
}

function marketplaceRootFromPath(marketplacePath) {
  return path.dirname(path.dirname(path.dirname(marketplacePath)));
}

function handleInstall(params) {
  const marketplace = JSON.parse(fs.readFileSync(params.marketplacePath, "utf8"));
  const plugin = marketplace.plugins.find((entry) => entry.name === params.pluginName);
  if (!plugin) {
    throw new Error("missing plugin in marketplace");
  }
  const pluginId = params.pluginName + "@" + marketplace.name;
  const sourceRoot = path.resolve(marketplaceRootFromPath(params.marketplacePath), plugin.source.path);
  const cacheRoot = path.join(codexHome, "plugins", "cache", marketplace.name, params.pluginName, "local");
  copyPlugin(sourceRoot, cacheRoot);
  appendPluginSection(path.join(codexHome, "config.toml"), pluginId);
  return {
    authPolicy: plugin.policy?.authentication || "ON_USE",
    appsNeedingAuth: [],
  };
}

function handleUninstall(params) {
  const [pluginName, marketplaceName] = String(params.pluginId).split("@");
  const cacheRoot = path.join(codexHome, "plugins", "cache", marketplaceName, pluginName);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  clearPluginSection(path.join(codexHome, "config.toml"), params.pluginId);
  return {};
}

function logMessage(message) {
  fs.appendFileSync(logPath, JSON.stringify(message) + "\n", "utf8");
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  logMessage(message);

  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\n");
    return;
  }

  if (message.method === "plugin/install") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: handleInstall(message.params) }) + "\n");
    return;
  }

  if (message.method === "plugin/uninstall") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: handleUninstall(message.params) }) + "\n");
    return;
  }

  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    }) + "\n"
  );
});`,
    "utf8"
  );

  return {
    env: {
      CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
      CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([scriptPath, codexHome, logPath]),
    },
    logPath,
  };
}

function createMarketplaceAwareCodex(homeDir, codexHome = path.join(homeDir, ".codex")) {
  const scriptPath = makeTempHelper("fake-codex-app-server-marketplace");
  const logPath = path.join(codexHome, "fake-codex-requests.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const codexHome = ${JSON.stringify(codexHome)};
const logPath = ${JSON.stringify(logPath)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function readConfig(configPath) {
  return fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
}

function normalizeTrailingNewline(text) {
  return text.replace(/\\s*$/, "") + "\\n";
}

function removeSection(content, header) {
  const lines = content.split("\\n");
  const kept = [];
  let skip = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (skip && trimmed.startsWith("[")) {
      skip = false;
    }
    if (!skip && trimmed === header) {
      skip = true;
      continue;
    }
    if (!skip) {
      kept.push(line);
    }
  }
  return normalizeTrailingNewline(kept.join("\\n").replace(/\\n{3,}/g, "\\n\\n"));
}

function appendPluginSection(configPath, pluginId) {
  const header = '[plugins."' + pluginId + '"]';
  const base = removeSection(readConfig(configPath), header).replace(/\\s*$/, "");
  const next = [header, "enabled = true", ""].join("\\n");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, (base ? base + "\\n\\n" : "") + next + "\\n", "utf8");
}

function clearPluginSection(configPath, pluginId) {
  const header = '[plugins."' + pluginId + '"]';
  const next = removeSection(readConfig(configPath), header);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, next, "utf8");
}

function copyPlugin(sourceRoot, destinationRoot) {
  fs.rmSync(destinationRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destinationRoot), { recursive: true });
  fs.cpSync(sourceRoot, destinationRoot, { recursive: true });
}

function marketplaceRootFromPath(marketplacePath) {
  return path.dirname(path.dirname(path.dirname(marketplacePath)));
}

function installMarketplace(sourceRoot) {
  const marketplacePath = path.join(sourceRoot, ".agents", "plugins", "marketplace.json");
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  const installedRoot = path.join(codexHome, "marketplaces", marketplace.name);
  fs.rmSync(installedRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(installedRoot), { recursive: true });
  fs.cpSync(sourceRoot, installedRoot, { recursive: true });
  return {
    alreadyAdded: false,
    installedRoot,
    marketplaceName: marketplace.name,
  };
}

function handleInstall(params) {
  const marketplace = JSON.parse(fs.readFileSync(params.marketplacePath, "utf8"));
  const plugin = marketplace.plugins.find((entry) => entry.name === params.pluginName);
  if (!plugin) {
    throw new Error("missing plugin in marketplace");
  }
  const pluginId = params.pluginName + "@" + marketplace.name;
  const sourceRoot = path.resolve(marketplaceRootFromPath(params.marketplacePath), plugin.source.path);
  const cacheRoot = path.join(codexHome, "plugins", "cache", marketplace.name, params.pluginName, "local");
  copyPlugin(sourceRoot, cacheRoot);
  appendPluginSection(path.join(codexHome, "config.toml"), pluginId);
  return {
    authPolicy: plugin.policy?.authentication || "ON_USE",
    appsNeedingAuth: [],
  };
}

function handleUninstall(params) {
  const [pluginName, marketplaceName] = String(params.pluginId).split("@");
  fs.rmSync(
    path.join(codexHome, "plugins", "cache", marketplaceName, pluginName),
    { recursive: true, force: true }
  );
  clearPluginSection(path.join(codexHome, "config.toml"), params.pluginId);
  return {};
}

function logMessage(message) {
  fs.appendFileSync(logPath, JSON.stringify(message) + "\\n", "utf8");
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  logMessage(message);

  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\\n");
    return;
  }

  if (message.method === "marketplace/add") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: installMarketplace(message.params.source) }) + "\\n");
    return;
  }

  if (message.method === "plugin/install") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: handleInstall(message.params) }) + "\\n");
    return;
  }

  if (message.method === "plugin/uninstall") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: handleUninstall(message.params) }) + "\\n");
    return;
  }

  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    }) + "\\n"
  );
});\n`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);

  return {
    env: {
      CC_PLUGIN_CODEX_EXECUTABLE: scriptPath,
    },
    logPath,
  };
}

function createRpcErrorCodex(
  homeDir,
  rpcMessage = "Method not found",
  rpcCode = -32601,
  codexHome = path.join(homeDir, ".codex")
) {
  const scriptPath = makeTempHelper("fake-codex-app-server-method-not-found");
  const logPath = path.join(codexHome, "fake-codex-requests.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    String.raw`import fs from "node:fs";
import readline from "node:readline";

const [, , codexHome, logPath, rpcMessage, rpcCode] = process.argv;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function logMessage(message) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(message) + "\n", "utf8");
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  logMessage(message);

  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\n");
    return;
  }

  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: Number(rpcCode), message: rpcMessage },
    }) + "\n"
  );
});`,
    "utf8"
  );

  return {
    env: {
      CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
      CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([
        scriptPath,
        codexHome,
        logPath,
        rpcMessage,
        String(rpcCode),
      ]),
    },
    logPath,
  };
}

function createProcessErrorCodex(
  homeDir,
  stderrMessage,
  codexHome = path.join(homeDir, ".codex")
) {
  const scriptPath = makeTempHelper("fake-codex-app-server-process-error");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    scriptPath,
    String.raw`import readline from "node:readline";

const [, , stderrMessage] = process.argv;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\n");
    return;
  }
  process.stderr.write(stderrMessage + "\n");
  process.exit(1);
});`,
    "utf8"
  );

  return {
    env: {
      CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
      CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([
        scriptPath,
        stderrMessage,
      ]),
    },
  };
}

function createHangingCodex(homeDir, codexHome = path.join(homeDir, ".codex")) {
  const scriptPath = makeTempHelper("fake-codex-app-server-hang");
  const logPath = path.join(codexHome, "fake-codex-requests.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    String.raw`import fs from "node:fs";
import readline from "node:readline";

const [, , codexHome, logPath] = process.argv;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function logMessage(message) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(message) + "\n", "utf8");
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  logMessage(message);

  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\n");
    return;
  }

  // Intentionally never respond to plugin/install to exercise timeout fallback.
});`,
    "utf8"
  );

  return {
    env: {
      CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
      CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([scriptPath, codexHome, logPath]),
      CC_PLUGIN_CODEX_APP_SERVER_TIMEOUT_MS: "100",
    },
    logPath,
  };
}

function createUninstallOrderCodex(
  homeDir,
  codexHome = path.join(homeDir, ".codex"),
  corruptHooks = false
) {
  const scriptPath = makeTempHelper("fake-codex-app-server-uninstall-order");
  const logPath = path.join(codexHome, "fake-codex-requests.log");
  const inspectPath = path.join(codexHome, "uninstall-order.json");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    String.raw`import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [, , codexHome, logPath, inspectPath, corruptHooks] = process.argv;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function readConfig(configPath) {
  return fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
}

function normalizeTrailingNewline(text) {
  return text.replace(/\s*$/, "") + "\n";
}

function removeSection(content, header) {
  const lines = content.split("\n");
  const kept = [];
  let skip = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (skip && trimmed.startsWith("[")) {
      skip = false;
    }
    if (!skip && trimmed === header) {
      skip = true;
      continue;
    }
    if (!skip) {
      kept.push(line);
    }
  }

  return normalizeTrailingNewline(kept.join("\n").replace(/\n{3,}/g, "\n\n"));
}

function appendPluginSection(configPath, pluginId) {
  const header = '[plugins."' + pluginId + '"]';
  const base = removeSection(readConfig(configPath), header).replace(/\s*$/, "");
  const next = [header, "enabled = true", ""].join("\n");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, (base ? base + "\n\n" : "") + next + "\n", "utf8");
}

function clearPluginSection(configPath, pluginId) {
  const header = '[plugins."' + pluginId + '"]';
  const next = removeSection(readConfig(configPath), header);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, next, "utf8");
}

function copyPlugin(sourceRoot, destinationRoot) {
  fs.rmSync(destinationRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destinationRoot), { recursive: true });
  fs.cpSync(sourceRoot, destinationRoot, { recursive: true });
}

function marketplaceRootFromPath(marketplacePath) {
  return path.dirname(path.dirname(path.dirname(marketplacePath)));
}

function handleInstall(params) {
  const marketplace = JSON.parse(fs.readFileSync(params.marketplacePath, "utf8"));
  const plugin = marketplace.plugins.find((entry) => entry.name === params.pluginName);
  if (!plugin) {
    throw new Error("missing plugin in marketplace");
  }
  const pluginId = params.pluginName + "@" + marketplace.name;
  const sourceRoot = path.resolve(marketplaceRootFromPath(params.marketplacePath), plugin.source.path);
  const cacheRoot = path.join(codexHome, "plugins", "cache", marketplace.name, params.pluginName, "local");
  copyPlugin(sourceRoot, cacheRoot);
  appendPluginSection(path.join(codexHome, "config.toml"), pluginId);
  return {
    authPolicy: plugin.policy?.authentication || "ON_USE",
    appsNeedingAuth: [],
  };
}

function handleUninstall(params) {
  const hooksPath = path.join(codexHome, "hooks.json");
  const hooksText = fs.existsSync(hooksPath) ? fs.readFileSync(hooksPath, "utf8") : "";
  writeJson(inspectPath, {
    managedHooksPresentAtUninstallCall:
      hooksText.includes("session-lifecycle-hook.mjs") ||
      hooksText.includes("stop-review-gate-hook.mjs") ||
      hooksText.includes("unread-result-hook.mjs"),
  });
  if (corruptHooks === "true") {
    fs.writeFileSync(hooksPath, "{invalid\n", "utf8");
  }

  const [pluginName, marketplaceName] = String(params.pluginId).split("@");
  const cacheRoot = path.join(codexHome, "plugins", "cache", marketplaceName, pluginName);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  clearPluginSection(path.join(codexHome, "config.toml"), params.pluginId);
  return {};
}

function logMessage(message) {
  fs.appendFileSync(logPath, JSON.stringify(message) + "\n", "utf8");
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  logMessage(message);

  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\n");
    return;
  }

  if (message.method === "plugin/install") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: handleInstall(message.params) }) + "\n");
    return;
  }

  if (message.method === "plugin/uninstall") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: handleUninstall(message.params) }) + "\n");
    return;
  }

  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    }) + "\n"
  );
});`,
    "utf8"
  );

  return {
    env: {
      CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
      CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([
        scriptPath,
        codexHome,
        logPath,
        inspectPath,
        String(corruptHooks),
      ]),
    },
    logPath,
    inspectPath,
  };
}

function readFakeCodexLog(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function createFixtureTarball(sourceRoot) {
  const tarballPath = makeTempTarball();
  const result = spawnSync("tar", ["-czf", tarballPath, "-C", sourceRoot, "."], {
    cwd: sourceRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return tarballPath;
}

function runShellWrapper(scriptName, homeDir, sourceRoot, extraEnv = {}) {
  const tarballPath = createFixtureTarball(sourceRoot);
  const result = spawnSync("bash", [path.join(PROJECT_ROOT, "scripts", scriptName)], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODEX_HOME: path.join(homeDir, ".codex"),
      CC_PLUGIN_CODEX_TARBALL_URL: `file://${tarballPath}`,
      ...extraEnv,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function countOccurrences(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

afterEach(() => {
  while (tempHomes.length > 0) {
    fs.rmSync(tempHomes.pop(), { recursive: true, force: true });
  }
  while (tempSources.length > 0) {
    fs.rmSync(tempSources.pop(), { recursive: true, force: true });
  }
  while (tempTarballs.length > 0) {
    fs.rmSync(tempTarballs.pop(), { force: true });
  }
  while (tempHelpers.length > 0) {
    fs.rmSync(tempHelpers.pop(), { force: true });
  }
});

describe("installer-cli", () => {
  it("installs through Codex marketplace/add and plugin/install into the plugin cache", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    const configFile = path.join(homeDir, ".codex", "config.toml");
    const config = fs.readFileSync(configFile, "utf8");
    const marketplaceFile = path.join(homeDir, ".agents", "plugins", "marketplace.json");
    const hooksFile = path.join(homeDir, ".codex", "hooks.json");
    const legacyInstallDir = path.join(homeDir, ".codex", "plugins", "cc");
    const cacheDir = path.join(homeDir, ".codex", "plugins", "cache", "sendbird", "cc", "local");
    const cachedReviewSkill = path.join(cacheDir, "skills", "review", "SKILL.md");
    const requests = readFakeCodexLog(fakeCodex.logPath);
    const pluginInstallRequest = requests.find((request) => request.method === "plugin/install");

    assert.match(config, /\[plugins\."cc@sendbird"\]/);
    assert.match(config, /hooks = true/);
    assert.match(config, /plugin_hooks = true/);
    assert.ok(!fs.existsSync(legacyInstallDir), "installer should not create a stable local plugin root");
    assert.ok(!fs.existsSync(hooksFile), "installer should not write global hooks.json");
    assert.ok(fs.existsSync(cachedReviewSkill));
    assert.match(fs.readFileSync(cachedReviewSkill, "utf8"), /<plugin-root>\/scripts\/claude-companion\.mjs/);
    assert.ok(
      requests.some((request) => request.method === "marketplace/add"),
      "installer should call Codex marketplace/add"
    );
    assert.equal(
      pluginInstallRequest?.params?.marketplacePath,
      path.join(homeDir, ".codex", "marketplaces", "sendbird", ".agents", "plugins", "marketplace.json")
    );
    assert.ok(
      !fs.existsSync(marketplaceFile),
      "official marketplace installs should not mutate the personal marketplace file"
    );
  });

  it("does not fall back to local config activation when marketplace/add is unavailable", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createRpcErrorCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);
    const legacyInstallDir = path.join(homeDir, ".codex", "plugins", "cc");
    const staleSkillPath = path.join(homeDir, ".codex", "skills", "cc-review", "SKILL.md");
    fs.mkdirSync(legacyInstallDir, { recursive: true });
    fs.writeFileSync(path.join(legacyInstallDir, "keep.txt"), "keep\n", "utf8");
    fs.mkdirSync(path.dirname(staleSkillPath), { recursive: true });
    fs.writeFileSync(staleSkillPath, "stale wrapper\n", "utf8");

    const result = spawnSync(
      process.execPath,
      [path.join(sourceRoot, "scripts", "installer-cli.mjs"), "install"],
      {
        cwd: sourceRoot,
        env: {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
          CODEX_HOME: path.join(homeDir, ".codex"),
          ...fakeCodex.env,
          CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
          CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
        },
        encoding: "utf8",
      }
    );

    const config = fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8");

    assert.notEqual(result.status, 0, "marketplace/add failure should fail install");
    assert.doesNotMatch(config, /\[plugins\."cc@sendbird"\]/);
    assert.ok(fs.existsSync(path.join(legacyInstallDir, "keep.txt")));
    assert.ok(fs.existsSync(staleSkillPath));
    assert.ok(!fs.existsSync(path.join(homeDir, ".agents", "plugins", "marketplace.json")));
  });

  it("rejects direct local checkout installs", () => {
    const homeDir = makeTempHome();
    const installDir = path.join(homeDir, ".codex", "plugins", "cc");
    copyFixture(installDir);

    const result = runLocalPluginInstallerExpectFailure("install", installDir, homeDir);

    assert.match(result.stderr, /Local checkout installs are no longer supported/i);
    assert.match(result.stderr, /codex plugin marketplace add CBEPX\/cc-plugin-codex/i);
  });

  it("installs successfully when CODEX_HOME is outside the user's home directory", () => {
    const homeDir = makeTempHome();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-external-codex-home-"));
    tempHomes.push(codexHome);
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir, codexHome);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CODEX_HOME: codexHome,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    const cacheDir = path.join(codexHome, "plugins", "cache", "sendbird", "cc", "local");

    assert.ok(fs.existsSync(path.join(cacheDir, "scripts", "installer-cli.mjs")));
  });

  it("updates a symlinked config.toml target without replacing the link or mode", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);
    const codexHome = path.join(homeDir, ".codex");
    const configFile = path.join(codexHome, "config.toml");
    const managedConfig = path.join(homeDir, "dotfiles", "config.toml");
    fs.mkdirSync(path.dirname(managedConfig), { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(managedConfig, "[features]\nhooks = false\n", "utf8");
    fs.chmodSync(managedConfig, 0o644);
    fs.symlinkSync(managedConfig, configFile);

    runInstaller("install", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    assert.equal(fs.lstatSync(configFile).isSymbolicLink(), true);
    assert.equal(fs.statSync(managedConfig).mode & 0o777, 0o644);
    const config = fs.readFileSync(managedConfig, "utf8");
    assert.match(config, /hooks = true/);
    assert.match(config, /plugin_hooks = true/);
    assert.match(config, /\[plugins\."cc@sendbird"\]/);
  });

  it("removes stale fallback skill wrappers and legacy global hooks when official install succeeds", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    const staleSkillPath = path.join(homeDir, ".codex", "skills", "cc-review", "SKILL.md");
    const stalePromptPath = path.join(homeDir, ".codex", "prompts", "cc-review.md");
    const unrelatedSkillPath = path.join(homeDir, ".codex", "skills", "keep-me", "SKILL.md");
    const legacyInstallDir = path.join(homeDir, ".codex", "plugins", "cc");
    const hooksFile = path.join(homeDir, ".codex", "hooks.json");

    fs.mkdirSync(path.dirname(staleSkillPath), { recursive: true });
    fs.writeFileSync(staleSkillPath, "stale wrapper\n", "utf8");
    fs.mkdirSync(path.dirname(stalePromptPath), { recursive: true });
    fs.writeFileSync(stalePromptPath, "stale prompt\n", "utf8");
    fs.mkdirSync(path.dirname(unrelatedSkillPath), { recursive: true });
    fs.writeFileSync(unrelatedSkillPath, "leave me alone\n", "utf8");
    fs.mkdirSync(path.join(legacyInstallDir, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(legacyInstallDir, "hooks", "session-lifecycle-hook.mjs"), "", "utf8");
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          SessionStart: [{
            matcher: "",
            hooks: [{
              type: "command",
              command: `node "${path.join(legacyInstallDir, "hooks", "session-lifecycle-hook.mjs")}"`,
            }],
          }],
        },
      }, null, 2) + "\n",
      "utf8"
    );

    runInstaller("install", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    assert.ok(!fs.existsSync(legacyInstallDir));
    assert.ok(!fs.existsSync(hooksFile));
    assert.ok(!fs.existsSync(staleSkillPath));
    assert.ok(!fs.existsSync(stalePromptPath));
    assert.ok(fs.existsSync(unrelatedSkillPath), "official install should not remove unrelated user skills");
  });

  it("uninstalls cleanly while preserving unrelated user config", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    const marketplaceDir = path.join(homeDir, ".agents", "plugins");
    fs.mkdirSync(marketplaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceDir, "marketplace.json"),
      JSON.stringify(
        {
          name: "local-plugins",
          interface: { displayName: "Local Plugins" },
          plugins: [
            {
              name: "other",
              source: { source: "local", path: "./.codex/plugins/other" },
              policy: { installation: "AVAILABLE", authentication: "ON_USE" },
              category: "Coding",
            },
          ],
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      [
        '[plugins."github@openai-curated"]',
        "enabled = true",
        "",
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(codexDir, "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: "",
                hooks: [
                  {
                    type: "command",
                    command: "echo custom-hook",
                  },
                ],
              },
            ],
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    runInstaller("install", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    const marketplacePath = path.join(homeDir, ".agents", "plugins", "marketplace.json");
    const marketplaceBeforeUninstall = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
    marketplaceBeforeUninstall.plugins.push({
      name: "cc",
      source: { source: "local", path: "./stale/cc" },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" },
      category: "Coding",
    });
    fs.writeFileSync(marketplacePath, JSON.stringify(marketplaceBeforeUninstall, null, 2) + "\n", "utf8");

    fs.appendFileSync(
      path.join(homeDir, ".codex", "config.toml"),
      '\n[plugins."cc@sendbird"]\nenabled = true\n',
      "utf8"
    );

    runInstaller("uninstall", homeDir, sourceRoot, fakeCodex.env);

    const installDir = path.join(homeDir, ".codex", "plugins", "cc");
    const marketplace = JSON.parse(
      fs.readFileSync(marketplacePath, "utf8")
    );
    const config = fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8");
    const hooks = JSON.parse(fs.readFileSync(path.join(homeDir, ".codex", "hooks.json"), "utf8"));

    assert.ok(!fs.existsSync(installDir));
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, "other");
    assert.match(config, /\[plugins\."github@openai-curated"\]/);
    assert.doesNotMatch(config, /\[plugins\."cc@local-plugins"\]/);
    assert.doesNotMatch(config, /\[plugins\."cc@sendbird"\]/);
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, "echo custom-hook");
  });

  it("removes versioned marketplace cache entries during uninstall", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    const versionedCacheDir = path.join(
      homeDir,
      ".codex",
      "plugins",
      "cache",
      "sendbird",
      "cc",
      "1.0.8"
    );
    fs.mkdirSync(path.join(versionedCacheDir, "skills"), { recursive: true });
    fs.appendFileSync(
      path.join(homeDir, ".codex", "config.toml"),
      '\n[plugins."cc@sendbird"]\nenabled = true\n',
      "utf8"
    );

    runInstaller("uninstall", homeDir, sourceRoot, fakeCodex.env);

    assert.ok(!fs.existsSync(versionedCacheDir));
    assert.ok(!fs.existsSync(path.dirname(versionedCacheDir)));
  });

  it("removes legacy managed hook commands that point at versioned marketplace cache roots", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    const codexDir = path.join(homeDir, ".codex");
    const versionedCacheDir = path.join(
      codexDir,
      "plugins",
      "cache",
      "sendbird",
      "cc",
      "1.0.9"
    );
    const hooksFile = path.join(codexDir, "hooks.json");

    fs.mkdirSync(path.join(versionedCacheDir, "hooks"), { recursive: true });
    fs.appendFileSync(
      path.join(codexDir, "config.toml"),
      '\n[plugins."cc@sendbird"]\nenabled = true\n',
      "utf8"
    );
    fs.writeFileSync(
      hooksFile,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: "",
                hooks: [
                  {
                    type: "command",
                    command: `node '${path.join(versionedCacheDir, "hooks", "session-lifecycle-hook.mjs")}'`,
                  },
                ],
              },
            ],
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    runInstaller("uninstall", homeDir, sourceRoot, fakeCodex.env);

    assert.ok(!fs.existsSync(hooksFile), "uninstall should remove managed hooks even when they point at a versioned cache root");
  });

  it("does not mutate managed hooks before Codex plugin/uninstall succeeds", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createUninstallOrderCodex(homeDir);
    copyFixture(sourceRoot);
    const codexDir = path.join(homeDir, ".codex");
    const cacheDir = path.join(codexDir, "plugins", "cache", "sendbird", "cc", "local");
    const hooksFile = path.join(codexDir, "hooks.json");
    fs.mkdirSync(path.join(cacheDir, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      '[plugins."cc@sendbird"]\nenabled = true\n',
      "utf8"
    );
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          SessionStart: [{
            matcher: "",
            hooks: [{
              type: "command",
              command: `node "${path.join(cacheDir, "hooks", "session-lifecycle-hook.mjs")}"`,
            }],
          }],
        },
      }, null, 2) + "\n",
      "utf8"
    );

    runInstaller("uninstall", homeDir, sourceRoot, fakeCodex.env);

    const inspect = JSON.parse(fs.readFileSync(fakeCodex.inspectPath, "utf8"));
    assert.equal(
      inspect.managedHooksPresentAtUninstallCall,
      true,
      "managed hooks must remain intact until Codex accepts plugin/uninstall"
    );
    const uninstallIds = readFakeCodexLog(fakeCodex.logPath)
      .filter((message) => message.method === "plugin/uninstall")
      .map((message) => message.params.pluginId);
    assert.deepEqual(uninstallIds, ["cc@sendbird"]);
    assert.equal(fs.existsSync(hooksFile), false);
  });

  it("does not delete legacy files when hooks become invalid during uninstall", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const codexHome = path.join(homeDir, ".codex");
    const legacyDir = path.join(codexHome, "plugins", "cc");
    const hooksFile = path.join(codexHome, "hooks.json");
    const fakeCodex = createUninstallOrderCodex(homeDir, codexHome, true);
    copyFixture(sourceRoot);
    fs.mkdirSync(path.join(legacyDir, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "keep.txt"), "keep\n", "utf8");
    fs.writeFileSync(
      hooksFile,
      `${JSON.stringify({
        hooks: {
          SessionStart: [{
            hooks: [{
              command: `node "${path.join(legacyDir, "hooks", "session-lifecycle-hook.mjs")}"`,
            }],
          }],
        },
      })}\n`,
      "utf8"
    );

    const result = spawnInstaller("uninstall", homeDir, sourceRoot, fakeCodex.env);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cleanup was refused/);
    assert.doesNotMatch(result.stdout, /Uninstalled cc/);
    assert.equal(fs.existsSync(path.join(legacyDir, "keep.txt")), true);
    assert.equal(fs.readFileSync(hooksFile, "utf8"), "{invalid\n");

    const retry = spawnInstaller("uninstall", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_SKIP_LEGACY_CLEANUP: "1",
    });

    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    assert.match(retry.stderr, /skipping legacy cleanup/);
    assert.match(retry.stdout, /Uninstalled cc/);
    assert.equal(fs.existsSync(path.join(legacyDir, "keep.txt")), true);
    assert.equal(fs.readFileSync(hooksFile, "utf8"), "{invalid\n");
  });

  it("fails without local mutation when Codex explicitly refuses uninstall", () => {
    const homeDir = makeTempHome();
    const codexHome = path.join(homeDir, ".codex");
    const legacyDir = path.join(codexHome, "plugins", "cc");
    const configFile = path.join(codexHome, "config.toml");
    const fakeCodex = createRpcErrorCodex(
      homeDir,
      "Permission denied",
      -32000
    );
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "keep.txt"), "keep\n", "utf8");
    fs.writeFileSync(configFile, '[plugins."cc@cbepx"]\nenabled = true\n', "utf8");

    const result = spawnProjectInstaller("uninstall", homeDir, fakeCodex.env);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Permission denied/);
    assert.match(result.stderr, /CC_PLUGIN_CODEX_IGNORE_UNINSTALL_RPC=1/);
    assert.doesNotMatch(result.stdout, /Uninstalled cc/);
    assert.equal(fs.existsSync(path.join(legacyDir, "keep.txt")), true);
    assert.match(fs.readFileSync(configFile, "utf8"), /cc@cbepx/);
  });

  it("recognizes explicit permission and authorization refusals", () => {
    for (const message of [
      "Permission   denied",
      "Access denied",
      "Unauthorized",
      "Forbidden",
      "Plugin uninstall is not   authorized",
    ]) {
      const homeDir = makeTempHome();
      const codexHome = path.join(homeDir, ".codex");
      const fakeCodex = createRpcErrorCodex(homeDir, message, -32000);
      fs.writeFileSync(
        path.join(codexHome, "config.toml"),
        '[plugins."cc@cbepx"]\nenabled = true\n',
        "utf8"
      );

      const result = spawnProjectInstaller("uninstall", homeDir, fakeCodex.env);

      assert.notEqual(result.status, 0, message);
      assert.match(result.stderr, /CC_PLUGIN_CODEX_IGNORE_UNINSTALL_RPC=1/);
    }
  });

  it("does not mistake process-level permission stderr for an uninstall RPC refusal", () => {
    const homeDir = makeTempHome();
    const codexHome = path.join(homeDir, ".codex");
    const legacyDir = path.join(codexHome, "plugins", "cc");
    const configFile = path.join(codexHome, "config.toml");
    const fakeCodex = createProcessErrorCodex(homeDir, "Permission denied by policy");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "keep.txt"), "keep\n", "utf8");
    fs.writeFileSync(configFile, '[plugins."cc@cbepx"]\nenabled = true\n', "utf8");

    const result = spawnProjectInstaller("uninstall", homeDir, fakeCodex.env);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /Permission denied by policy/);
    assert.match(result.stderr, /plugin\/uninstall is unavailable/);
    assert.doesNotMatch(result.stderr, /CC_PLUGIN_CODEX_IGNORE_UNINSTALL_RPC=1/);
    assert.equal(fs.existsSync(legacyDir), false);
    assert.doesNotMatch(fs.readFileSync(configFile, "utf8"), /cc@cbepx/);
  });

  it("continues local cleanup after an unrecognized uninstall error", () => {
    const homeDir = makeTempHome();
    const codexHome = path.join(homeDir, ".codex");
    const legacyDir = path.join(codexHome, "plugins", "cc");
    const configFile = path.join(codexHome, "config.toml");
    const fakeCodex = createRpcErrorCodex(
      homeDir,
      "plugin cc@cbepx: unknown error",
      -32000
    );
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "keep.txt"), "keep\n", "utf8");
    fs.writeFileSync(configFile, '[plugins."cc@cbepx"]\nenabled = true\n', "utf8");

    const result = spawnProjectInstaller("uninstall", homeDir, fakeCodex.env);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /unknown error/);
    assert.match(result.stderr, /continuing with validated local cleanup/);
    assert.match(result.stdout, /Uninstalled cc/);
    assert.equal(fs.existsSync(legacyDir), false);
    assert.doesNotMatch(fs.readFileSync(configFile, "utf8"), /cc@cbepx/);
  });

  it("allows explicit recovery after a permission refusal", () => {
    const homeDir = makeTempHome();
    const codexHome = path.join(homeDir, ".codex");
    const legacyDir = path.join(codexHome, "plugins", "cc");
    const configFile = path.join(codexHome, "config.toml");
    const fakeCodex = createRpcErrorCodex(homeDir, "Permission denied", -32000);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "keep.txt"), "keep\n", "utf8");
    fs.writeFileSync(configFile, '[plugins."cc@cbepx"]\nenabled = true\n', "utf8");

    const result = spawnProjectInstaller("uninstall", homeDir, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_IGNORE_UNINSTALL_RPC: "1",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /Permission denied/);
    assert.match(result.stdout, /Uninstalled cc/);
    assert.equal(fs.existsSync(legacyDir), false);
    assert.doesNotMatch(fs.readFileSync(configFile, "utf8"), /cc@cbepx/);
  });

  it("uses the legacy-cleanup escape hatch without retaining plugin config or cache", () => {
    const homeDir = makeTempHome();
    const codexHome = path.join(homeDir, ".codex");
    const legacyDir = path.join(codexHome, "plugins", "cc");
    const cacheDir = path.join(codexHome, "plugins", "cache", "cbepx", "cc", "1.5.1");
    const configFile = path.join(codexHome, "config.toml");
    const hooksFile = path.join(codexHome, "hooks.json");
    const fakeCodex = createRpcErrorCodex(
      homeDir,
      "Plugin cc@cbepx is not installed",
      -32004
    );
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "keep.txt"), "keep\n", "utf8");
    fs.writeFileSync(configFile, '[plugins."cc@cbepx"]\nenabled = true\n', "utf8");
    fs.writeFileSync(hooksFile, "{invalid\n", "utf8");

    const result = spawnProjectInstaller("uninstall", homeDir, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_SKIP_LEGACY_CLEANUP: "1",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /skipping legacy cleanup/);
    assert.equal(fs.existsSync(legacyDir), true);
    assert.equal(fs.readFileSync(hooksFile, "utf8"), "{invalid\n");
    assert.equal(fs.existsSync(cacheDir), false);
    assert.doesNotMatch(fs.readFileSync(configFile, "utf8"), /cc@cbepx/);
  });

  it("completes validated local cleanup when Codex is unavailable", () => {
    const homeDir = makeTempHome();
    const codexHome = path.join(homeDir, ".codex");
    const legacyDir = path.join(codexHome, "plugins", "cc");
    const hooksFile = path.join(codexHome, "hooks.json");
    const configFile = path.join(codexHome, "config.toml");
    fs.mkdirSync(path.join(legacyDir, "hooks"), { recursive: true });
    fs.writeFileSync(configFile, '[plugins."cc@cbepx"]\nenabled = true\n', "utf8");
    fs.writeFileSync(
      hooksFile,
      `${JSON.stringify({
        hooks: {
          SessionStart: [{
            hooks: [{
              command: `node "${path.join(legacyDir, "hooks", "session-lifecycle-hook.mjs")}"`,
            }],
          }],
        },
      })}\n`,
      "utf8"
    );

    const result = spawnProjectInstaller("uninstall", homeDir, {
      CC_PLUGIN_CODEX_EXECUTABLE: path.join(homeDir, "missing-codex"),
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /continuing with validated local cleanup/);
    assert.equal(fs.existsSync(legacyDir), false);
    assert.equal(fs.existsSync(hooksFile), false);
    assert.doesNotMatch(fs.readFileSync(configFile, "utf8"), /cc@cbepx/);
  });

  it("supports Codex versions without plugin/uninstall", () => {
    const homeDir = makeTempHome();
    const codexHome = path.join(homeDir, ".codex");
    const legacyDir = path.join(codexHome, "plugins", "cc");
    const configFile = path.join(codexHome, "config.toml");
    const fakeCodex = createRpcErrorCodex(homeDir);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(configFile, '[plugins."cc@cbepx"]\nenabled = true\n', "utf8");

    const result = spawnProjectInstaller("uninstall", homeDir, fakeCodex.env);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /Codex plugin\/uninstall is unavailable/);
    assert.equal(fs.existsSync(legacyDir), false);
    assert.doesNotMatch(fs.readFileSync(configFile, "utf8"), /cc@cbepx/);
  });

  it("continues attempting observed marketplaces when plugin/uninstall is unavailable", () => {
    const homeDir = makeTempHome();
    const codexHome = path.join(homeDir, ".codex");
    const configFile = path.join(codexHome, "config.toml");
    const fakeCodex = createRpcErrorCodex(homeDir);
    fs.writeFileSync(
      configFile,
      [
        '[plugins."cc@sendbird"]',
        "enabled = true",
        "",
        '[plugins."cc@cbepx"]',
        "enabled = true",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = spawnProjectInstaller("uninstall", homeDir, fakeCodex.env);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const uninstallIds = readFakeCodexLog(fakeCodex.logPath)
      .filter((message) => message.method === "plugin/uninstall")
      .map((message) => message.params.pluginId);
    assert.deepEqual(uninstallIds, ["cc@sendbird", "cc@cbepx"]);
  });

  it("keeps uninstall idempotent when Codex confirms the plugin is absent", () => {
    const homeDir = makeTempHome();
    const fakeCodex = createRpcErrorCodex(
      homeDir,
      "Plugin cc@cbepx is not installed",
      -32004
    );

    const result = spawnProjectInstaller("uninstall", homeDir, fakeCodex.env);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stderr, /plugin\/uninstall failed/);
    assert.match(result.stdout, /Uninstalled cc/);
  });

  it("ignores unrecognized absent errors for unobserved fallback plugin ids", () => {
    const homeDir = makeTempHome();
    const legacyDir = path.join(homeDir, ".codex", "plugins", "cc");
    const fakeCodex = createRpcErrorCodex(
      homeDir,
      "Unknown plugin: cc@cbepx",
      -32004
    );
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "keep.txt"), "keep\n", "utf8");

    const result = spawnProjectInstaller("uninstall", homeDir, fakeCodex.env);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(legacyDir), false);
    assert.match(result.stdout, /Uninstalled cc/);
  });

  it("attempts every marketplace observed in config or cache", () => {
    const homeDir = makeTempHome();
    const codexHome = path.join(homeDir, ".codex");
    const configFile = path.join(codexHome, "config.toml");
    const refusalMarker = path.join(
      codexHome,
      "plugins",
      "data",
      "cc",
      "managed-cleanup-refused"
    );
    const fakeCodex = createFakeCodex(homeDir);
    fs.mkdirSync(
      path.join(codexHome, "plugins", "cache", "sendbird", "cc", "1.0.0"),
      { recursive: true }
    );
    fs.mkdirSync(
      path.join(codexHome, "plugins", "cache", "cbepx", "cc", "1.5.1"),
      { recursive: true }
    );
    fs.mkdirSync(path.dirname(refusalMarker), { recursive: true });
    fs.writeFileSync(refusalMarker, "old-reason\n", "utf8");
    fs.writeFileSync(
      configFile,
      [
        '[plugins."cc@sendbird"]',
        "enabled = true",
        "",
        '[plugins."cc@cbepx"]',
        "enabled = true",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = spawnProjectInstaller("uninstall", homeDir, fakeCodex.env);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const uninstallIds = readFakeCodexLog(fakeCodex.logPath)
      .filter((message) => message.method === "plugin/uninstall")
      .map((message) => message.params.pluginId);
    assert.deepEqual(uninstallIds, ["cc@sendbird", "cc@cbepx"]);
    assert.equal(fs.existsSync(refusalMarker), false);
  });

  it("does not clean managed files when personal marketplace JSON is invalid", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    copyFixture(sourceRoot);

    const marketplaceDir = path.join(homeDir, ".agents", "plugins");
    const codexHome = path.join(homeDir, ".codex");
    const hooksFile = path.join(codexHome, "hooks.json");
    const wrapperDir = path.join(codexHome, "skills", "cc-review");
    const hooksText = `${JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `node "${path.join(sourceRoot, "hooks", "session-lifecycle-hook.mjs")}"`,
              },
            ],
          },
        ],
      },
    })}\n`;

    fs.mkdirSync(marketplaceDir, { recursive: true });
    fs.mkdirSync(wrapperDir, { recursive: true });
    fs.writeFileSync(path.join(marketplaceDir, "marketplace.json"), "{invalid\n", "utf8");
    fs.writeFileSync(hooksFile, hooksText, "utf8");

    const result = spawnInstaller("uninstall", homeDir, sourceRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot update invalid marketplace JSON/);
    assert.doesNotMatch(result.stdout, /Uninstalled cc/);
    assert.equal(fs.readFileSync(hooksFile, "utf8"), hooksText);
    assert.equal(fs.existsSync(wrapperDir), true);
  });

  it("refuses install and uninstall when malformed hooks put legacy data at risk", () => {
    for (const command of ["install", "uninstall"]) {
      const homeDir = makeTempHome();
      const codexHome = path.join(homeDir, ".codex");
      const legacyDir = path.join(codexHome, "plugins", "cc");
      const hooksFile = path.join(codexHome, "hooks.json");
      const wrapperDir = path.join(codexHome, "skills", "cc-review");
      const configFile = path.join(codexHome, "config.toml");
      const fakeCodex = createFakeCodex(homeDir);
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.mkdirSync(wrapperDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "keep.txt"), "keep\n", "utf8");
      fs.writeFileSync(hooksFile, "{invalid\n", "utf8");
      fs.writeFileSync(configFile, '[plugins."cc@cbepx"]\nenabled = true\n', "utf8");

      const result = spawnProjectInstaller(command, homeDir, fakeCodex.env);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /hooks\.json.*invalid/i);
      assert.doesNotMatch(result.stdout, /Installed cc|Uninstalled cc/);
      assert.equal(fs.existsSync(path.join(legacyDir, "keep.txt")), true);
      assert.equal(fs.existsSync(wrapperDir), true);
      assert.match(fs.readFileSync(configFile, "utf8"), /cc@cbepx/);
      assert.equal(fs.existsSync(fakeCodex.logPath), false);
    }
  });

  it("installs with malformed hooks JSON when no legacy managed install exists", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const codexHome = path.join(homeDir, ".codex");
    const hooksFile = path.join(codexHome, "hooks.json");
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(hooksFile, "{invalid\n", "utf8");

    const result = spawnInstaller("install", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /installing without legacy managed-hook cleanup/);
    assert.equal(fs.readFileSync(hooksFile, "utf8"), "{invalid\n");
    assert.equal(
      fs.existsSync(
        path.join(codexHome, "plugins", "cache", "sendbird", "cc", "local")
      ),
      true
    );
  });

  it("allows install to preserve risky legacy data through the explicit escape hatch", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const codexHome = path.join(homeDir, ".codex");
    const legacyDir = path.join(codexHome, "plugins", "cc");
    const hooksFile = path.join(codexHome, "hooks.json");
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "keep.txt"), "keep\n", "utf8");
    fs.writeFileSync(hooksFile, "{invalid\n", "utf8");

    const result = spawnInstaller("install", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
      CC_PLUGIN_CODEX_SKIP_LEGACY_CLEANUP: "1",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /skipping legacy cleanup/);
    assert.equal(fs.existsSync(path.join(legacyDir, "keep.txt")), true);
    assert.equal(fs.readFileSync(hooksFile, "utf8"), "{invalid\n");
  });

  it("preserves config.toml when its atomic replacement fails", () => {
    const homeDir = makeTempHome();
    const codexHome = path.join(homeDir, ".codex");
    const configFile = path.join(codexHome, "config.toml");
    const preload = makeTempHelper("fail-atomic-config-rename");
    const original = "[features]\nhooks = false\n\n[custom]\nkeep = true\n";
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(configFile, original, "utf8");
    fs.writeFileSync(
      preload,
      String.raw`import fs from "node:fs";

const target = process.env.CC_PLUGIN_ATOMIC_RENAME_FAIL_PATH;
const renameSync = fs.renameSync;
fs.renameSync = (source, destination) => {
  if (destination === target && String(source).startsWith(target + ".tmp.")) {
    throw new Error("simulated config.toml atomic replace failure");
  }
  return renameSync(source, destination);
};`,
      "utf8"
    );

    const result = spawnProjectInstaller("install", homeDir, {
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      CC_PLUGIN_ATOMIC_RENAME_FAIL_PATH: configFile,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /simulated config\.toml atomic replace failure/);
    assert.equal(fs.readFileSync(configFile, "utf8"), original);
    assert.deepEqual(
      fs.readdirSync(codexHome).filter((name) => name.startsWith("config.toml.tmp.")),
      []
    );
  });

  it("keeps install/update idempotent while refreshing the cached copy", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    const installEnv = {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    };

    runInstaller("install", homeDir, sourceRoot, installEnv);
    runInstaller("install", homeDir, sourceRoot, installEnv);

    const readmePath = path.join(marketplaceRoot, "plugins", "cc", "README.md");
    fs.appendFileSync(
      readmePath,
      "\n<!-- installer-cli update regression marker -->\n",
      "utf8"
    );

    runInstaller("update", homeDir, sourceRoot, installEnv);

    const cacheDir = path.join(homeDir, ".codex", "plugins", "cache", "sendbird", "cc", "local");
    const cachedReadme = fs.readFileSync(path.join(cacheDir, "README.md"), "utf8");
    const config = fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8");

    assert.match(cachedReadme, /installer-cli update regression marker/);
    assert.equal(
      countOccurrences(config, /\[plugins\."cc@sendbird"\]/g),
      1,
      "installer should keep exactly one Sendbird plugin enablement block"
    );
  });

  it("shell installer wrappers parse cleanly", () => {
    for (const scriptName of ["install.sh", "uninstall.sh"]) {
      const result = spawnSync("bash", ["-n", path.join(PROJECT_ROOT, "scripts", scriptName)], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
  });

  it("shell installer wrappers install and uninstall the plugin end to end", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    runShellWrapper("install.sh", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    const cacheDir = path.join(homeDir, ".codex", "plugins", "cache", "sendbird", "cc", "local");
    const configFile = path.join(homeDir, ".codex", "config.toml");
    assert.ok(fs.existsSync(path.join(cacheDir, "skills", "review", "SKILL.md")));
    assert.ok(fs.existsSync(configFile));

    runShellWrapper("uninstall.sh", homeDir, sourceRoot, fakeCodex.env);

    const config = fs.readFileSync(configFile, "utf8");
    assert.ok(!fs.existsSync(cacheDir), "shell uninstall should remove the cached plugin copy");
    assert.doesNotMatch(config, /\[plugins\."cc@sendbird"\]/);
  });
});
