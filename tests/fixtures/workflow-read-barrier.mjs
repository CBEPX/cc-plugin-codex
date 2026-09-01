import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const target = path.resolve(process.env.CC_TEST_WORKFLOW_FILE ?? "");
const barrierDir = path.resolve(process.env.CC_TEST_WORKFLOW_BARRIER_DIR ?? "");
const expected = Number(process.env.CC_TEST_WORKFLOW_BARRIER_COUNT ?? "2");
const readFileSync = fs.readFileSync;
let waited = false;

fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
  const result = readFileSync.call(this, filePath, ...args);
  if (!waited && path.resolve(String(filePath)) === target) {
    waited = true;
    fs.writeFileSync(path.join(barrierDir, String(process.pid)), "ready\n", "utf8");
    const deadline = Date.now() + 5_000;
    while (fs.readdirSync(barrierDir).length < expected && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return result;
};
