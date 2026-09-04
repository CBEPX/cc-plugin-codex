/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";
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

export function readStdinIfPiped() {
  if (isatty(0)) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}
