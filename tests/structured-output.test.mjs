/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  extractFirstJsonObject,
  parseStructuredOutput,
} from "../scripts/lib/structured-output.mjs";

describe("review output schema", () => {
  it("stays within the Claude CLI-compatible Draft-07 contract", () => {
    const schema = JSON.parse(
      fs.readFileSync(
        new URL("../schemas/review-output.schema.json", import.meta.url),
        "utf8"
      )
    );
    const newerDraftKeywords = new Set([
      "$defs",
      "dependentSchemas",
      "prefixItems",
      "unevaluatedProperties",
    ]);
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        assert.equal(newerDraftKeywords.has(key), false, `${key} requires a newer JSON Schema draft`);
        visit(child);
      }
    };

    assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
    visit(schema);
  });
});

describe("peer output schemas", () => {
  const schemaCases = [
    {
      file: "peer-design-output.schema.json",
      content: {
        alternatives: { type: "array", items: { type: "string" } },
        tradeoffs: { type: "array", items: { type: "string" } },
        decisionDrivers: { type: "array", items: { type: "string" } },
        recommendation: { type: "string" },
        gaps: { type: "array", items: { type: "string" } },
      },
    },
    {
      file: "peer-research-output.schema.json",
      content: {
        findings: { type: "array", items: { type: "string" } },
        sourceQuality: { type: "string" },
        contradictions: { type: "array", items: { type: "string" } },
        confidence: { type: "string" },
        gaps: { type: "array", items: { type: "string" } },
      },
    },
    {
      file: "peer-critique-output.schema.json",
      content: {
        critique: { type: "string" },
        agreements: { type: "array", items: { type: "string" } },
        disagreements: { type: "array", items: { type: "string" } },
        corrections: { type: "array", items: { type: "string" } },
      },
    },
  ];

  it("uses strict documented Draft-07 contracts for every peer phase", () => {
    const unsupportedLimits = new Set(["minItems", "minLength", "minimum", "maximum"]);
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        assert.equal(unsupportedLimits.has(key), false, `${key} is not part of the peer contract`);
        visit(child);
      }
    };

    for (const { file, content } of schemaCases) {
      const schema = JSON.parse(fs.readFileSync(
        new URL(`../schemas/${file}`, import.meta.url),
        "utf8"
      ));
      assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
      assert.equal(schema.type, "object");
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, ["content", "repoCitations", "webCitations"]);
      assert.deepEqual(schema.properties.content, {
        type: "object",
        additionalProperties: false,
        required: Object.keys(content),
        properties: content,
      });
      for (const field of ["repoCitations", "webCitations"]) {
        assert.deepEqual(schema.properties[field], {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "line"],
            properties: {
              path: { type: "string" },
              line: { type: "integer" },
            },
          },
        });
      }
      visit(schema);
    }
  });
});

describe("extractFirstJsonObject", () => {
  it("extracts a JSON object after prose", () => {
    const extracted = extractFirstJsonObject(
      "Intro\n\n{\"ok\":true,\"nested\":{\"a\":1}}\n"
    );
    assert.deepEqual(extracted?.parsed, { ok: true, nested: { a: 1 } });
  });

  it("returns null when no JSON object exists", () => {
    assert.equal(extractFirstJsonObject("hello world"), null);
  });

  it("handles escaped braces inside strings", () => {
    const extracted = extractFirstJsonObject(
      'noise {"message":"brace: \\"{\\"","nested":{"ok":true}} tail'
    );
    assert.deepEqual(extracted?.parsed, {
      message: 'brace: "{"',
      nested: { ok: true },
    });
  });

  it("skips malformed objects and keeps searching", () => {
    const extracted = extractFirstJsonObject(
      'prefix {"bad": } middle {"ok":true}'
    );
    assert.deepEqual(extracted?.parsed, { ok: true });
  });
});

describe("parseStructuredOutput", () => {
  it("parses a full-document JSON object", () => {
    const parsed = parseStructuredOutput(
      "{\"verdict\":\"approve\",\"summary\":\"ok\",\"findings\":[],\"next_steps\":[]}"
    );
    assert.equal(parsed.parseError, null);
    assert.equal(parsed.parsed?.verdict, "approve");
  });

  it("parses a JSON object embedded after prose", () => {
    const parsed = parseStructuredOutput(
      "Now I have all the evidence.\n\n{\"verdict\":\"needs-attention\",\"summary\":\"risk\",\"findings\":[],\"next_steps\":[]}"
    );
    assert.equal(parsed.parseError, null);
    assert.equal(parsed.parsed?.verdict, "needs-attention");
  });

  it("parses fenced JSON blocks", () => {
    const parsed = parseStructuredOutput(
      "```json\n{\"verdict\":\"approve\",\"summary\":\"ok\",\"findings\":[],\"next_steps\":[]}\n```"
    );
    assert.equal(parsed.parseError, null);
    assert.equal(parsed.parsed?.summary, "ok");
  });

  it("returns a parse error for malformed structured output", () => {
    const parsed = parseStructuredOutput(
      "{\"verdict\":\"approve\",\"summary\":"
    );
    assert.equal(parsed.parsed, null);
    assert.match(
      parsed.parseError ?? "",
      /Could not parse structured JSON output/
    );
  });

  it("uses failureMessage context when output is empty", () => {
    const parsed = parseStructuredOutput("", {
      failureMessage: "Claude run failed upstream.",
    });
    assert.equal(parsed.parsed, null);
    assert.equal(parsed.parseError, "Claude run failed upstream.");
  });
});
