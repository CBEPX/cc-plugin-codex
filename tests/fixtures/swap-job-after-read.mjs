import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const target = path.resolve(process.env.CC_TEST_SWAP_JOB_FILE ?? "");
const replacement = process.env.CC_TEST_SWAP_JOB_JSON ?? "";
const swapAfterRead = Number(process.env.CC_TEST_SWAP_JOB_AFTER_READ ?? "1");
const cancelPid = Number(process.env.CC_TEST_CANCEL_PID);
const cancelRecord = path.resolve(
  process.env.CC_TEST_CANCEL_RECORD_FILE ?? ""
);
const readFileSync = fs.readFileSync;
let swapped = false;
let targetReads = 0;

fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
  const result = readFileSync.call(this, filePath, ...args);
  if (path.resolve(String(filePath)) === target) {
    targetReads += 1;
    if (!swapped && targetReads === swapAfterRead) {
      swapped = true;
      fs.writeFileSync(target, replacement, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
  }
  return result;
};

if (Number.isInteger(cancelPid) && cancelPid > 0 && cancelRecord !== path.resolve("")) {
  if (process.platform === "win32") {
    const spawnSync = childProcess.spawnSync;
    childProcess.spawnSync = function patchedSpawnSync(command, args, options) {
      if (
        command === "powershell.exe" &&
        args?.join(" ").includes(`taskkill.exe /PID ${cancelPid}`)
      ) {
        fs.writeFileSync(cancelRecord, `${JSON.stringify({ pid: cancelPid })}\n`);
        return {
          status: 1,
          signal: null,
          stdout: "",
          stderr: "test cancellation failure",
          error: null,
        };
      }
      return spawnSync.call(this, command, args, options);
    };
    syncBuiltinESMExports();
  } else {
    const kill = process.kill.bind(process);
    process.kill = function patchedKill(pid, signal) {
      if (pid === -cancelPid) {
        fs.writeFileSync(cancelRecord, `${JSON.stringify({ pid: cancelPid })}\n`);
        throw Object.assign(new Error("test cancellation failure"), {
          code: "EPERM",
        });
      }
      return kill(pid, signal);
    };
  }
}
