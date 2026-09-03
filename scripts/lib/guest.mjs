/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_GUEST = "claude";
export const SUPPORTED_GUESTS = Object.freeze(["claude", "grok"]);

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) {
      continue;
    }
    const trimmed = String(value).trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

export function resolveGuest(value, env = process.env) {
  const raw = firstNonEmpty(value, env?.CC_GUEST) || DEFAULT_GUEST;
  const normalized = raw.toLowerCase();
  if (!SUPPORTED_GUESTS.includes(normalized)) {
    throw new Error(
      `Unsupported guest "${raw}". Use one of: ${SUPPORTED_GUESTS.join(", ")}.`
    );
  }
  return normalized;
}
