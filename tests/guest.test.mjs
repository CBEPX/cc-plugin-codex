/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GUEST,
  SUPPORTED_GUESTS,
  resolveGuest,
} from "../scripts/lib/guest.mjs";

describe("resolveGuest", () => {
  it("defaults to claude when flag and env are unset", () => {
    assert.equal(DEFAULT_GUEST, "claude");
    assert.deepEqual([...SUPPORTED_GUESTS], ["claude", "grok"]);
    assert.equal(resolveGuest(undefined, {}), "claude");
    assert.equal(resolveGuest(null, {}), "claude");
    assert.equal(resolveGuest("", {}), "claude");
  });

  it("reads CC_GUEST when the CLI flag is omitted", () => {
    assert.equal(resolveGuest(undefined, { CC_GUEST: "grok" }), "grok");
    assert.equal(resolveGuest("  ", { CC_GUEST: "GROK" }), "grok");
  });

  it("lets an explicit --guest value override CC_GUEST", () => {
    assert.equal(resolveGuest("claude", { CC_GUEST: "grok" }), "claude");
    assert.equal(resolveGuest("Grok", { CC_GUEST: "claude" }), "grok");
  });

  it("ignores a blank CC_GUEST and keeps the default", () => {
    assert.equal(resolveGuest(undefined, { CC_GUEST: "  " }), "claude");
  });

  it("rejects unknown guests", () => {
    assert.throws(
      () => resolveGuest("codex", {}),
      /Unsupported guest "codex"/
    );
    assert.throws(
      () => resolveGuest(undefined, { CC_GUEST: "chatgpt" }),
      /Unsupported guest "chatgpt"/
    );
  });
});
