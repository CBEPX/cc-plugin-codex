/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { isatty } from "node:tty";

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

export async function readStdinIfPiped() {
  if (isatty(0)) {
    return "";
  }
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}
