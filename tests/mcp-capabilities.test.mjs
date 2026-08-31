/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import * as mcp from "../scripts/lib/mcp-capabilities.mjs";

function withTempHome(run) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-mcp-capabilities-"));
  const cwd = path.join(homeDir, "workspace");
  fs.mkdirSync(cwd);
  return Promise.resolve(run({ homeDir, cwd })).finally(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
}

function writeStdioServer(root, handlers) {
  const serverPath = path.join(root, "stdio-server.mjs");
  fs.writeFileSync(
    serverPath,
    [
      'import fs from "node:fs";',
      'import readline from "node:readline";',
      `const handlers = ${JSON.stringify(handlers)};`,
      "const input = readline.createInterface({ input: process.stdin });",
      "input.on('line', (line) => {",
      "  const request = JSON.parse(line);",
      "  if (process.env.FAKE_MCP_REQUEST_LOG) fs.appendFileSync(process.env.FAKE_MCP_REQUEST_LOG, request.method + '\\n');",
      "  const result = handlers[request.method];",
      "  if (request.id != null && result !== undefined) {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');",
      "  }",
      "});",
      "",
    ].join("\n"),
    "utf8"
  );
  return serverPath;
}

describe("MCP configuration collection", () => {
  it("lets user config shadow a plugin without retaining plugin fingerprint metadata", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      const pluginId = "docs@example";
      const installPath = path.join(homeDir, ".claude", "plugins", "cache", "docs");
      fs.mkdirSync(installPath, { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".claude", "settings.json"),
        JSON.stringify({ enabledPlugins: { [pluginId]: true } }),
        "utf8"
      );
      fs.writeFileSync(
        path.join(homeDir, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: { [pluginId]: [{ installPath, version: "1.0.0" }] },
        }),
        "utf8"
      );
      fs.writeFileSync(
        path.join(installPath, ".mcp.json"),
        JSON.stringify({ docs: { command: "plugin-server" } }),
        "utf8"
      );
      fs.writeFileSync(
        path.join(homeDir, ".claude.json"),
        JSON.stringify({ mcpServers: { docs: { command: "user-server" } } }),
        "utf8"
      );

      const discovery = mcp.collectConfiguredMcpServers(cwd, { homeDir });

      assert.equal(discovery.available.docs.command, "user-server");
      assert.equal(discovery.sources.docs, "user");
      assert.equal(discovery.sourceDetails.docs, undefined);
    });
  });

  it("includes only the matching user-project MCP entries", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      fs.writeFileSync(
        path.join(homeDir, ".claude.json"),
        JSON.stringify({
          projects: {
            [cwd]: { mcpServers: { local: { command: "local-server" } } },
            [path.join(homeDir, "other")]: {
              mcpServers: { other: { command: "other-server" } },
            },
          },
        }),
        "utf8"
      );

      const discovery = mcp.collectConfiguredMcpServers(cwd, { homeDir });

      assert.deepEqual(Object.keys(discovery.available), ["local"]);
      assert.equal(discovery.sources.local, "user-project");
    });
  });

  it("expands the enabled plugin root in plugin MCP config", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      const pluginId = "local@example";
      const installPath = path.join(homeDir, ".claude", "plugins", "cache", "local");
      fs.mkdirSync(installPath, { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".claude", "settings.json"),
        JSON.stringify({ enabledPlugins: { [pluginId]: true } }),
        "utf8"
      );
      fs.writeFileSync(
        path.join(homeDir, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({ plugins: { [pluginId]: [{ installPath, version: "1" }] } }),
        "utf8"
      );
      fs.writeFileSync(
        path.join(installPath, ".mcp.json"),
        JSON.stringify({
          local: {
            command: process.execPath,
            args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"],
          },
        }),
        "utf8"
      );

      const discovery = mcp.collectConfiguredMcpServers(cwd, { homeDir });

      assert.deepEqual(discovery.available.local.args, [
        path.join(installPath, "server.mjs"),
      ]);
    });
  });
});

describe("MCP capability discovery", () => {
  it("probes a real stdio server and normalizes read-only tool metadata", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      const serverPath = writeStdioServer(homeDir, {
        initialize: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "docs", version: "1" },
        },
        "tools/list": {
          tools: [{
            name: "search",
            description: "Search product documentation",
            annotations: { readOnlyHint: true },
          }],
        },
      });
      fs.writeFileSync(
        path.join(homeDir, ".claude.json"),
        JSON.stringify({
          mcpServers: { docs: { command: process.execPath, args: [serverPath] } },
        }),
        "utf8"
      );

      assert.equal(typeof mcp.probeMcpCapabilities, "function");
      const discovery = mcp.collectConfiguredMcpServers(cwd, { homeDir });
      const result = await mcp.probeMcpCapabilities(discovery);

      assert.equal(result.discovered[0].transport, "stdio");
      assert.match(result.discovered[0].configFingerprint, /^[a-f0-9]{64}$/);
      assert.deepEqual(result.catalog, [{
        toolId: "mcp__docs__search",
        serverName: "docs",
        toolName: "search",
        description: "Search product documentation",
        capability: "Search product documentation",
        source: "user",
        transport: "stdio",
        configFingerprint: result.discovered[0].configFingerprint,
        safety: {
          eligible: true,
          decision: "eligible",
          reason: "read_only_annotation",
        },
      }]);
      assert.deepEqual(result.diagnostics, []);
    });
  });

  it("probes a real Streamable HTTP server", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      const server = http.createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        const message = JSON.parse(body);
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        const result = message.method === "initialize"
          ? {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "web", version: "1" },
            }
          : {
              tools: [{
                name: "lookup",
                description: "Look up release notes",
                annotations: { readOnlyHint: true },
              }],
            };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      try {
        const address = server.address();
        assert.ok(address && typeof address === "object");
        fs.writeFileSync(
          path.join(homeDir, ".claude.json"),
          JSON.stringify({
            mcpServers: {
              web: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` },
            },
          }),
          "utf8"
        );

        const discovery = mcp.collectConfiguredMcpServers(cwd, { homeDir });
        const result = await mcp.probeMcpCapabilities(discovery);

        assert.equal(result.discovered[0].transport, "streamable-http");
        assert.equal(result.catalog.length, 1);
        assert.equal(result.catalog[0].toolId, "mcp__web__lookup");
        assert.equal(result.catalog[0].safety.eligible, true);
        assert.deepEqual(result.diagnostics, []);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  it("parses an SSE-framed Streamable HTTP response", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      const server = http.createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        const message = JSON.parse(body);
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        const result = message.method === "initialize"
          ? {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "events", version: "1" },
            }
          : {
              tools: [{
                name: "search",
                description: "Search event data",
                annotations: { readOnlyHint: true },
              }],
            };
        const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
        response.setHeader("content-type", "text/event-stream");
        response.end(`event: message\ndata: ${payload}\n\n`);
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      try {
        const address = server.address();
        assert.ok(address && typeof address === "object");
        fs.writeFileSync(
          path.join(homeDir, ".claude.json"),
          JSON.stringify({
            mcpServers: {
              events: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` },
            },
          }),
          "utf8"
        );

        const result = await mcp.probeMcpCapabilities(
          mcp.collectConfiguredMcpServers(cwd, { homeDir })
        );

        assert.deepEqual(result.catalog.map((tool) => tool.toolId), [
          "mcp__events__search",
        ]);
        assert.deepEqual(result.diagnostics, []);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  it("does not list tools when initialize omits a usable tools capability", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      const requestLog = path.join(homeDir, "requests.log");
      const serverPath = writeStdioServer(homeDir, {
        initialize: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: null },
          serverInfo: { name: "no-tools", version: "1" },
        },
        "tools/list": {
          tools: [{ name: "must_not_be_listed", annotations: { readOnlyHint: true } }],
        },
      });
      fs.writeFileSync(
        path.join(homeDir, ".claude.json"),
        JSON.stringify({
          mcpServers: {
            noTools: {
              command: process.execPath,
              args: [serverPath],
              env: { FAKE_MCP_REQUEST_LOG: requestLog },
            },
          },
        }),
        "utf8"
      );

      const discovery = mcp.collectConfiguredMcpServers(cwd, { homeDir });
      const result = await mcp.probeMcpCapabilities(discovery);

      assert.deepEqual(result.catalog, []);
      assert.equal(result.diagnostics[0].code, "tools_capability_missing");
      assert.deepEqual(fs.readFileSync(requestLog, "utf8").trim().split("\n"), [
        "initialize",
      ]);
    });
  });

  it("allows an exact audited annotation-less read-only tool", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      const serverPath = writeStdioServer(homeDir, {
        initialize: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "context7", version: "1" },
        },
        "tools/list": {
          tools: [{
            name: "resolve-library-id",
            description: "Resolve a package name to its documentation ID",
          }],
        },
      });
      fs.writeFileSync(
        path.join(homeDir, ".claude.json"),
        JSON.stringify({
          mcpServers: { context7: { command: process.execPath, args: [serverPath] } },
        }),
        "utf8"
      );

      const result = await mcp.probeMcpCapabilities(
        mcp.collectConfiguredMcpServers(cwd, { homeDir })
      );

      assert.deepEqual(result.catalog[0].safety, {
        eligible: true,
        decision: "eligible",
        reason: "audited_read_only_registry",
      });
    });
  });

  it("reuses a capability probe for the same fingerprint within ten minutes", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      const requestLog = path.join(homeDir, "requests.log");
      const serverPath = writeStdioServer(homeDir, {
        initialize: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "cached", version: "1" },
        },
        "tools/list": { tools: [] },
      });
      fs.writeFileSync(
        path.join(homeDir, ".claude.json"),
        JSON.stringify({
          mcpServers: {
            cached: {
              command: process.execPath,
              args: [serverPath],
              env: { FAKE_MCP_REQUEST_LOG: requestLog },
            },
          },
        }),
        "utf8"
      );
      const discovery = mcp.collectConfiguredMcpServers(cwd, { homeDir });

      await mcp.probeMcpCapabilities(discovery, { now: 1000 });
      await mcp.probeMcpCapabilities(discovery, { now: 1000 + 9 * 60 * 1000 });

      assert.equal(
        fs.readFileSync(requestLog, "utf8").trim().split("\n")
          .filter((method) => method === "initialize").length,
        1
      );
      await mcp.probeMcpCapabilities(discovery, { now: 1000 + 11 * 60 * 1000 });
      assert.equal(
        fs.readFileSync(requestLog, "utf8").trim().split("\n")
          .filter((method) => method === "initialize").length,
        2
      );
    });
  });

  it("runs at most four server probes concurrently", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      let activeInitializes = 0;
      let maxActiveInitializes = 0;
      const server = http.createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        const message = JSON.parse(body);
        if (message.method === "initialize") {
          activeInitializes += 1;
          maxActiveInitializes = Math.max(maxActiveInitializes, activeInitializes);
          await new Promise((resolve) => setTimeout(resolve, 40));
          activeInitializes -= 1;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "limited", version: "1" },
            },
          }));
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [] },
        }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      try {
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const mcpServers = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
          `server${index}`,
          { type: "http", url: `http://127.0.0.1:${address.port}/mcp/${index}` },
        ]));
        fs.writeFileSync(
          path.join(homeDir, ".claude.json"),
          JSON.stringify({ mcpServers }),
          "utf8"
        );

        await mcp.probeMcpCapabilities(
          mcp.collectConfiguredMcpServers(cwd, { homeDir })
        );

        assert.equal(maxActiveInitializes, 4);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  it("reports SSE as unsupported without selecting tools", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      fs.writeFileSync(
        path.join(homeDir, ".claude.json"),
        JSON.stringify({
          mcpServers: { events: { type: "sse", url: "https://example.invalid/sse" } },
        }),
        "utf8"
      );

      const result = await mcp.probeMcpCapabilities(
        mcp.collectConfiguredMcpServers(cwd, { homeDir })
      );

      assert.deepEqual(result.catalog, []);
      assert.equal(result.diagnostics[0].code, "unsupported_sse");
      assert.equal(result.diagnostics[0].transport, "sse");
    });
  });

  it("keeps secret values out of the configuration fingerprint", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      const configPath = path.join(homeDir, ".claude.json");
      const writeConfig = (token) => fs.writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            events: {
              type: "sse",
              url: "https://example.invalid/sse?tenant=one&token=url-secret",
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        }),
        "utf8"
      );
      writeConfig("first-secret");
      const first = await mcp.probeMcpCapabilities(
        mcp.collectConfiguredMcpServers(cwd, { homeDir })
      );
      writeConfig("second-secret");
      const second = await mcp.probeMcpCapabilities(
        mcp.collectConfiguredMcpServers(cwd, { homeDir })
      );

      assert.equal(
        first.discovered[0].configFingerprint,
        second.discovered[0].configFingerprint
      );
    });
  });

  it("times out an unresponsive server without failing discovery", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      const serverPath = writeStdioServer(homeDir, {});
      fs.writeFileSync(
        path.join(homeDir, ".claude.json"),
        JSON.stringify({
          mcpServers: { stuck: { command: process.execPath, args: [serverPath] } },
        }),
        "utf8"
      );

      const result = await mcp.probeMcpCapabilities(
        mcp.collectConfiguredMcpServers(cwd, { homeDir }),
        { timeoutMs: 30 }
      );

      assert.deepEqual(result.catalog, []);
      assert.equal(result.diagnostics[0].code, "probe_timeout");
    });
  });

  it("reports configured OAuth as unsupported without contacting the server", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      fs.writeFileSync(
        path.join(homeDir, ".claude.json"),
        JSON.stringify({
          mcpServers: {
            oauth: {
              type: "http",
              url: "https://example.invalid/mcp",
              oauth: { clientId: "SECRET_CLIENT_ID" },
            },
          },
        }),
        "utf8"
      );

      const result = await mcp.probeMcpCapabilities(
        mcp.collectConfiguredMcpServers(cwd, { homeDir }),
        { timeoutMs: 30 }
      );

      assert.equal(result.diagnostics[0].code, "unsupported_oauth");
      assert.doesNotMatch(JSON.stringify(result), /SECRET_CLIENT_ID|clientId/);
    });
  });

  it("redacts a secret CLI argument echoed by a configured server", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      const serverPath = path.join(homeDir, "echo-argument-server.mjs");
      fs.writeFileSync(
        serverPath,
        [
          'import readline from "node:readline";',
          "const secret = process.argv.at(-1);",
          "const input = readline.createInterface({ input: process.stdin });",
          "input.on('line', (line) => {",
          "  const request = JSON.parse(line);",
          "  const result = request.method === 'initialize'",
          "    ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } }",
          "    : { tools: [{ name: 'search', description: 'Search with ' + secret, annotations: { readOnlyHint: true } }] };",
          "  if (request.id != null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');",
          "});",
          "",
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(homeDir, ".claude.json"),
        JSON.stringify({
          mcpServers: {
            echo: {
              command: process.execPath,
              args: [serverPath, "--api-key", "SECRET_ARGUMENT_VALUE"],
            },
          },
        }),
        "utf8"
      );

      const result = await mcp.probeMcpCapabilities(
        mcp.collectConfiguredMcpServers(cwd, { homeDir })
      );

      assert.doesNotMatch(JSON.stringify(result), /SECRET_ARGUMENT_VALUE/);
      assert.match(result.catalog[0].description, /\[redacted\]/);
    });
  });

  it("treats a destructive annotation as an unconditional veto", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      const serverPath = writeStdioServer(homeDir, {
        initialize: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "context7", version: "1" },
        },
        "tools/list": {
          tools: [{
            name: "query-docs",
            description: "Query documentation",
            annotations: { readOnlyHint: true, destructiveHint: true },
          }],
        },
      });
      fs.writeFileSync(
        path.join(homeDir, ".claude.json"),
        JSON.stringify({
          mcpServers: { context7: { command: process.execPath, args: [serverPath] } },
        }),
        "utf8"
      );

      const result = await mcp.probeMcpCapabilities(
        mcp.collectConfiguredMcpServers(cwd, { homeDir })
      );

      assert.deepEqual(result.catalog[0].safety, {
        eligible: false,
        decision: "blocked",
        reason: "destructive_annotation",
      });
      const selection = mcp.selectMcpCapabilities(result, {
        explicitTools: ["mcp__context7__query-docs"],
      });
      assert.deepEqual(selection.selected, []);
      assert.equal(selection.diagnostics[0].code, "explicit_tool_ineligible");
    });
  });
});

describe("MCP capability selection", () => {
  it("keeps an eligible explicit pin when automatic tools are disabled", () => {
    assert.equal(typeof mcp.selectMcpCapabilities, "function");
    const tool = {
      toolId: "mcp__docs__search",
      serverName: "docs",
      toolName: "search",
      description: "Search documentation",
      capability: "documentation search",
      source: "user",
      transport: "stdio",
      configFingerprint: "abc123",
      safety: { eligible: true, decision: "eligible", reason: "read_only_annotation" },
    };

    const selection = mcp.selectMcpCapabilities(
      { catalog: [tool], diagnostics: [] },
      {
        explicitTools: [tool.toolId],
        autoTools: ["mcp__other__lookup"],
        noAutoTools: true,
      }
    );

    assert.deepEqual(selection.selected, [{
      toolId: tool.toolId,
      source: "user",
      capability: "documentation search",
      reason: "explicit_pin",
      safetyDecision: tool.safety,
      transport: "stdio",
      configFingerprint: "abc123",
    }]);
    assert.deepEqual(selection.diagnostics, []);
  });

  it("keeps one provider per caller-supplied generic capability", () => {
    const makeTool = (toolId, capability) => ({
      toolId,
      serverName: toolId.split("__")[1],
      toolName: toolId.split("__")[2],
      description: capability,
      capability,
      source: "user",
      transport: "stdio",
      configFingerprint: toolId,
      safety: { eligible: true, decision: "eligible", reason: "read_only_annotation" },
    });
    const docsA = makeTool("mcp__docsA__search", "Search documentation");
    const docsB = makeTool("mcp__docsB__lookup", "Look up documentation");
    const metrics = makeTool("mcp__metrics__query", "Query metrics");

    const selection = mcp.selectMcpCapabilities(
      { catalog: [docsA, docsB, metrics], diagnostics: [] },
      {
        autoTools: [
          { toolId: docsA.toolId, capability: "docs_search", reason: "brief needs docs" },
          { toolId: docsB.toolId, capability: "docs_search", reason: "brief needs docs" },
          { toolId: metrics.toolId, capability: "metrics_query", reason: "brief needs metrics" },
        ],
      }
    );

    assert.deepEqual(
      selection.selected.map(({ toolId, capability, reason }) => ({ toolId, capability, reason })),
      [
        { toolId: docsA.toolId, capability: "docs_search", reason: "brief needs docs" },
        { toolId: metrics.toolId, capability: "metrics_query", reason: "brief needs metrics" },
      ]
    );
  });

  it("returns raw config only for selected servers while the manifest stays secret-free", () => {
    assert.equal(typeof mcp.buildSelectedMcpServers, "function");
    const discovery = {
      available: {
        docs: {
          command: "docs-server",
          env: { DOCS_TOKEN: "SECRET_DOCS_TOKEN" },
        },
        metrics: {
          url: "https://metrics.example/mcp",
          headers: { Authorization: "Bearer SECRET_METRICS_TOKEN" },
        },
      },
    };
    const selection = {
      selected: [{
        toolId: "mcp__docs__search",
        source: "user",
        capability: "docs_search",
        reason: "explicit_pin",
        safetyDecision: { eligible: true, decision: "eligible", reason: "read_only_annotation" },
        transport: "stdio",
        configFingerprint: "abc123",
      }],
    };

    const selectedServers = mcp.buildSelectedMcpServers(discovery, selection);

    assert.deepEqual(Object.keys(selectedServers), ["docs"]);
    assert.equal(selectedServers.docs.env.DOCS_TOKEN, "SECRET_DOCS_TOKEN");
    assert.doesNotMatch(
      JSON.stringify(selection),
      /SECRET_DOCS_TOKEN|SECRET_METRICS_TOKEN|Authorization|DOCS_TOKEN/
    );
  });
});
