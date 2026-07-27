/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { cleanupAfterOfficialUninstall } from "../hooks/lib/plugin-install-guard.mjs";
import {
  isCodexPluginActive,
  removeManagedHooks,
  removeManagedSkillWrappers,
  resolveManagedMarketplacePluginPath,
} from "../scripts/lib/managed-global-integration.mjs";

describe("cleanupAfterOfficialUninstall", () => {
  let codexHome;
  let hooksFile;
  let pluginRoot;
  let rootDir;
  let wrapperDir;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-install-guard-"));
    codexHome = path.join(rootDir, "codex");
    hooksFile = path.join(codexHome, "hooks.json");
    pluginRoot = path.join(rootDir, "plugin");
    wrapperDir = path.join(codexHome, "skills", "cc-review");

    fs.mkdirSync(wrapperDir, { recursive: true });
    fs.mkdirSync(path.join(codexHome, "skills", "unrelated"), { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      "[features]\nhooks = true\n",
      "utf8"
    );
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("removes managed entries after confirmed uninstall and preserves unrelated data", () => {
    const refusalMarker = path.join(
      codexHome,
      "plugins",
      "data",
      "cc",
      "managed-cleanup-refused"
    );
    fs.writeFileSync(
      hooksFile,
      `${JSON.stringify(
        {
          version: 1,
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: "command",
                    command: `node "${path.join(pluginRoot, "hooks", "unread-result-hook.mjs")}"`,
                  },
                  {
                    type: "command",
                    command: "/usr/local/bin/unrelated-hook",
                  },
                ],
              },
            ],
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    fs.mkdirSync(refusalMarker, { recursive: true });

    assert.equal(cleanupAfterOfficialUninstall(pluginRoot, codexHome), true);

    const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    assert.equal(hooks.version, 1);
    assert.deepEqual(
      hooks.hooks.UserPromptSubmit[0].hooks.map((hook) => hook.command),
      ["/usr/local/bin/unrelated-hook"]
    );
    assert.equal(fs.existsSync(wrapperDir), false);
    assert.equal(
      fs.existsSync(path.join(codexHome, "skills", "unrelated")),
      true
    );
    assert.equal(fs.existsSync(refusalMarker), false);
  });

  it("refuses all managed cleanup when hooks JSON is invalid", () => {
    const invalidHooks = "{not-json\n";
    const refusalMarker = path.join(
      codexHome,
      "plugins",
      "data",
      "cc",
      "managed-cleanup-refused"
    );
    fs.writeFileSync(hooksFile, invalidHooks, "utf8");

    const originalWrite = process.stderr.write;
    let stderr = "";
    process.stderr.write = (chunk) => {
      stderr += String(chunk);
      return true;
    };
    try {
      assert.equal(cleanupAfterOfficialUninstall(pluginRoot, codexHome), true);
      assert.equal(cleanupAfterOfficialUninstall(pluginRoot, codexHome), true);
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(fs.readFileSync(hooksFile, "utf8"), invalidHooks);
    assert.equal(fs.existsSync(wrapperDir), true);
    assert.equal(fs.existsSync(refusalMarker), true);
    assert.equal(stderr.match(/managed hook cleanup refused/g)?.length, 1);
    assert.doesNotMatch(stderr, /refusing managed hook cleanup:/);
  });

  it("preserves managed files while the plugin is active", () => {
    const refusalMarker = path.join(
      codexHome,
      "plugins",
      "data",
      "cc",
      "managed-cleanup-refused"
    );
    fs.mkdirSync(path.dirname(refusalMarker), { recursive: true });
    fs.writeFileSync(refusalMarker, "old-reason\n", "utf8");
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      '[plugins."cc@cbepx"]\nenabled = true\n',
      "utf8"
    );

    assert.equal(cleanupAfterOfficialUninstall(pluginRoot, codexHome), false);
    assert.equal(fs.existsSync(wrapperDir), true);
    assert.equal(fs.existsSync(refusalMarker), false);
  });

  it("does not fail a healthy hook when the refusal marker cannot be removed", (t) => {
    const refusalMarker = path.join(
      codexHome,
      "plugins",
      "data",
      "cc",
      "managed-cleanup-refused"
    );
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      '[plugins."cc@cbepx"]\nenabled = true\n',
      "utf8"
    );
    const rmSync = fs.rmSync;
    t.mock.method(fs, "rmSync", (target, options) => {
      if (target === refusalMarker) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return rmSync(target, options);
    });

    assert.equal(cleanupAfterOfficialUninstall(pluginRoot, codexHome), false);
    assert.equal(fs.existsSync(wrapperDir), true);
  });

  it("preserves managed files while a plugin cache entry remains", () => {
    const refusalMarker = path.join(
      codexHome,
      "plugins",
      "data",
      "cc",
      "managed-cleanup-refused"
    );
    fs.mkdirSync(path.dirname(refusalMarker), { recursive: true });
    fs.writeFileSync(refusalMarker, "old-reason\n", "utf8");
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      '[plugins."cc@cbepx"]\nenabled = false\n',
      "utf8"
    );
    fs.mkdirSync(path.join(codexHome, "plugins", "cache", "cbepx", "cc", "test-version"), {
      recursive: true,
    });

    assert.equal(cleanupAfterOfficialUninstall(pluginRoot, codexHome), false);
    assert.equal(fs.existsSync(wrapperDir), true);
    assert.equal(fs.existsSync(refusalMarker), false);
  });
});

describe("managed global integration cleanup", () => {
  let codexHome;
  let hooksFile;
  let pluginRoot;
  let rootDir;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-managed-cleanup-"));
    codexHome = path.join(rootDir, "codex");
    hooksFile = path.join(codexHome, "hooks.json");
    pluginRoot = path.join(rootDir, "plugin");
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function prepareHardLinkedHooks() {
    const linkedHooksFile = path.join(rootDir, "linked-hooks.json");
    const raw = `${JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [
            {
              command: `node "${path.join(pluginRoot, "hooks", "session-lifecycle-hook.mjs")}"`,
            },
            { command: "/usr/local/bin/unrelated-hook" },
          ],
        }],
      },
    })}\n`;
    fs.writeFileSync(hooksFile, raw, "utf8");
    fs.linkSync(hooksFile, linkedHooksFile);
    return { linkedHooksFile, raw, inode: fs.statSync(hooksFile).ino };
  }

  it("accepts a missing hooks file without creating it", () => {
    assert.equal(removeManagedHooks(pluginRoot, codexHome), true);
    assert.equal(fs.existsSync(hooksFile), false);
  });

  it("rejects invalid hooks document shapes without rewriting them", () => {
    for (const value of [null, [], { hooks: [] }, { hooks: "invalid" }]) {
      const raw = `${JSON.stringify(value)}\n`;
      fs.writeFileSync(hooksFile, raw, "utf8");
      assert.equal(removeManagedHooks(pluginRoot, codexHome), false);
      assert.equal(fs.readFileSync(hooksFile, "utf8"), raw);
    }
  });

  it("preserves foreign hook shapes and empty entries while removing managed hooks", () => {
    const foreignEvent = { futureSchema: true };
    const foreignEntry = { matcher: "Future", hooks: "future-schema" };
    const emptyEntry = { matcher: "Bash", hooks: [] };
    fs.writeFileSync(
      hooksFile,
      `${JSON.stringify({
        hooks: {
          FutureEvent: foreignEvent,
          SessionStart: [
            foreignEntry,
            emptyEntry,
            {
              matcher: "",
              hooks: [{
                command: `node "${path.join(pluginRoot, "hooks", "session-lifecycle-hook.mjs")}"`,
              }],
            },
          ],
        },
      })}\n`,
      "utf8"
    );

    assert.equal(removeManagedHooks(pluginRoot, codexHome), true);

    const parsed = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    assert.deepEqual(parsed.hooks.FutureEvent, foreignEvent);
    assert.deepEqual(parsed.hooks.SessionStart, [foreignEntry, emptyEntry]);
  });

  it("preserves the original hooks document when the atomic replace fails", (t) => {
    const raw = `${JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [{
            command: `node "${path.join(pluginRoot, "hooks", "session-lifecycle-hook.mjs")}"`,
          }],
        }],
        Stop: [{
          hooks: [{ command: "/usr/local/bin/unrelated-hook" }],
        }],
      },
    })}\n`;
    fs.writeFileSync(hooksFile, raw, "utf8");

    const renameSync = fs.renameSync;
    t.mock.method(fs, "renameSync", (source, destination) => {
      if (destination === hooksFile) {
        throw new Error("simulated atomic replace failure");
      }
      return renameSync(source, destination);
    });

    assert.throws(
      () => removeManagedHooks(pluginRoot, codexHome),
      /simulated atomic replace failure/
    );
    assert.equal(fs.readFileSync(hooksFile, "utf8"), raw);
    assert.deepEqual(
      fs.readdirSync(codexHome).filter((name) => name.startsWith("hooks.json.tmp.")),
      []
    );
  });

  it("preserves hard-link identity while rewriting managed hooks", () => {
    const { inode, linkedHooksFile } = prepareHardLinkedHooks();

    assert.equal(removeManagedHooks(pluginRoot, codexHome), true);

    assert.equal(fs.statSync(hooksFile).ino, inode);
    assert.equal(fs.statSync(linkedHooksFile).ino, inode);
    const rewritten = fs.readFileSync(linkedHooksFile, "utf8");
    assert.doesNotMatch(rewritten, /session-lifecycle-hook/);
    assert.match(rewritten, /unrelated-hook/);
  });

  it("restores hard-linked hooks when the completed rewrite fails to sync", (t) => {
    const { inode, linkedHooksFile, raw } = prepareHardLinkedHooks();
    const fsyncSync = fs.fsyncSync;
    let syncs = 0;
    t.mock.method(fs, "fsyncSync", (descriptor) => {
      if (++syncs === 2) {
        throw new Error("simulated hard-link sync failure");
      }
      return fsyncSync(descriptor);
    });

    assert.throws(
      () => removeManagedHooks(pluginRoot, codexHome),
      /simulated hard-link sync failure/
    );
    assert.equal(fs.statSync(hooksFile).ino, inode);
    assert.equal(fs.statSync(linkedHooksFile).ino, inode);
    assert.equal(fs.readFileSync(hooksFile, "utf8"), raw);
    assert.equal(fs.readFileSync(linkedHooksFile, "utf8"), raw);
    assert.deepEqual(
      fs.readdirSync(codexHome).filter((name) => name.startsWith("hooks.json.bak.")),
      []
    );
  });

  it("restores hard-linked hooks after a partial in-place write", (t) => {
    const { inode, linkedHooksFile, raw } = prepareHardLinkedHooks();
    const writeFileSync = fs.writeFileSync;
    let descriptorWrites = 0;
    t.mock.method(fs, "writeFileSync", (destination, data, options) => {
      if (typeof destination === "number" && ++descriptorWrites === 2) {
        const partial = Buffer.from(String(data), "utf8").subarray(0, 8);
        fs.writeSync(destination, partial, 0, partial.length, null);
        throw new Error("simulated partial hard-link write");
      }
      return writeFileSync(destination, data, options);
    });

    assert.throws(
      () => removeManagedHooks(pluginRoot, codexHome),
      /simulated partial hard-link write/
    );
    assert.equal(fs.statSync(hooksFile).ino, inode);
    assert.equal(fs.statSync(linkedHooksFile).ino, inode);
    assert.equal(fs.readFileSync(hooksFile, "utf8"), raw);
    assert.equal(fs.readFileSync(linkedHooksFile, "utf8"), raw);
    assert.deepEqual(
      fs.readdirSync(codexHome).filter((name) => name.startsWith("hooks.json.bak.")),
      []
    );
  });

  it("retains the hard-link backup when restoration cannot be synced", (t) => {
    const { inode, linkedHooksFile, raw } = prepareHardLinkedHooks();
    const fsyncSync = fs.fsyncSync;
    let syncs = 0;
    t.mock.method(fs, "fsyncSync", (descriptor) => {
      if (++syncs >= 2) {
        throw new Error("simulated restore sync failure");
      }
      return fsyncSync(descriptor);
    });

    assert.throws(
      () => removeManagedHooks(pluginRoot, codexHome),
      (error) => error instanceof AggregateError &&
        /original content retained/.test(error.message)
    );
    assert.equal(fs.statSync(hooksFile).ino, inode);
    assert.equal(fs.statSync(linkedHooksFile).ino, inode);
    const backups = fs.readdirSync(codexHome)
      .filter((name) => name.startsWith("hooks.json.bak."));
    assert.equal(backups.length, 1);
    assert.equal(
      fs.readFileSync(path.join(codexHome, backups[0]), "utf8"),
      raw
    );
  });

  it("matches managed Windows hook paths case-insensitively", () => {
    const windowsPluginRoot = "C:\\Users\\Test\\plugins\\cc";
    fs.writeFileSync(
      hooksFile,
      `${JSON.stringify({
        hooks: {
          SessionStart: [{
            hooks: [{
              command: `node "${path.win32.join(
                "c:\\users\\test\\plugins\\cc",
                "hooks",
                "session-lifecycle-hook.mjs"
              )}"`,
            }],
          }],
        },
      })}\n`,
      "utf8"
    );

    assert.equal(
      removeManagedHooks(windowsPluginRoot, codexHome, { platform: "win32" }),
      true
    );
    assert.equal(fs.existsSync(hooksFile), false);
  });

  it("deletes a hooks file that contains only a managed hook", () => {
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  command: `node "${path.join(pluginRoot, "hooks", "unread-result-hook.mjs")}"`,
                },
              ],
            },
          ],
        },
      }),
      "utf8"
    );

    assert.equal(removeManagedHooks(pluginRoot, codexHome), true);
    assert.equal(fs.existsSync(hooksFile), false);
  });

  it("removes every managed skill and prompt wrapper", () => {
    const wrapperNames = [
      "review",
      "adversarial-review",
      "rescue",
      "status",
      "result",
      "cancel",
      "setup",
    ];
    for (const name of wrapperNames) {
      const skillDir = path.join(codexHome, "skills", `cc-${name}`);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), name, "utf8");
      fs.mkdirSync(path.join(codexHome, "prompts"), { recursive: true });
      fs.writeFileSync(path.join(codexHome, "prompts", `cc-${name}.md`), name, "utf8");
    }

    removeManagedSkillWrappers(codexHome);

    assert.equal(fs.existsSync(path.join(codexHome, "skills")), false);
    assert.equal(fs.existsSync(path.join(codexHome, "prompts")), false);
  });

  it("reports active plugin state and resolves a personal marketplace path", () => {
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      '[plugins."cc@cbepx"]\nenabled = true\n',
      "utf8"
    );
    assert.equal(isCodexPluginActive(codexHome), true);

    const homeDir = os.homedir();
    assert.equal(
      resolveManagedMarketplacePluginPath(path.join(homeDir, "plugins", "cc")),
      "./plugins/cc"
    );
    assert.throws(
      () => resolveManagedMarketplacePluginPath(homeDir),
      /Plugin root must not be the marketplace root itself/
    );
  });
});
