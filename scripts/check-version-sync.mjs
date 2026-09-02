#!/usr/bin/env node

import { assertVersionsMatch } from "./lib/version-sync.mjs";

try {
  const version = assertVersionsMatch();
  process.stdout.write(
    `Version sync OK: package.json, plugin.json, and both MCP clientInfo literals are ${version}.\n`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
