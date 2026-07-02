/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from "node:child_process";
import readline from "node:readline";
import process from "node:process";

const CLIENT_INFO = {
  name: "cc-plugin-codex-installer",
  version: "1.0.0",
};
const DEFAULT_TIMEOUT_MS = 15000;

function resolveAppServerCommand() {
  const executable = process.env.CC_PLUGIN_CODEX_EXECUTABLE || "codex";
  const rawArgs = process.env.CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON;

  if (!rawArgs) {
    return { executable, args: ["app-server"] };
  }

  let args;
  try {
    args = JSON.parse(rawArgs);
  } catch (error) {
    throw new Error(
      `Invalid CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new Error(
      "CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON must be a JSON array of strings."
    );
  }

  return { executable, args };
}

export async function callCodexAppServer({
  cwd,
  method,
  params,
  waitForNotificationMethod = null,
  timeoutMs: requestedTimeoutMs = null,
  responseCompletesWait = null,
  onNotification = null,
}) {
  const { executable, args } = resolveAppServerCommand();
  const hasConfiguredTimeout =
    process.env.CC_PLUGIN_CODEX_APP_SERVER_TIMEOUT_MS != null;
  const configuredTimeoutMs = Number.parseInt(
    process.env.CC_PLUGIN_CODEX_APP_SERVER_TIMEOUT_MS ?? `${DEFAULT_TIMEOUT_MS}`,
    10
  );
  const envTimeoutMs = Number.isFinite(configuredTimeoutMs)
    ? configuredTimeoutMs
    : DEFAULT_TIMEOUT_MS;
  const timeoutMs = requestedTimeoutMs == null || (hasConfiguredTimeout && envTimeoutMs <= 0)
    ? envTimeoutMs
    : Math.max(Number(requestedTimeoutMs) || 0, envTimeoutMs);

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    let settled = false;
    let stderr = "";
    let responseResult = null;
    let responseReceived = false;
    let notificationReceived = false;
    const timeoutHandle = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          const waitTarget = waitForNotificationMethod
            ? `${method} notification ${waitForNotificationMethod}`
            : method;
          finish(
            rejectPromise,
            new Error(
              `${executable} app-server timed out waiting for ${waitTarget} after ${timeoutMs}ms`
            )
          );
        }, timeoutMs)
      : null;

    function cleanup() {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      lines.close();
      child.stdin.end();
      if (!child.killed && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    }

    function finish(handler, value) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      handler(value);
    }

    function maybeFinishSuccess() {
      if (
        responseReceived &&
        (!waitForNotificationMethod || notificationReceived)
      ) {
        finish(resolvePromise, responseResult);
      }
    }

    function writeMessage(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    child.stdin.on("error", (error) => {
      finish(
        rejectPromise,
        new Error(`Failed to write to ${executable} app-server stdin: ${error.message}`)
      );
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      finish(
        rejectPromise,
        new Error(`Failed to start ${executable}: ${error.message}`)
      );
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      if (
        responseReceived &&
        (!waitForNotificationMethod || notificationReceived)
      ) {
        finish(resolvePromise, responseResult);
        return;
      }

      const suffix = stderr.trim() ? `\n${stderr.trim()}` : "";
      const message = responseReceived && waitForNotificationMethod && !notificationReceived
        ? `${executable} app-server exited before ${method} emitted ${waitForNotificationMethod} ` +
          `(code=${code}, signal=${signal})${suffix}`
        : `${executable} app-server exited before responding to ${method} ` +
          `(code=${code}, signal=${signal})${suffix}`;
      finish(
        rejectPromise,
        new Error(message)
      );
    });

    lines.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.id === 1) {
        writeMessage({
          jsonrpc: "2.0",
          id: 2,
          method,
          params,
        });
        return;
      }

      if (message.id !== 2) {
        if (message.method === waitForNotificationMethod) {
          notificationReceived = true;
          if (typeof onNotification === "function") {
            onNotification(message.params ?? null);
          }
          maybeFinishSuccess();
        }
        return;
      }

      if (message.error) {
        const suffix = stderr.trim() ? `\n${stderr.trim()}` : "";
        const error = Object.assign(
          new Error(
            `Codex app-server ${method} failed: ${JSON.stringify(message.error)}${suffix}`
          ),
          {
            rpcCode: message.error.code,
            rpcMessage: message.error.message,
          }
        );
        finish(
          rejectPromise,
          error
        );
        return;
      }

      responseResult = message.result;
      responseReceived = true;
      if (
        waitForNotificationMethod &&
        typeof responseCompletesWait === "function" &&
        responseCompletesWait(responseResult)
      ) {
        notificationReceived = true;
      }
      maybeFinishSuccess();
    });

    writeMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: CLIENT_INFO,
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [],
        },
      },
    });
  });
}
