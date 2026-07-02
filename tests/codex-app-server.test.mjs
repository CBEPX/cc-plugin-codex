/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { callCodexAppServer } from "../scripts/lib/codex-app-server.mjs";

const tempDirs = [];

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-server-test-"));
  tempDirs.push(dir);
  return dir;
}

function withEnv(values, callback) {
  const previous = new Map();
  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    if (values[key] == null) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [key, value] of previous) {
        if (value == null) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

function createFakeAppServer(dir, body) {
  const serverPath = path.join(dir, "fake-app-server.mjs");
  fs.writeFileSync(
    serverPath,
    `import readline from "node:readline";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    return;
  }
${body}
});
`,
    "utf8"
  );
  return serverPath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("callCodexAppServer", () => {
  it("lets CC_PLUGIN_CODEX_APP_SERVER_TIMEOUT_MS=0 disable per-call timeouts", async () => {
    const dir = createTempDir();
    const serverPath = createFakeAppServer(
      dir,
      `  await sleep(50);
  write({ jsonrpc: "2.0", id: message.id, result: { ok: true } });`
    );

    const result = await withEnv(
      {
        CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
        CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([serverPath]),
        CC_PLUGIN_CODEX_APP_SERVER_TIMEOUT_MS: "0",
      },
      () => callCodexAppServer({
        cwd: dir,
        method: "slow/method",
        params: {},
        timeoutMs: 1,
      })
    );

    assert.deepEqual(result, { ok: true });
  });

  it("does not treat an empty response as completion while waiting for a notification", async () => {
    const dir = createTempDir();
    const serverPath = createFakeAppServer(
      dir,
      `  write({ jsonrpc: "2.0", id: message.id, result: {} });`
    );

    await assert.rejects(
      withEnv(
        {
          CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
          CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([serverPath]),
          CC_PLUGIN_CODEX_APP_SERVER_TIMEOUT_MS: "50",
        },
        () => callCodexAppServer({
          cwd: dir,
          method: "externalAgentConfig/import",
          params: {},
          waitForNotificationMethod: "externalAgentConfig/import/completed",
          timeoutMs: 50,
        })
      ),
      /timed out waiting for externalAgentConfig\/import notification externalAgentConfig\/import\/completed/
    );
  });

  it("drains response and notification stdout before classifying child exit", async () => {
    const dir = createTempDir();
    const serverPath = createFakeAppServer(
      dir,
      `  write({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
  write({ jsonrpc: "2.0", method: "externalAgentConfig/import/completed", params: {} });
  process.exit(0);`
    );

    const result = await withEnv(
      {
        CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
        CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([serverPath]),
        CC_PLUGIN_CODEX_APP_SERVER_TIMEOUT_MS: "1000",
      },
      () => callCodexAppServer({
        cwd: dir,
        method: "externalAgentConfig/import",
        params: {},
        waitForNotificationMethod: "externalAgentConfig/import/completed",
        timeoutMs: 1000,
      })
    );

    assert.deepEqual(result, { ok: true });
  });

  it("captures notification params while waiting for completion", async () => {
    const dir = createTempDir();
    const serverPath = createFakeAppServer(
      dir,
      `  write({ jsonrpc: "2.0", id: message.id, result: {} });
  write({ jsonrpc: "2.0", method: "externalAgentConfig/import/completed", params: { threadId: "thread-from-notification" } });`
    );
    let notificationParams = null;

    const result = await withEnv(
      {
        CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
        CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([serverPath]),
        CC_PLUGIN_CODEX_APP_SERVER_TIMEOUT_MS: "1000",
      },
      () => callCodexAppServer({
        cwd: dir,
        method: "externalAgentConfig/import",
        params: {},
        waitForNotificationMethod: "externalAgentConfig/import/completed",
        timeoutMs: 1000,
        onNotification: (params) => {
          notificationParams = params;
        },
      })
    );

    assert.deepEqual(result, {});
    assert.deepEqual(notificationParams, { threadId: "thread-from-notification" });
  });

  it("rejects when the server exits after responding but before the required notification", async () => {
    const dir = createTempDir();
    const serverPath = createFakeAppServer(
      dir,
      `  write({ jsonrpc: "2.0", id: message.id, result: {} });
  process.exit(0);`
    );

    await assert.rejects(
      withEnv(
        {
          CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
          CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([serverPath]),
          CC_PLUGIN_CODEX_APP_SERVER_TIMEOUT_MS: "1000",
        },
        () => callCodexAppServer({
          cwd: dir,
          method: "externalAgentConfig/import",
          params: {},
          waitForNotificationMethod: "externalAgentConfig/import/completed",
          timeoutMs: 1000,
        })
      ),
      /exited before externalAgentConfig\/import emitted externalAgentConfig\/import\/completed/
    );
  });
});
