/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { terminateProcessTree } from "./process.mjs";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_PROBE_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_HTTP_RESPONSE_BYTES = 1024 * 1024;
const PROBE_TERMINATION_GRACE_MS = 100;
const SENSITIVE_NAME_PATTERN = /(?:token|secret|password|authorization|api.?key|cookie)/iu;
const probeCacheSalt = randomBytes(32);
const probeCache = new Map();
const braveWebEvidenceToolIds = new Set([
  "mcp__brave-search__brave_web_search",
  "mcp__brave-search__brave_llm_context",
]);
export const BRAVE_WEB_EVIDENCE_TOOLS = Object.freeze({
  /** @param {string} toolId */
  has(toolId) {
    return braveWebEvidenceToolIds.has(toolId);
  },
  [Symbol.iterator]() {
    return braveWebEvidenceToolIds.values();
  },
});
const auditedAnnotationlessReadOnlyToolIds = new Set([
  "mcp__context7__query-docs",
  "mcp__context7__resolve-library-id",
  "mcp__brave-search__brave_web_search",
  "mcp__brave-search__brave_llm_context",
]);
export const AUDITED_ANNOTATIONLESS_READ_ONLY_TOOLS = Object.freeze({
  /** @param {string} toolId */
  has(toolId) {
    return auditedAnnotationlessReadOnlyToolIds.has(toolId);
  },
  [Symbol.iterator]() {
    return auditedAnnotationlessReadOnlyToolIds.values();
  },
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sensitiveHeader(value) {
  const match = /^\s*([^:]+):\s*(.+)$/u.exec(value);
  if (!match || !SENSITIVE_NAME_PATTERN.test(match[1])) return null;
  return { name: match[1], value: match[2] };
}

function argumentSecretValues(args, index) {
  const argument = args[index];
  if (typeof argument !== "string") return [];
  const values = [];
  const previous = args[index - 1];
  if (typeof previous === "string" && SENSITIVE_NAME_PATTERN.test(previous)) {
    values.push(argument);
  }
  const header = sensitiveHeader(argument);
  if (header) values.push(header.value);
  if (SENSITIVE_NAME_PATTERN.test(argument.slice(0, argument.indexOf("=") + 1))) {
    values.push(argument.slice(argument.indexOf("=") + 1));
  }
  return values;
}

function secretFreeFingerprintValue(value, key = "", sensitive = false) {
  const nextSensitive = sensitive || /^(?:env|headers|oauth|auth)$/iu.test(key) ||
    SENSITIVE_NAME_PATTERN.test(key);
  if (typeof value === "string") {
    if (nextSensitive) return "[redacted]";
    if (key === "url") {
      try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        for (const name of url.searchParams.keys()) url.searchParams.set(name, "[redacted]");
        return url.toString();
      } catch {}
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (typeof item === "string" && key === "args" &&
          argumentSecretValues(value, index).length > 0) {
        const header = sensitiveHeader(item);
        if (header) return `${header.name}: [redacted]`;
        if (item.includes("=") && SENSITIVE_NAME_PATTERN.test(item.slice(0, item.indexOf("=")))) {
          return `${item.slice(0, item.indexOf("=") + 1)}[redacted]`;
        }
        return "[redacted]";
      }
      return secretFreeFingerprintValue(item, key, nextSensitive);
    });
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      secretFreeFingerprintValue(child, childKey, nextSensitive),
    ]));
  }
  return value;
}

function serverFingerprint(name, config, sourceDetail) {
  return createHash("sha256")
    .update(stableJson({
      name,
      config: secretFreeFingerprintValue(config),
      sourceDetail,
    }))
    .digest("hex");
}

function serverCacheKey(name, config, sourceDetail) {
  return createHmac("sha256", probeCacheSalt)
    .update(stableJson({ name, config, sourceDetail }))
    .digest("hex");
}

function serverTransport(config) {
  if (typeof config.command === "string" && config.command) return "stdio";
  if (typeof config.url === "string" && config.url) {
    return String(config.type ?? "").toLowerCase() === "sse"
      ? "sse"
      : "streamable-http";
  }
  return "unsupported";
}

function requiresOAuth(config) {
  return Boolean(config.oauth) ||
    String(config.auth?.type ?? config.type ?? "").toLowerCase() === "oauth";
}

function configSecretValues(config) {
  const secrets = new Set();
  const addSecret = (value) => {
    if (value.length < 3) return;
    secrets.add(value);
    const scheme = /^(?:Bearer|Basic)\s+(.+)$/iu.exec(value);
    if (scheme?.[1].length >= 3) secrets.add(scheme[1]);
  };
  const visit = (value, sensitive = false) => {
    if (typeof value === "string") {
      if (sensitive) addSecret(value);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      visit(child, sensitive || /^(?:env|headers|oauth|auth)$/iu.test(key) ||
        SENSITIVE_NAME_PATTERN.test(key));
    }
  };
  visit(config);
  if (Array.isArray(config.args)) {
    for (const index of config.args.keys()) {
      for (const secret of argumentSecretValues(config.args, index)) addSecret(secret);
    }
  }
  if (typeof config.url === "string") {
    try {
      const url = new URL(config.url);
      if (url.username) addSecret(url.username);
      if (url.password) addSecret(url.password);
      for (const value of url.searchParams.values()) {
        addSecret(value);
      }
    } catch {}
  }
  return [...secrets];
}

function redactSecrets(value, secrets) {
  let redacted = value;
  for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

function sanitizeProbeResult(result, secrets) {
  if (result.code) return { code: result.code };
  const tools = [];
  for (const tool of result.tools) {
    if (!tool || typeof tool.name !== "string" ||
        !/^[A-Za-z0-9_-]+$/u.test(tool.name) ||
        secrets.some((secret) => tool.name.includes(secret))) continue;
    tools.push({
      name: tool.name,
      description: typeof tool.description === "string"
        ? redactSecrets(tool.description, secrets)
        : "",
      annotations: tool.annotations && typeof tool.annotations === "object"
        ? {
            readOnlyHint: tool.annotations.readOnlyHint === true,
            destructiveHint: tool.annotations.destructiveHint === true,
          }
        : undefined,
    });
  }
  return { tools };
}

function hasToolsCapability(result) {
  return result?.capabilities?.tools != null &&
    typeof result.capabilities.tools === "object";
}

function stdioProbe(config, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(config.command, Array.isArray(config.args) ? config.args : [], {
      cwd: typeof config.cwd === "string" ? config.cwd : undefined,
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let settled = false;
    let finishing = false;
    let buffer = "";
    const finish = (value) => {
      if (settled || finishing) return;
      finishing = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.stdout.destroy();
      const signal = (name) => {
        if (!Number.isInteger(child.pid)) return false;
        try {
          if (process.platform === "win32") {
            return terminateProcessTree(child.pid).attempted;
          }
          process.kill(-child.pid, name);
        } catch (error) {
          if (error?.code !== "ESRCH") return false;
        }
        return true;
      };
      const finalize = () => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.once("close", finalize);
      if (!signal("SIGTERM")) {
        finalize();
        return;
      }
      setTimeout(() => {
        if (settled) return;
        signal("SIGKILL");
        setTimeout(finalize, PROBE_TERMINATION_GRACE_MS);
      }, PROBE_TERMINATION_GRACE_MS);
    };
    const send = (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const timer = setTimeout(() => finish({ code: "probe_timeout" }), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        if (response.id === 1) {
          if (!hasToolsCapability(response.result)) {
            finish({ code: "tools_capability_missing" });
            return;
          }
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (response.id === 2) {
          finish({ tools: Array.isArray(response.result?.tools) ? response.result.tools : [] });
        }
      }
    });
    child.on("error", () => finish({ code: "probe_failed" }));
    child.stdin.on("error", () => finish({ code: "probe_failed" }));
    child.on("close", () => finish({ code: "probe_failed" }));
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "cc-plugin-codex", version: "1.7.4" },
      },
    });
  });
}

function postJson(config, message, sessionId, deadline) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.url);
    const body = JSON.stringify(message);
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      ...(config.headers ?? {}),
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClockTimer);
      callback(value);
    };
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: "POST",
      headers,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_HTTP_RESPONSE_BYTES) {
          const error = Object.assign(new Error("response_too_large"), {
            code: "response_too_large",
          });
          response.destroy(error);
          request.destroy(error);
          finish(reject, error);
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", (error) => finish(reject, error));
      response.on("end", () => finish(resolve, {
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    const remainingMs = Math.max(1, deadline - Date.now());
    const timeoutError = () => Object.assign(new Error("timeout"), { code: "probe_timeout" });
    const wallClockTimer = setTimeout(() => {
      const error = timeoutError();
      request.destroy(error);
      finish(reject, error);
    }, remainingMs);
    request.setTimeout(remainingMs, () => {
      const error = timeoutError();
      request.destroy(error);
      finish(reject, error);
    });
    request.on("error", (error) => finish(reject, error));
    request.end(body);
  });
}

function parseRpcResponse(body) {
  try {
    return JSON.parse(body);
  } catch {
    for (const line of body.split(/\r?\n/u)) {
      if (!line.startsWith("data:")) continue;
      try { return JSON.parse(line.slice("data:".length).trim()); } catch {}
    }
    throw new Error("invalid_json_rpc_response");
  }
}

async function httpProbe(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  try {
    const initialized = await postJson(config, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
      clientInfo: { name: "cc-plugin-codex", version: "1.7.4" },
      },
    }, null, deadline);
    if (initialized.statusCode === 401 || initialized.statusCode === 403) {
      return { code: "unsupported_oauth" };
    }
    if (initialized.statusCode < 200 || initialized.statusCode >= 300) {
      return { code: "probe_failed" };
    }
    const initializeResponse = parseRpcResponse(initialized.body);
    if (!hasToolsCapability(initializeResponse.result)) {
      return { code: "tools_capability_missing" };
    }
    const sessionId = initialized.headers["mcp-session-id"];
    await postJson(config, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, sessionId, deadline);
    const listed = await postJson(config, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, sessionId, deadline);
    if (listed.statusCode < 200 || listed.statusCode >= 300) {
      return { code: "probe_failed" };
    }
    const listResponse = parseRpcResponse(listed.body);
    return { tools: Array.isArray(listResponse.result?.tools) ? listResponse.result.tools : [] };
  } catch (error) {
    if (error?.code === "response_too_large") return { code: "response_too_large" };
    return { code: Date.now() >= deadline || error?.code === "probe_timeout" || error?.message === "timeout"
      ? "probe_timeout"
      : "probe_failed" };
  }
}

function safetyFor(toolId, tool, auditedTools) {
  if (tool.annotations?.destructiveHint === true) {
    return { eligible: false, decision: "blocked", reason: "destructive_annotation" };
  }
  if (tool.annotations?.readOnlyHint === true) {
    return { eligible: true, decision: "eligible", reason: "read_only_annotation" };
  }
  if (auditedTools.has(toolId)) {
    return { eligible: true, decision: "eligible", reason: "audited_read_only_registry" };
  }
  return { eligible: false, decision: "blocked", reason: "read_only_unverified" };
}

async function forEachConcurrent(items, limit, visit) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await visit(item);
    }
  }));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function serverMap(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  return config.mcpServers && typeof config.mcpServers === "object"
    ? config.mcpServers
    : config;
}

function expandPluginRoot(value, pluginRoot) {
  if (typeof value === "string") {
    return value.split("${CLAUDE_PLUGIN_ROOT}").join(pluginRoot);
  }
  if (Array.isArray(value)) return value.map((item) => expandPluginRoot(item, pluginRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      expandPluginRoot(item, pluginRoot),
    ]));
  }
  return value;
}

function mergeServers(target, source, options = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  for (const [name, config] of Object.entries(source)) {
    if (!config || typeof config !== "object" || Array.isArray(config)) continue;
    if (!options.override && Object.prototype.hasOwnProperty.call(target, name)) continue;
    target[name] = config;
    options.sources[name] = options.source;
    if (options.sourceDetail) options.sourceDetails[name] = options.sourceDetail;
    else delete options.sourceDetails[name];
  }
}

function collectPluginServers(homeDir, available, sources, sourceDetails) {
  const claudeDir = path.join(homeDir, ".claude");
  const settings = readJson(path.join(claudeDir, "settings.json"));
  const installed = readJson(path.join(claudeDir, "plugins", "installed_plugins.json"));
  for (const [pluginId, enabled] of Object.entries(settings?.enabledPlugins ?? {})) {
    if (enabled !== true) continue;
    const installs = installed?.plugins?.[pluginId];
    if (!Array.isArray(installs)) continue;
    const install = [...installs].reverse().find((entry) =>
      entry && typeof entry.installPath === "string"
    );
    if (!install) continue;
    const configPath = path.join(install.installPath, ".mcp.json");
    mergeServers(available, expandPluginRoot(serverMap(readJson(configPath)), install.installPath), {
      sources,
      sourceDetails,
      source: `plugin:${pluginId}`,
      sourceDetail: {
        pluginId,
        pluginVersion: install.version ?? null,
        configPath,
      },
    });
  }
}

export function collectConfiguredMcpServers(cwd, options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const available = {};
  const sources = {};
  const sourceDetails = {};
  collectPluginServers(homeDir, available, sources, sourceDetails);

  const userConfigPath = path.join(homeDir, ".claude.json");
  const userConfig = readJson(userConfigPath);
  if (userConfig) {
    mergeServers(available, userConfig.mcpServers, {
      override: true,
      sources,
      sourceDetails,
      source: "user",
    });

    const resolvedCwd = path.resolve(cwd);
    const projects = userConfig.projects && typeof userConfig.projects === "object"
      ? userConfig.projects
      : {};
    for (const [projectKey, projectConfig] of Object.entries(projects)) {
      const projectMatches =
        path.resolve(projectKey) === resolvedCwd ||
        (typeof projectConfig?.cwd === "string" && path.resolve(projectConfig.cwd) === resolvedCwd) ||
        (typeof projectConfig?.path === "string" && path.resolve(projectConfig.path) === resolvedCwd);
      if (projectMatches) {
        mergeServers(available, projectConfig?.mcpServers, {
          override: true,
          sources,
          sourceDetails,
          source: "user-project",
        });
      }
    }
  }

  const candidateProjectConfigPath = path.join(cwd, ".mcp.json");
  const projectConfigPath = options.allowProjectMcpServers
    ? candidateProjectConfigPath
    : null;
  if (projectConfigPath) {
    mergeServers(available, serverMap(readJson(projectConfigPath)), {
      sources,
      sourceDetails,
      source: "project",
    });
  }
  const ignoredProjectConfigPath =
    !options.allowProjectMcpServers && fs.existsSync(candidateProjectConfigPath)
      ? candidateProjectConfigPath
      : null;

  return {
    available,
    sources,
    sourceDetails,
    userConfigPath,
    projectConfigPath,
    ignoredProjectConfigPath,
  };
}

export function parseMcpToolId(tool, availableServerNames = []) {
  const body = tool.slice("mcp__".length);
  const matchingServer = [...availableServerNames]
    .filter((serverName) => body.startsWith(`${serverName}__`))
    .sort((left, right) => right.length - left.length)[0];
  if (matchingServer) {
    return {
      serverName: matchingServer,
      toolName: body.slice(matchingServer.length + 2),
    };
  }
  const separator = body.indexOf("__");
  return {
    serverName: separator === -1 ? body : body.slice(0, separator),
    toolName: separator === -1 ? "" : body.slice(separator + 2),
  };
}

export async function probeMcpCapabilities(discovery, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const now = options.now ?? Date.now();
  const auditedTools = options.auditedTools ?? AUDITED_ANNOTATIONLESS_READ_ONLY_TOOLS;
  const discovered = Object.keys(discovery.available).sort().map((name) => {
    const config = discovery.available[name];
    return {
      name,
      source: discovery.sources[name] ?? null,
      transport: serverTransport(config),
      configFingerprint: serverFingerprint(
        name,
        config,
        discovery.sourceDetails[name] ?? null
      ),
    };
  });
  const catalog = [];
  const diagnostics = [];

  await forEachConcurrent(discovered, 4, async (server) => {
    if (requiresOAuth(discovery.available[server.name])) {
      diagnostics.push({
        code: "unsupported_oauth",
        serverName: server.name,
        source: server.source,
        transport: server.transport,
        configFingerprint: server.configFingerprint,
      });
      return;
    }
    if (server.transport !== "stdio" && server.transport !== "streamable-http") {
      diagnostics.push({
        code: server.transport === "sse" ? "unsupported_sse" : "unsupported_transport",
        serverName: server.name,
        source: server.source,
        transport: server.transport,
        configFingerprint: server.configFingerprint,
      });
      return;
    }
    const config = discovery.available[server.name];
    const sourceDetail = discovery.sourceDetails[server.name] ?? null;
    const cacheKey = serverCacheKey(server.name, config, sourceDetail);
    const cached = probeCache.get(cacheKey);
    let result = cached?.expiresAt > now ? cached.result : null;
    if (!result) {
      const probed = server.transport === "stdio"
        ? await stdioProbe(config, timeoutMs)
        : await httpProbe(config, timeoutMs);
      result = sanitizeProbeResult(probed, configSecretValues(config));
      probeCache.set(cacheKey, {
        expiresAt: now + MCP_PROBE_CACHE_TTL_MS,
        result,
      });
    }
    if (result.code) {
      diagnostics.push({
        code: result.code,
        serverName: server.name,
        source: server.source,
        transport: server.transport,
        configFingerprint: server.configFingerprint,
      });
      return;
    }
    for (const tool of result.tools) {
      const toolId = `mcp__${server.name}__${tool.name}`;
      catalog.push({
        toolId,
        serverName: server.name,
        toolName: tool.name,
        description: tool.description,
        capability: tool.description,
        source: server.source,
        transport: server.transport,
        configFingerprint: server.configFingerprint,
        safety: safetyFor(toolId, tool, auditedTools),
      });
    }
  });

  catalog.sort((left, right) => left.toolId.localeCompare(right.toolId));
  diagnostics.sort((left, right) => left.serverName.localeCompare(right.serverName));
  return { discovered, catalog, diagnostics };
}

function manifestRecord(tool, capability, reason) {
  return {
    toolId: tool.toolId,
    source: tool.source,
    capability: capability || tool.capability,
    reason,
    safetyDecision: tool.safety,
    transport: tool.transport,
    configFingerprint: tool.configFingerprint,
  };
}

export function selectMcpCapabilities(probeResult, options = {}) {
  const eligible = probeResult.catalog
    .filter((tool) => tool.safety.eligible)
    .map((tool) => manifestRecord(tool, tool.capability, tool.safety.reason));
  const byId = new Map(probeResult.catalog.map((tool) => [tool.toolId, tool]));
  const diagnostics = [...(probeResult.diagnostics ?? [])];
  const selected = [];

  for (const toolId of [...new Set(options.explicitTools ?? [])]) {
    const tool = byId.get(toolId);
    if (!tool || !tool.safety.eligible) {
      diagnostics.push({
        code: tool ? "explicit_tool_ineligible" : "explicit_tool_missing",
        toolId,
        safetyDecision: tool?.safety ?? null,
      });
      continue;
    }
    selected.push(manifestRecord(tool, tool.capability, "explicit_pin"));
  }

  if (!options.noAutoTools && selected.length === 0) {
    // Relevance is decided by the active Codex controller. Node only validates
    // its exact choices and removes duplicate provider capabilities.
    const usedCapabilities = new Set();
    for (const value of options.autoTools ?? []) {
      const choice = typeof value === "string" ? { toolId: value } : value;
      const tool = byId.get(choice?.toolId);
      if (!tool || !tool.safety.eligible) {
        diagnostics.push({
          code: tool ? "auto_tool_ineligible" : "auto_tool_missing",
          toolId: choice?.toolId ?? null,
          safetyDecision: tool?.safety ?? null,
        });
        continue;
      }
      const capability = choice.capability || tool.capability || tool.toolId;
      if (usedCapabilities.has(capability)) continue;
      usedCapabilities.add(capability);
      selected.push(manifestRecord(
        tool,
        capability,
        choice.reason || "controller_selected"
      ));
    }
  }

  return { eligible, selected, diagnostics };
}

export function buildSelectedMcpServers(discovery, selection) {
  const availableNames = Object.keys(discovery.available);
  const serverNames = new Set(selection.selected.map((tool) =>
    parseMcpToolId(tool.toolId, availableNames).serverName
  ));
  return Object.fromEntries([...serverNames]
    .filter((name) => discovery.available[name])
    .map((name) => [name, JSON.parse(JSON.stringify(discovery.available[name]))]));
}
