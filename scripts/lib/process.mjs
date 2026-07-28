/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    timeout: options.timeout,
    windowsHide: options.windowsHide ?? true,
    shell: false
  });

  return {
    command,
    args,
    status: result.status ?? null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (isCommandTimeout(result, options.timeout)) {
    const error = result.error ?? new Error(formatCommandFailure(result));
    if (!/** @type {NodeJS.ErrnoException} */ (error).code) {
      /** @type {NodeJS.ErrnoException} */ (error).code = "ETIMEDOUT";
    }
    throw error;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const error = /** @type {Error & { status?: number }} */ (
      new Error(formatCommandFailure(result))
    );
    error.status = result.status;
    throw error;
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

function isCommandTimeout(result, timeout) {
  return (
    result.error?.code === "ETIMEDOUT" ||
    (Number.isFinite(timeout) && timeout > 0 && result.signal === "SIGTERM")
  );
}

const WINDOWS_PROCESS_MISSING_EXIT = 241;
const WINDOWS_PROCESS_IDENTITY_MISMATCH_EXIT = 242;
const WINDOWS_PROCESS_TERMINATION_FAILED_EXIT = 243;
const WINDOWS_PROCESS_IDENTITY_UNAVAILABLE_EXIT = 244;
const WINDOWS_PROCESS_EXITED_DURING_TERMINATION_EXIT = 245;
const WINDOWS_PROCESS_COMMAND_TIMEOUT_MS = 10_000;
const WINDOWS_IDENTITY_CIRCUIT_RETRY_MS = 60_000;
const currentProcessIdentityCache = new Map();
const windowsIdentityUnavailableError = Object.assign(
  new Error("Windows process identity service is unavailable"),
  { code: "ETIMEDOUT" }
);
let windowsIdentityUnavailableAt = 0;

function isWindowsIdentityCircuitOpen() {
  return (
    windowsIdentityUnavailableAt > 0 &&
    Date.now() - windowsIdentityUnavailableAt <
      WINDOWS_IDENTITY_CIRCUIT_RETRY_MS
  );
}

function tripWindowsIdentityCircuit() {
  windowsIdentityUnavailableAt = Date.now();
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return {
            attempted: true,
            delivered: false,
            method: "process",
            reason: "process-missing",
          };
        }
        throw innerError;
      }
    }

    return {
      attempted: true,
      delivered: false,
      method: "process-group",
      reason: "process-missing",
    };
  }
}

/**
 * Terminate a stored process only while its stable identity still matches.
 * Windows performs the check and taskkill dispatch inside one PowerShell turn.
 */
export function terminateProcessTreeIfIdentityMatches(
  pid,
  expectedIdentity,
  options = {}
) {
  if (
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof expectedIdentity !== "string" ||
    expectedIdentity.length === 0
  ) {
    return {
      attempted: false,
      delivered: false,
      method: null,
      reason: "identity-unavailable",
    };
  }

  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    const getIdentity = options.getProcessIdentityImpl ?? getProcessIdentity;
    const isAlive = options.isProcessAliveImpl ?? isProcessAlive;
    let actualIdentity;
    try {
      actualIdentity = getIdentity(pid);
    } catch {
      return {
        attempted: false,
        delivered: false,
        method: null,
        reason: isAlive(pid) ? "identity-unavailable" : "process-missing",
      };
    }
    if (actualIdentity !== expectedIdentity) {
      return {
        attempted: false,
        delivered: false,
        method: null,
        reason: "identity-mismatch",
      };
    }
    const terminate = options.terminateProcessTreeImpl ?? terminateProcessTree;
    return terminate(pid, options);
  }

  if (!/^\d+$/u.test(expectedIdentity)) {
    return {
      attempted: false,
      delivered: false,
      method: null,
      reason: "identity-unavailable",
    };
  }

  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const usesDefaultCommand = options.runCommandImpl === undefined;
  const script = [
    `try { $target = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop } catch { exit ${WINDOWS_PROCESS_IDENTITY_UNAVAILABLE_EXIT} }`,
    `if ($null -eq $target) { exit ${WINDOWS_PROCESS_MISSING_EXIT} }`,
    `$creationTime = [DateTime]$target.CreationDate`,
    `if ($creationTime.ToFileTimeUtc().ToString() -ne '${expectedIdentity}') { exit ${WINDOWS_PROCESS_IDENTITY_MISMATCH_EXIT} }`,
    `& taskkill.exe /PID ${pid} /T /F | Out-Null`,
    `if ($LASTEXITCODE -ne 0) { try { $remaining = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop } catch { exit ${WINDOWS_PROCESS_IDENTITY_UNAVAILABLE_EXIT} }; if ($null -eq $remaining) { exit ${WINDOWS_PROCESS_EXITED_DURING_TERMINATION_EXIT} }; exit ${WINDOWS_PROCESS_TERMINATION_FAILED_EXIT} }`,
  ].join("; ");
  const timeout = options.timeout ?? WINDOWS_PROCESS_COMMAND_TIMEOUT_MS;
  const result = runCommandImpl(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      cwd: options.cwd,
      env: options.env,
      timeout,
      windowsHide: true,
    }
  );

  if (isCommandTimeout(result, timeout)) {
    if (usesDefaultCommand) {
      tripWindowsIdentityCircuit();
    }
    return {
      attempted: true,
      delivered: false,
      method: "identity-checked-taskkill",
      reason: "identity-unavailable",
      result,
    };
  }
  if (!result.error && result.status === 0) {
    if (usesDefaultCommand) {
      windowsIdentityUnavailableAt = 0;
    }
    return {
      attempted: true,
      delivered: true,
      method: "identity-checked-taskkill",
      result,
    };
  }
  if (!result.error && result.status === WINDOWS_PROCESS_MISSING_EXIT) {
    if (result.stderr.trim()) {
      if (usesDefaultCommand) {
        tripWindowsIdentityCircuit();
      }
      return {
        attempted: true,
        delivered: false,
        method: "identity-checked-taskkill",
        reason: "identity-unavailable",
        result,
      };
    }
    if (usesDefaultCommand) {
      windowsIdentityUnavailableAt = 0;
    }
    return {
      attempted: true,
      delivered: false,
      method: "identity-checked-taskkill",
      reason: "process-missing",
      result,
    };
  }
  if (!result.error && result.status === WINDOWS_PROCESS_IDENTITY_MISMATCH_EXIT) {
    if (usesDefaultCommand) {
      windowsIdentityUnavailableAt = 0;
    }
    return {
      attempted: true,
      delivered: false,
      method: "identity-checked-taskkill",
      reason: "identity-mismatch",
      result,
    };
  }
  if (
    !result.error &&
    result.status === WINDOWS_PROCESS_EXITED_DURING_TERMINATION_EXIT
  ) {
    if (usesDefaultCommand) {
      windowsIdentityUnavailableAt = 0;
    }
    return {
      attempted: true,
      delivered: false,
      method: "identity-checked-taskkill",
      reason: "process-missing",
      result,
    };
  }
  if (!result.error && result.status === WINDOWS_PROCESS_IDENTITY_UNAVAILABLE_EXIT) {
    if (usesDefaultCommand) {
      tripWindowsIdentityCircuit();
    }
    return {
      attempted: true,
      delivered: false,
      method: "identity-checked-taskkill",
      reason: "identity-unavailable",
      result,
    };
  }
  if (result.error) {
    if (usesDefaultCommand) {
      tripWindowsIdentityCircuit();
    }
    throw result.error;
  }
  if (
    usesDefaultCommand &&
    result.status === WINDOWS_PROCESS_TERMINATION_FAILED_EXIT
  ) {
    windowsIdentityUnavailableAt = 0;
  }
  if (
    usesDefaultCommand &&
    result.status !== WINDOWS_PROCESS_TERMINATION_FAILED_EXIT
  ) {
    tripWindowsIdentityCircuit();
  }
  throw new Error(formatCommandFailure(result));
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

/**
 * Get stable process identity for PID reuse detection.
 * Returns a string that is immutable for the process lifetime.
 */
export function getProcessIdentity(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError("PID must be a positive integer");
  }

  const platform = options.platform ?? process.platform;
  const runCommandCheckedImpl = options.runCommandCheckedImpl ?? runCommandChecked;
  const readFileSyncImpl = options.readFileSyncImpl ?? readFileSync;
  const usesDefaultSources =
    options.runCommandCheckedImpl === undefined &&
    options.readFileSyncImpl === undefined;
  const cacheKey =
    usesDefaultSources && pid === process.pid ? `${platform}:${pid}` : null;
  if (cacheKey && currentProcessIdentityCache.has(cacheKey)) {
    return currentProcessIdentityCache.get(cacheKey);
  }

  let identity;
  if (platform === "win32") {
    if (
      usesDefaultSources &&
      !options.bypassWindowsIdentityCircuit &&
      isWindowsIdentityCircuitOpen()
    ) {
      throw windowsIdentityUnavailableError;
    }
    let row;
    try {
      row = runCommandCheckedImpl(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `try { $process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop } catch { exit ${WINDOWS_PROCESS_IDENTITY_UNAVAILABLE_EXIT} }; if ($null -eq $process) { exit 3 }; $creationTime = [DateTime]$process.CreationDate; $creationTime.ToFileTimeUtc()`,
        ],
        {
          timeout: options.timeout ?? WINDOWS_PROCESS_COMMAND_TIMEOUT_MS,
          windowsHide: true,
        }
      );
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      const status = /** @type {Error & { status?: number }} */ (error).status;
      if (
        usesDefaultSources &&
        (status === WINDOWS_PROCESS_IDENTITY_UNAVAILABLE_EXIT ||
          ["ETIMEDOUT", "ENOENT", "EAGAIN", "ENOMEM"].includes(code ?? ""))
      ) {
        tripWindowsIdentityCircuit();
      }
      throw error;
    }
    if (usesDefaultSources) {
      windowsIdentityUnavailableAt = 0;
    }
    identity = row.stdout.trim();
    if (!/^\d+$/u.test(identity)) {
      throw new Error("Windows process creation time was unavailable");
    }
  } else if (platform === "darwin") {
    const row = runCommandCheckedImpl("ps", ["-o", "lstart=,comm=", "-p", String(pid)]);
    identity = row.stdout.trim();
  } else {
    const stat = readFileSyncImpl(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    const fields = stat.slice(closeParen + 2).split(" ");
    identity = fields[19]; // starttime field
  }

  if (cacheKey) {
    currentProcessIdentityCache.set(cacheKey, identity);
  }
  return identity;
}

export function getSpawnedProcessIdentity(pid, options = {}) {
  return getProcessIdentity(pid, {
    ...options,
    bypassWindowsIdentityCircuit: true,
  });
}

export function validateProcessIdentity(pid, expectedIdentity, options = {}) {
  try {
    return getProcessIdentity(pid, options) === expectedIdentity;
  } catch {
    return false;
  }
}

export function isProcessAlive(pid, options = {}) {
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

export function isProcessGroupAlive(pgid, options = {}) {
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(-pgid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}
