/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { callCodexAppServer } from "./codex-app-server.mjs";
import { resolveCodexHome } from "./codex-paths.mjs";

export const TRANSCRIPT_PATH_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;
const IMPORT_LEDGER_RETRY_ATTEMPTS = 20;
const IMPORT_LEDGER_RETRY_DELAY_MS = 50;

function ensureAbsolutePath(cwd, value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];
  if (!requestedPath) {
    throw new Error(
      "Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>."
    );
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  let projects;
  try {
    source = fs.realpathSync(sourcePath);
    projects = fs.realpathSync(CLAUDE_PROJECTS_DIR);
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }

  const relative = path.relative(projects, source);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Codex can import Claude sessions only from ${CLAUDE_PROJECTS_DIR}: ${source}`
    );
  }
  return source;
}

function importLedgerPath() {
  return path.join(resolveCodexHome(), "external_agent_session_imports.json");
}

function readImportLedgerRecords() {
  const ledgerPath = importLedgerPath();
  if (!fs.existsSync(ledgerPath)) {
    return [];
  }

  try {
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    return Array.isArray(ledger?.records) ? ledger.records : [];
  } catch {
    return [];
  }
}

function ledgerRecordKey(record) {
  return [
    record?.source_path ?? "",
    record?.imported_thread_id ?? "",
    record?.imported_at ?? "",
    record?.content_sha256 ?? "",
  ].join("\0");
}

function sourceContentSha256(sourcePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
}

function newestImportRecord(records) {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.record?.imported_at ?? "") || 0;
      const rightTime = Date.parse(right.record?.imported_at ?? "") || 0;
      return leftTime - rightTime || left.index - right.index;
    })
    .at(-1)?.record ?? null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function importedThreadIdFromResult(result) {
  const candidates = [
    result?.threadId,
    result?.thread_id,
    result?.importedThreadId,
    result?.imported_thread_id,
    result?.sessionId,
  ];
  return candidates.find((value) => typeof value === "string" && value.trim()) ?? null;
}

function importedThreadIdForSource(sourcePath, beforeRecords) {
  const canonicalSource = fs.realpathSync(sourcePath);
  const contentSha256 = sourceContentSha256(canonicalSource);
  const beforeKeys = new Set(beforeRecords.map(ledgerRecordKey));
  const matches = readImportLedgerRecords().filter(
    (record) =>
      record?.source_path === canonicalSource &&
      typeof record?.imported_thread_id === "string" &&
      record.imported_thread_id
  );
  const newMatch = newestImportRecord(
    matches.filter((record) => !beforeKeys.has(ledgerRecordKey(record)))
  );
  if (newMatch) {
    return newMatch.imported_thread_id;
  }
  return newestImportRecord(
    matches.filter((record) => record?.content_sha256 === contentSha256)
  )?.imported_thread_id ?? null;
}

async function waitForImportedThreadIdForSource(sourcePath, beforeRecords) {
  for (let attempt = 0; attempt < IMPORT_LEDGER_RETRY_ATTEMPTS; attempt += 1) {
    const threadId = importedThreadIdForSource(sourcePath, beforeRecords);
    if (threadId) {
      return threadId;
    }
    if (attempt < IMPORT_LEDGER_RETRY_ATTEMPTS - 1) {
      await sleep(IMPORT_LEDGER_RETRY_DELAY_MS);
    }
  }
  return null;
}

function externalAgentSessionMigration(sourcePath, cwd) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

export async function importExternalAgentSession(cwd, options = {}) {
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  try {
    const beforeRecords = readImportLedgerRecords();
    let completionParams = null;
    const response = await callCodexAppServer({
      cwd,
      method: "externalAgentConfig/import",
      params: externalAgentSessionMigration(options.sourcePath, cwd),
      waitForNotificationMethod: EXTERNAL_AGENT_IMPORT_COMPLETED,
      timeoutMs: EXTERNAL_AGENT_IMPORT_TIMEOUT_MS,
      responseCompletesWait: (result) => Boolean(importedThreadIdFromResult(result)),
      onNotification: (params) => {
        completionParams = params;
      },
    });

    const responseThreadId = importedThreadIdFromResult(response);
    if (responseThreadId) {
      return { threadId: responseThreadId };
    }

    const notificationThreadId = importedThreadIdFromResult(completionParams);
    if (notificationThreadId) {
      return { threadId: notificationThreadId };
    }

    const ledgerThreadId = await waitForImportedThreadIdForSource(
      options.sourcePath,
      beforeRecords
    );
    if (ledgerThreadId) {
      return { threadId: ledgerThreadId };
    }
  } catch (error) {
    if (error?.rpcCode === -32601) {
      throw new Error(
        "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
        { cause: error }
      );
    }
    throw error;
  }
  throw new Error(
    "Codex reported that the Claude import completed, but did not record an imported thread. Check the Codex app-server logs for the underlying import error."
  );
}
