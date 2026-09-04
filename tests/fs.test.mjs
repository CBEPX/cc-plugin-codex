/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

import {
  isProbablyText,
} from "../scripts/lib/fs.mjs";
import { samePath } from "../scripts/lib/codex-paths.mjs";

const readStdinProbe = `
  await new Promise((resolve) => setTimeout(resolve, Number(process.argv[1] || 0)));
  if (process.argv[2] === "nonblocking") void process.stdin.isTTY;
  const { readStdinIfPiped } = await import(${JSON.stringify(
    new URL("../scripts/lib/fs.mjs", import.meta.url).href
  )});
  if (typeof process.send === "function") {
    process.send("ready");
    await new Promise((resolve) => process.once("message", resolve));
    process.send("reading");
  }
  process.stdout.end(await readStdinIfPiped(), () => process.disconnect?.());
`;

// ---------------------------------------------------------------------------
// isProbablyText
// ---------------------------------------------------------------------------

describe("isProbablyText", () => {
  it("returns true for ASCII text", () => {
    const buf = Buffer.from("Hello, world!\nLine two.\n");
    assert.equal(isProbablyText(buf), true);
  });

  it("returns true for UTF-8 text", () => {
    const buf = Buffer.from("한글 텍스트 유니코드");
    assert.equal(isProbablyText(buf), true);
  });

  it("returns true for empty buffer", () => {
    assert.equal(isProbablyText(Buffer.alloc(0)), true);
  });

  it("returns false for buffer containing null bytes", () => {
    const buf = Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6c, 0x6f]);
    assert.equal(isProbablyText(buf), false);
  });

  it("returns false for binary data", () => {
    // PNG header
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    assert.equal(isProbablyText(buf), false);
  });

  it("only checks first 4096 bytes", () => {
    // Text buffer larger than 4096 with null byte after 4096
    const textPart = Buffer.alloc(4097, 0x41); // 'A' * 4097
    textPart[4097 - 1] = 0; // null at position 4096 (beyond sample)
    // The function samples subarray(0, min(len, 4096)) = first 4096 bytes, all 'A'
    assert.equal(isProbablyText(textPart), true);
  });
});

describe("readStdinIfPiped", () => {
  it("reads a delayed 24 KiB nonblocking pipe", async () => {
    const first = "a".repeat(8 * 1024);
    const second = "b".repeat(16 * 1024);
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", readStdinProbe, "150", "nonblocking"],
      { stdio: ["pipe", "pipe", "pipe", "ipc"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => {});

    const result = await new Promise((resolve) => {
      child.on("message", (message) => {
        if (message === "ready") {
          child.stdin.write(first, () => child.send("go"));
        } else if (message === "reading") {
          setTimeout(() => child.stdin.end(second), 100);
        }
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("close", (status, signal) => {
        clearTimeout(timer);
        resolve({ status, signal });
      });
    });

    assert.equal(result.status, 0, stderr || `terminated by ${result.signal}`);
    assert.equal(stdout, first + second);
  });

  it("returns promptly when stdin is ignored", () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", readStdinProbe],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 2_000 }
    );

    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.equal(result.stdout, "");
  });
});

describe("samePath", () => {
  it("matches identical resolved paths", () => {
    assert.equal(samePath("/tmp/example", "/tmp/example"), true);
  });

  it("normalizes dot segments before comparison", () => {
    assert.equal(samePath("/tmp/example/../example", "/tmp/example"), true);
  });

  it("treats Windows path casing as equivalent on win32", () => {
    assert.equal(samePath("C:\\Users\\Jin\\Repo", "c:\\users\\jin\\repo", "win32"), true);
  });
});
