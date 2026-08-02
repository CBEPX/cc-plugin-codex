/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

import {
  runCommand,
  runCommandChecked,
  binaryAvailable,
  terminateProcessTree,
  terminateProcessTreeIfIdentityMatches,
  formatCommandFailure,
  isProcessAlive,
  isProcessGroupAlive,
  validateProcessIdentity,
  getProcessIdentity,
  getSpawnedProcessIdentity,
} from "../scripts/lib/process.mjs";

// node may not be on PATH in this test environment; find it once
const NODE_BIN = process.execPath;

// ---------------------------------------------------------------------------
// runCommand
// ---------------------------------------------------------------------------

describe("runCommand", () => {
  it("runs a simple command and captures stdout", () => {
    const result = runCommand(NODE_BIN, [
      "-e",
      "process.stdout.write('hello\\n')",
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "hello");
    assert.equal(result.signal, null);
    assert.equal(result.error, null);
  });

  it("captures stderr", () => {
    const result = runCommand(NODE_BIN, ["-e", "process.stderr.write('oops')"]);
    assert.equal(result.stderr, "oops");
  });

  it("reports non-zero exit code", () => {
    const result = runCommand(NODE_BIN, ["-e", "process.exit(42)"]);
    assert.equal(result.status, 42);
  });

  it("reports ENOENT for missing command", () => {
    const result = runCommand("definitely-not-a-real-command-xyz");
    assert.ok(result.error);
    assert.equal(result.error.code, "ENOENT");
    assert.equal(result.status, null);
  });

  it("preserves command and args in result", () => {
    const args = ["-e", "process.stdout.write('ok')"];
    const result = runCommand(NODE_BIN, args);
    assert.equal(result.command, NODE_BIN);
    assert.deepEqual(result.args, args);
  });

  it("accepts input via options.input", () => {
    const result = runCommand(
      NODE_BIN,
      ["-e", "process.stdin.pipe(process.stdout)"],
      { input: "stdin data" }
    );
    assert.equal(result.stdout, "stdin data");
  });

  it("does not route commands through a shell", () => {
    /** @type {{ shell?: boolean, windowsHide?: boolean } | null} */
    let capturedOptions = null;
    const result = runCommand("echo", ["hello"], {
      spawnSyncImpl: (_command, _args, options) => {
        capturedOptions = options;
        return {
          status: 0,
          signal: null,
          stdout: "hello\n",
          stderr: "",
          error: null,
        };
      },
    });

    assert.equal(result.status, 0);
    assert.equal(capturedOptions?.shell, false);
    assert.equal(capturedOptions?.windowsHide, true);
  });

  it("passes resource limits through to spawnSync", () => {
    /** @type {{ maxBuffer?: number, timeout?: number } | null} */
    let capturedOptions = null;
    const result = runCommand("echo", ["hello"], {
      maxBuffer: 1234,
      timeout: 2500,
      spawnSyncImpl: (_command, _args, options) => {
        capturedOptions = options;
        return {
          status: 0,
          signal: null,
          stdout: "hello\n",
          stderr: "",
          error: null,
        };
      },
    });

    assert.equal(result.status, 0);
    assert.equal(capturedOptions?.maxBuffer, 1234);
    assert.equal(capturedOptions?.timeout, 2500);
  });
});

// ---------------------------------------------------------------------------
// runCommandChecked
// ---------------------------------------------------------------------------

describe("runCommandChecked", () => {
  it("returns result for successful command", () => {
    const result = runCommandChecked(NODE_BIN, [
      "-e",
      "process.stdout.write('ok\\n')",
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "ok");
  });

  it("throws on non-zero exit code", () => {
    assert.throws(
      () => runCommandChecked(NODE_BIN, ["-e", "process.exit(1)"]),
      (err) =>
        err instanceof Error &&
        err.message.includes("exit=1") &&
        /** @type {Error & { status?: number }} */ (err).status === 1
    );
  });

  it("throws the actual Error for ENOENT", () => {
    assert.throws(
      () => runCommandChecked("no-such-binary-xyz"),
      (err) =>
        err instanceof Error &&
        /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT"
    );
  });

  it("classifies a timeout signalled by spawnSync", () => {
    assert.throws(
      () =>
        runCommandChecked("powershell.exe", [], {
          timeout: 10,
          spawnSyncImpl: () => ({
            status: null,
            signal: "SIGTERM",
            stdout: "",
            stderr: "",
            error: null,
          }),
        }),
      (error) =>
        /** @type {NodeJS.ErrnoException} */ (error).code === "ETIMEDOUT"
    );
  });
});

// ---------------------------------------------------------------------------
// binaryAvailable
// ---------------------------------------------------------------------------

describe("binaryAvailable", () => {
  it("returns available:true for known binary (node)", () => {
    const result = binaryAvailable(NODE_BIN, ["--version"]);
    assert.equal(result.available, true);
    assert.ok(result.detail.startsWith("v"));
  });

  it("returns available:false for missing binary", () => {
    const result = binaryAvailable("not-real-binary-xyz");
    assert.equal(result.available, false);
    assert.equal(result.detail, "not found");
  });

  it("returns available:false when command exits non-zero", () => {
    const result = binaryAvailable(NODE_BIN, ["-e", "process.exit(1)"]);
    assert.equal(result.available, false);
  });
});

// ---------------------------------------------------------------------------
// formatCommandFailure
// ---------------------------------------------------------------------------

describe("formatCommandFailure", () => {
  it("formats command with exit code", () => {
    const msg = formatCommandFailure({
      command: "git",
      args: ["push"],
      status: 128,
      signal: null,
      stdout: "",
      stderr: "fatal: not a repo",
    });
    assert.ok(msg.includes("git push"));
    assert.ok(msg.includes("exit=128"));
    assert.ok(msg.includes("fatal: not a repo"));
  });

  it("formats command with signal", () => {
    const msg = formatCommandFailure({
      command: "sleep",
      args: ["100"],
      status: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
    });
    assert.ok(msg.includes("signal=SIGKILL"));
  });

  it("falls back to stdout when stderr is empty", () => {
    const msg = formatCommandFailure({
      command: "test",
      args: [],
      status: 1,
      signal: null,
      stdout: "some output",
      stderr: "",
    });
    assert.ok(msg.includes("some output"));
  });
});

// ---------------------------------------------------------------------------
// terminateProcessTree
// ---------------------------------------------------------------------------

describe("terminateProcessTree", () => {
  it("returns attempted:false for non-finite PID", () => {
    assert.deepEqual(terminateProcessTree(NaN), {
      attempted: false,
      delivered: false,
      method: null,
    });
    assert.deepEqual(terminateProcessTree(Infinity), {
      attempted: false,
      delivered: false,
      method: null,
    });
  });

  describe("unix path", () => {
    it("sends SIGTERM to process group on success", () => {
      let killedPid = null;
      let killedSignal = null;
      const result = terminateProcessTree(12345, {
        platform: "linux",
        killImpl: (pid, sig) => {
          killedPid = pid;
          killedSignal = sig;
        },
      });
      assert.equal(result.attempted, true);
      assert.equal(result.delivered, true);
      assert.equal(result.method, "process-group");
      assert.equal(killedPid, -12345); // negative = process group
      assert.equal(killedSignal, "SIGTERM");
    });

    it("falls back to direct kill on EPERM for group", () => {
      let directPid = null;
      const result = terminateProcessTree(12345, {
        platform: "linux",
        killImpl: (pid, sig) => {
          if (pid < 0) {
            const err = /** @type {NodeJS.ErrnoException} */ (new Error("EPERM"));
            err.code = "EPERM";
            throw err;
          }
          directPid = pid;
        },
      });
      assert.equal(result.delivered, true);
      assert.equal(result.method, "process");
      assert.equal(directPid, 12345);
    });

    it("returns delivered:false when process group ESRCH", () => {
      const result = terminateProcessTree(12345, {
        platform: "linux",
        killImpl: () => {
          const err = /** @type {NodeJS.ErrnoException} */ (new Error("ESRCH"));
          err.code = "ESRCH";
          throw err;
        },
      });
      assert.equal(result.attempted, true);
      assert.equal(result.delivered, false);
      assert.equal(result.reason, "process-missing");
    });

    it("reports a missing direct process after group fallback", () => {
      const result = terminateProcessTree(12345, {
        platform: "linux",
        killImpl: (pid) => {
          const code = pid < 0 ? "EPERM" : "ESRCH";
          throw Object.assign(new Error(code), { code });
        },
      });

      assert.equal(result.attempted, true);
      assert.equal(result.delivered, false);
      assert.equal(result.method, "process");
      assert.equal(result.reason, "process-missing");
    });
  });

  describe("win32 path", () => {
    it("uses taskkill on windows", () => {
      let capturedArgs = null;
      const result = terminateProcessTree(12345, {
        platform: "win32",
        runCommandImpl: (cmd, args) => {
          capturedArgs = args;
          return { error: null, status: 0, stdout: "", stderr: "" };
        },
      });
      assert.equal(result.delivered, true);
      assert.equal(result.method, "taskkill");
      assert.deepEqual(capturedArgs, ["/PID", "12345", "/T", "/F"]);
    });

    it("falls back to kill when taskkill ENOENT", () => {
      let killCalled = false;
      const result = terminateProcessTree(12345, {
        platform: "win32",
        runCommandImpl: () => ({
          error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
          status: null,
          stdout: "",
          stderr: "",
        }),
        killImpl: (pid) => {
          killCalled = true;
        },
      });
      assert.equal(killCalled, true);
      assert.equal(result.delivered, true);
      assert.equal(result.method, "kill");
    });

    it("detects 'not found' messages from taskkill stderr", () => {
      const result = terminateProcessTree(99999, {
        platform: "win32",
        runCommandImpl: () => ({
          error: null,
          status: 128,
          stdout: "",
          stderr: "ERROR: The process \"99999\" not found.",
        }),
      });
      assert.equal(result.attempted, true);
      assert.equal(result.delivered, false);
      assert.equal(result.method, "taskkill");
    });
  });
});

describe("terminateProcessTreeIfIdentityMatches", () => {
  it("checks Windows identity and dispatches taskkill in one PowerShell turn", () => {
    let capturedCommand = "";
    let capturedArgs = [];
    let capturedOptions = {};
    const result = terminateProcessTreeIfIdentityMatches(
      12345,
      "133987654321000000",
      {
        platform: "win32",
        runCommandImpl: (command, args, options) => {
          capturedCommand = command;
          capturedArgs = args;
          capturedOptions = options;
          return { error: null, status: 0, stdout: "", stderr: "" };
        },
      }
    );

    assert.equal(capturedCommand, "powershell.exe");
    assert.deepEqual(capturedArgs.slice(0, 4), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    assert.match(capturedArgs.at(-1), /ProcessId = 12345/u);
    assert.match(capturedArgs.at(-1), /133987654321000000/u);
    assert.match(capturedArgs.at(-1), /\$creationTime = \[DateTime\]\$target\.CreationDate/u);
    assert.match(capturedArgs.at(-1), /taskkill\.exe \/PID 12345 \/T \/F/u);
    assert.match(capturedArgs.at(-1), /\$remaining = Get-CimInstance/u);
    assert.match(capturedArgs.at(-1), /-ErrorAction Stop/u);
    assert.match(capturedArgs.at(-1), /exit 241/u);
    assert.match(capturedArgs.at(-1), /exit 244/u);
    assert.match(capturedArgs.at(-1), /exit 245/u);
    assert.match(capturedArgs.at(-1), /; /u);
    assert.equal(capturedOptions.windowsHide, true);
    assert.equal(capturedOptions.timeout, 10_000);
    assert.equal(result.attempted, true);
    assert.equal(result.delivered, true);
    assert.equal(result.method, "identity-checked-taskkill");
  });

  it("distinguishes missing, recycled, and unavailable Windows identities", () => {
    const missing = terminateProcessTreeIfIdentityMatches(
      12345,
      "133987654321000000",
      {
        platform: "win32",
        runCommandImpl: () => ({
          error: null,
          status: 241,
          stdout: "",
          stderr: "",
        }),
      }
    );
    const recycled = terminateProcessTreeIfIdentityMatches(
      12345,
      "133987654321000000",
      {
        platform: "win32",
        runCommandImpl: () => ({
          error: null,
          status: 242,
          stdout: "",
          stderr: "",
        }),
      }
    );
    const unavailable = terminateProcessTreeIfIdentityMatches(
      12345,
      "133987654321000000",
      {
        platform: "win32",
        runCommandImpl: () => ({
          error: null,
          status: 244,
          stdout: "",
          stderr: "",
        }),
      }
    );
    const noisyMissing = terminateProcessTreeIfIdentityMatches(
      12345,
      "133987654321000000",
      {
        platform: "win32",
        runCommandImpl: () => ({
          error: null,
          status: 241,
          stdout: "",
          stderr: "RPC server is unavailable",
        }),
      }
    );
    const whitespaceMissing = terminateProcessTreeIfIdentityMatches(
      12345,
      "133987654321000000",
      {
        platform: "win32",
        runCommandImpl: () => ({
          error: null,
          status: 241,
          stdout: "",
          stderr: "   ",
        }),
      }
    );
    const exitedDuringTermination = terminateProcessTreeIfIdentityMatches(
      12345,
      "133987654321000000",
      {
        platform: "win32",
        runCommandImpl: () => ({
          error: null,
          status: 245,
          stdout: "",
          stderr: "ERROR: The process was not found.",
        }),
      }
    );

    assert.equal(missing.reason, "process-missing");
    assert.equal(recycled.reason, "identity-mismatch");
    assert.equal(unavailable.reason, "identity-unavailable");
    assert.equal(noisyMissing.reason, "identity-unavailable");
    assert.equal(whitespaceMissing.reason, "process-missing");
    assert.equal(exitedDuringTermination.reason, "process-missing");
    assert.equal(exitedDuringTermination.attempted, true);
    assert.equal(exitedDuringTermination.delivered, false);
    assert.equal(exitedDuringTermination.method, "identity-checked-taskkill");
    assert.equal(missing.attempted, true);
    assert.equal(recycled.attempted, true);
    assert.equal(missing.method, "identity-checked-taskkill");
    assert.equal(recycled.method, "identity-checked-taskkill");
    assert.equal(missing.delivered, false);
    assert.equal(recycled.delivered, false);
  });

  it("fails closed for invalid identities, timeouts, and PowerShell errors", () => {
    assert.deepEqual(terminateProcessTreeIfIdentityMatches(12345, null), {
      attempted: false,
      delivered: false,
      method: null,
      reason: "identity-unavailable",
    });
    assert.deepEqual(
      terminateProcessTreeIfIdentityMatches(12345, "not-digits", {
        platform: "win32",
      }),
      {
        attempted: false,
        delivered: false,
        method: null,
        reason: "identity-unavailable",
      }
    );
    const timeout = terminateProcessTreeIfIdentityMatches(
      12345,
      "133987654321000000",
      {
        platform: "win32",
        runCommandImpl: () => ({
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
          status: 0,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
        }),
      }
    );
    assert.equal(timeout.attempted, true);
    assert.equal(timeout.delivered, false);
    assert.equal(timeout.method, "identity-checked-taskkill");
    assert.equal(timeout.reason, "identity-unavailable");
    const commandError = Object.assign(new Error("PowerShell failed"), {
      code: "EIO",
    });
    assert.throws(
      () =>
        terminateProcessTreeIfIdentityMatches(
          12345,
          "133987654321000000",
          {
            platform: "win32",
            runCommandImpl: () => ({
              error: commandError,
              status: 0,
              signal: null,
              stdout: "",
              stderr: "",
            }),
          }
        ),
      (error) => error === commandError
    );
    assert.throws(
      () =>
        terminateProcessTreeIfIdentityMatches(
          12345,
          "133987654321000000",
          {
            platform: "win32",
            runCommandImpl: () => ({
              error: null,
              status: 243,
              stdout: "",
              stderr: "taskkill failed",
              command: "powershell.exe",
              args: [],
              signal: null,
            }),
          }
        ),
      /taskkill failed/u
    );
  });

  it("distinguishes POSIX identity mismatch, lookup failure, and exit", () => {
    let terminated = false;
    let capturedIdentityOptions = null;
    const mismatched = terminateProcessTreeIfIdentityMatches(
      12345,
      "identity",
      {
        platform: "linux",
        getProcessIdentityImpl: () => "different-identity",
        terminateProcessTreeImpl: () => {
          terminated = true;
        },
      }
    );
    const matched = terminateProcessTreeIfIdentityMatches(
      12345,
      "identity",
      {
        platform: "linux",
        timeout: 321,
        getProcessIdentityImpl: (_pid, options) => {
          capturedIdentityOptions = options;
          return "identity";
        },
        terminateProcessTreeImpl: () => ({
          attempted: true,
          delivered: true,
          method: "process-group",
        }),
      }
    );
    const unavailable = terminateProcessTreeIfIdentityMatches(
      12345,
      "identity",
      {
        platform: "linux",
        getProcessIdentityImpl: () => {
          throw Object.assign(new Error("lookup failed"), { code: "EAGAIN" });
        },
        isProcessAliveImpl: () => true,
      }
    );
    const missing = terminateProcessTreeIfIdentityMatches(
      12345,
      "identity",
      {
        platform: "linux",
        getProcessIdentityImpl: () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        isProcessAliveImpl: () => false,
      }
    );

    assert.equal(terminated, false);
    assert.equal(mismatched.reason, "identity-mismatch");
    assert.equal(matched.delivered, true);
    assert.deepEqual(capturedIdentityOptions, { timeout: 321 });
    assert.equal(unavailable.reason, "identity-unavailable");
    assert.equal(unavailable.delivered, false);
    assert.equal(missing.reason, "process-missing");
    assert.equal(missing.delivered, false);
  });

  it("retries the Windows identity circuit after cooldown without latching EIO", async () => {
    const originalSpawnSync = childProcess.spawnSync;
    const originalDateNow = Date.now;
    const importKey = originalDateNow();
    let powershellSpawns = 0;
    let now = 10_000;
    let mode = "unavailable";
    Reflect.set(Date, "now", () => now);
    Reflect.set(childProcess, "spawnSync", (command, _args, _options) => {
      if (command === "powershell.exe") {
        powershellSpawns += 1;
        if (mode === "success") {
          return {
            error: null,
            status: 0,
            signal: null,
            stdout: "133987654321000000\r\n",
            stderr: "",
          };
        }
        if (mode === "eio") {
          return {
            error: Object.assign(new Error("temporary PowerShell failure"), {
              code: "EIO",
            }),
            status: null,
            signal: null,
            stdout: "",
            stderr: "",
          };
        }
        if (mode === "unavailable") {
          return {
            error: null,
            status: 244,
            signal: null,
            stdout: "",
            stderr: "",
          };
        }
        return {
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
          status: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
        };
      }
      return originalSpawnSync(command, _args, _options);
    });
    syncBuiltinESMExports();

    try {
      const isolated = await import(
        `../scripts/lib/process.mjs?identity-circuit=${importKey}`
      );
      mode = "success";
      assert.equal(
        isolated.getProcessIdentity(12344, { platform: "win32" }),
        "133987654321000000"
      );
      assert.equal(powershellSpawns, 1);

      mode = "unavailable";
      const first = isolated.terminateProcessTreeIfIdentityMatches(
        12345,
        "133987654321000000",
        { platform: "win32" }
      );
      const second = isolated.terminateProcessTreeIfIdentityMatches(
        12346,
        "133987654321000001",
        { platform: "win32" }
      );
      const third = isolated.terminateProcessTreeIfIdentityMatches(
        12347,
        "133987654321000002",
        { platform: "win32" }
      );

      assert.equal(first.attempted, true);
      assert.equal(first.reason, "identity-unavailable");
      assert.equal(second.attempted, true);
      assert.equal(second.reason, "identity-unavailable");
      assert.equal(third.attempted, true);
      assert.equal(third.reason, "identity-unavailable");
      assert.throws(
        () => isolated.getProcessIdentity(process.pid, { platform: "win32" }),
        (error) =>
          /** @type {NodeJS.ErrnoException} */ (error).code === "ETIMEDOUT"
      );
      assert.equal(powershellSpawns, 4);

      mode = "success";
      assert.equal(
        isolated.getSpawnedProcessIdentity(12348, { platform: "win32" }),
        "133987654321000000"
      );
      assert.equal(powershellSpawns, 5);

      mode = "unavailable";
      const retripped = isolated.terminateProcessTreeIfIdentityMatches(
        12348,
        "133987654321000003",
        { platform: "win32" }
      );
      assert.equal(retripped.attempted, true);
      assert.equal(retripped.reason, "identity-unavailable");
      assert.equal(powershellSpawns, 6);

      now += 59_999;
      assert.throws(
        () => isolated.getProcessIdentity(12349, { platform: "win32" }),
        (error) =>
          /** @type {NodeJS.ErrnoException} */ (error).code === "ETIMEDOUT"
      );
      assert.equal(powershellSpawns, 6);

      now += 1;
      mode = "timeout";
      assert.throws(
        () => isolated.getProcessIdentity(12349, { platform: "win32" }),
        (error) =>
          /** @type {NodeJS.ErrnoException} */ (error).code === "ETIMEDOUT"
      );
      assert.equal(powershellSpawns, 7);

      mode = "success";
      const recovered = isolated.terminateProcessTreeIfIdentityMatches(
        12350,
        "133987654321000005",
        { platform: "win32" }
      );
      assert.equal(recovered.delivered, true);
      assert.equal(powershellSpawns, 8);

      mode = "eio";
      assert.throws(
        () => isolated.getProcessIdentity(process.pid, { platform: "win32" }),
        (error) =>
          /** @type {NodeJS.ErrnoException} */ (error).code === "EIO"
      );
      mode = "success";
      assert.equal(
        isolated.getProcessIdentity(process.pid, { platform: "win32" }),
        "133987654321000000"
      );
      assert.equal(powershellSpawns, 10);
    } finally {
      Reflect.set(Date, "now", originalDateNow);
      Reflect.set(childProcess, "spawnSync", originalSpawnSync);
      syncBuiltinESMExports();
    }
  });
});

// ---------------------------------------------------------------------------
// isProcessAlive
// ---------------------------------------------------------------------------

describe("isProcessAlive", () => {
  it("returns true for current process", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it("returns false for non-existent PID", () => {
    // PID 99999999 is extremely unlikely to exist
    assert.equal(isProcessAlive(99999999), false);
  });

  it("treats EPERM as alive and ESRCH as missing", () => {
    const error = (code) => () => {
      throw Object.assign(new Error(code), { code });
    };

    assert.equal(isProcessAlive(12345, { killImpl: error("EPERM") }), true);
    assert.equal(isProcessAlive(12345, { killImpl: error("ESRCH") }), false);
  });
});

describe("isProcessGroupAlive", () => {
  it("treats EPERM as alive and ESRCH as missing", () => {
    let probe = null;
    const error = (code) => () => {
      throw Object.assign(new Error(code), { code });
    };

    assert.equal(
      isProcessGroupAlive(12345, {
        killImpl: (pid, signal) => {
          probe = [pid, signal];
        },
      }),
      true
    );
    assert.deepEqual(probe, [-12345, 0]);
    assert.equal(
      isProcessGroupAlive(12345, { killImpl: error("EPERM") }),
      true
    );
    assert.equal(
      isProcessGroupAlive(12345, { killImpl: error("ESRCH") }),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// getProcessIdentity / validateProcessIdentity
// ---------------------------------------------------------------------------

describe("getProcessIdentity", () => {
  it("returns a non-empty string for the current process", () => {
    const identity = getProcessIdentity(process.pid);
    assert.ok(typeof identity === "string");
    assert.ok(identity.length > 0);
  });

  it("returns same identity on repeated calls", () => {
    const id1 = getProcessIdentity(process.pid);
    const id2 = getProcessIdentity(process.pid);
    assert.equal(id1, id2);
  });

  it("uses a stable CIM creation time on Windows", () => {
    let capturedCommand = "";
    let capturedArgs = [];
    let capturedOptions = {};
    const identity = getProcessIdentity(12345, {
      platform: "win32",
      runCommandCheckedImpl: (command, args, options) => {
        capturedCommand = command;
        capturedArgs = args;
        capturedOptions = options;
        return { stdout: "133987654321000000\r\n" };
      },
    });

    assert.equal(identity, "133987654321000000");
    assert.equal(capturedCommand, "powershell.exe");
    assert.deepEqual(capturedArgs.slice(0, 3), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
    ]);
    assert.equal(capturedArgs[3], "-Command");
    assert.match(capturedArgs.at(-1), /ProcessId = 12345/u);
    assert.match(capturedArgs.at(-1), /-ErrorAction Stop/u);
    assert.match(capturedArgs.at(-1), /exit 244/u);
    assert.match(capturedArgs.at(-1), /\[DateTime\]\$process\.CreationDate/u);
    assert.match(capturedArgs.at(-1), /\$creationTime\.ToFileTimeUtc/u);
    assert.equal(capturedOptions.timeout, 10_000);
    assert.equal(capturedOptions.windowsHide, true);
  });

  it("rejects invalid PIDs and malformed Windows creation times", () => {
    assert.throws(() => getProcessIdentity(0), /positive integer/u);
    for (const stdout of ["not-a-timestamp\n", "x133987654321000000\n", "133987654321000000x\n"]) {
      assert.throws(
        () =>
          getProcessIdentity(12345, {
            platform: "win32",
            runCommandCheckedImpl: () => ({ stdout }),
          }),
        /creation time was unavailable/u
      );
    }
  });

  it("extracts Linux start time from proc stat after names containing spaces", () => {
    const fields = Array.from({ length: 20 }, (_, index) => String(index));
    fields[19] = "stable-start-time";
    let requestedPath = null;

    const identity = getProcessIdentity(12345, {
      platform: "linux",
      readFileSyncImpl: (filePath, encoding) => {
        requestedPath = filePath;
        assert.equal(encoding, "utf8");
        return `12345 (node worker process) ${fields.join(" ")}`;
      },
    });

    assert.equal(requestedPath, "/proc/12345/stat");
    assert.equal(identity, "stable-start-time");
  });

  it("trims Darwin ps identity output", () => {
    let capturedOptions = null;
    const identity = getProcessIdentity(12345, {
      platform: "darwin",
      timeout: 321,
      runCommandCheckedImpl: (_command, _args, options) => {
        capturedOptions = options;
        return { stdout: "  stable-darwin-identity  \n" };
      },
    });

    assert.equal(identity, "stable-darwin-identity");
    assert.deepEqual(capturedOptions, { timeout: 321 });
  });

  it("executes CIM identity and identity-checked tree termination on Windows", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const isolated = await import(
      `../scripts/lib/process.mjs?real-cim=${Date.now()}-${Math.random()}`
    );
    const firstIdentity = isolated.getProcessIdentity(process.pid);
    const secondIdentity = isolated.getProcessIdentity(process.pid);
    assert.match(firstIdentity, /^\d+$/u);
    assert.equal(secondIdentity, firstIdentity);
    assert.throws(() => isolated.getProcessIdentity(99_999_999));

    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }
    );
    try {
      let childIdentity = null;
      for (let attempt = 0; attempt < 30 && !childIdentity; attempt++) {
        try {
          childIdentity = isolated.getProcessIdentity(child.pid);
        } catch {
          await delay(100);
        }
      }
      assert.match(childIdentity, /^\d+$/u);

      const result = isolated.terminateProcessTreeIfIdentityMatches(
        child.pid,
        childIdentity
      );
      assert.equal(result.delivered, true);
      for (
        let attempt = 0;
        attempt < 30 && isolated.isProcessAlive(child.pid);
        attempt++
      ) {
        await delay(100);
      }
      assert.equal(isolated.isProcessAlive(child.pid), false);
    } finally {
      if (isolated.isProcessAlive(child.pid)) {
        isolated.terminateProcessTree(child.pid);
      }
    }
  });
});

describe("validateProcessIdentity", () => {
  it("returns true when identity matches", () => {
    const identity = getProcessIdentity(process.pid);
    assert.equal(validateProcessIdentity(process.pid, identity), true);
  });

  it("returns false for mismatched identity", () => {
    assert.equal(validateProcessIdentity(process.pid, "bogus-identity"), false);
  });

  it("returns false for non-existent PID", () => {
    assert.equal(validateProcessIdentity(99999999, "any"), false);
  });
});
