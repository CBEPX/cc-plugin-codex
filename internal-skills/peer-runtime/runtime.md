# Peer workflow runtime

Use this supporting contract for `$cc:design` and `$cc:research`. Resolve `<plugin-root>` from the invoking skill. Every companion command runs from the active user workspace, never from the plugin cache.

## Parse and preflight

Public forms are:

- New: `[--model <model>] [--fallback-model <model>] [--effort <effort>] [--codex-model <model>] [--codex-effort <effort>] [--user-mcp-tool <exact-id> ...] [--allow-project-mcp-servers] [--no-auto-tools] <brief>`
- Continue: `--continue <workflow-id> [feedback]`
- Retry: `--retry <workflow-id>`

Reject mixed forms. New defaults are Claude `fable`, fallback `opus`, inherited Codex model, and Codex effort `xhigh`.

For a new run, inspect the tools and skills actually exposed to this Codex turn. Require both:

- a repository-read route, such as the current shell/read tools;
- a web-search/read route, such as the exposed `web-search` plus `llm-context` skills or equivalent current tools.

Do not infer availability from installed files, config, cache, or plugin metadata. This live preflight happens before `peer-create`, so a failed preflight creates no workflow state.

If either capability is missing, stop. List at most three relevant manager choices that are already exposed, such as `skill-installer`, `find-skills`, or `plugin-management`. Ask for explicit installation confirmation; do not install automatically. After any approved install and required restart, rerun preflight from the live turn before creating state.

In short: rerun preflight after installation or restart.

## New workflow

1. Resolve routing with `session-routing-context --json`.
2. Run `mcp-diagnose --json` with the user's exact MCP flags. This actively starts/probes every configured server in scope and can therefore have server-defined side effects. The active Codex controller chooses the smallest relevant subset of eligible exact IDs from their descriptions. Pass those choices as repeated internal `--auto-mcp-tool` values to `peer-create`; Node validates exact IDs and safety only. Eligibility trusts a server's `readOnlyHint` declaration or the audited registry, is not an OS sandbox, and always vetoes `destructiveHint`. With `--no-auto-tools`, choose none automatically. Exact user pins remain exact and still must be eligible.
3. Keep a shell-hostile or multiline brief out of argv: normalize it once, write it to an OS temporary file outside the workspace, and use the internal `--brief-file`. Delete that temporary file after `peer-create` returns.
4. Run `peer-create --mode <mode> --cwd <workspaceRoot> --owner-session-id <ownerSessionId> ... --json`. Preserve public model/MCP flags and controller-selected internal IDs.
5. Use the returned `spawnPlan` with built-in `spawn_agent`: spawn exactly two children. For both, pass `fork_turns: "none"` and the returned self-contained message. Do not add parent history.

The Codex reasoning child uses `reasoning_effort: "xhigh"` by default. Omit `model` when `--codex-model` was not supplied; otherwise pass the requested model. The Claude forwarder uses `reasoning_effort: "medium"` and omits `model`, inheriting the active runtime model.

Both messages carry identical normalized brief bytes and SHA-256 hash. Each child cannot read the sibling memo before submitting its own.

Initial execution is always background: do not wait in the parent turn. Return the workflow ID; the checkpoint supplies the exact continue/retry commands when the background workers finish.

## Child contracts

The Codex reasoning worker is not a forwarder. It researches independently with the repo and web routes exposed to its turn, performs zero workspace writes, and sends one object with `content`, `repoCitations`, `webCitations`, and public `toolEvents` as JSON on stdin to `peer-submit-memo`. Every specialized mutating command includes `--epoch <returned-epoch>` from its spawn or resume plan; never omit or refresh that captured workflow epoch inside an old worker. That command accepts only the Codex memo; Claude memo submission occurs only inside the trusted `peer-claude-turn` execution path. It then polls `peer-wait`, whose status-only view redacts the sibling payload until the Codex memo is sealed. If Claude completed, it compares the separate frozen memos and sends `agreements`, `disagreements`, and `decisionsNeeded` as JSON on stdin to `peer-checkpoint`. If Claude is incomplete, it stops without replacing either memo.

The pure Claude forwarder must run exactly one companion command, in the foreground, and return stdout unchanged. It does no repository inspection or reasoning itself. Never use shell backgrounding (`nohup`, detached spawn, or an ampersand operator). Never invoke `codex exec`. If the shell yields a session, poll that same session until exit.

`peer-claude-turn` gives Claude only Read, Glob, Grep, the selected `WebSearch, WebFetch` route, and exact selected MCP tools. The companion enforces `permission-mode=dontAsk`, a strict MCP config, no Bash, and no Agent. Selected external MCP servers remain trusted declarations rather than an OS sandbox; the rendered manifest preserves the exact trust basis. Revalidation starts/probes only the servers represented in the frozen selection. It records requested/final/fallback model telemetry and actual public tool-event names.

Each foreground Claude peer turn is registered as a workflow-linked tracked job owned by the workflow session, so SessionEnd can terminate the identity-matched Claude process before marking unfinished work retryable. A failed or unresolved linked cancellation leaves the target `cancel_failed` with no retry work.

Every initial memo needs non-empty structured content, a canonical in-workspace repository citation, a direct `https://` citation, and an unchanged workspace fingerprint. Claude additionally needs actual repository and web tool events, and continuation requires non-empty structured critique content. Missing evidence becomes `incomplete`; never waive or fabricate it.

`peer-checkpoint` preserves separate frozen memos and adds agreements, disagreements, source/tool manifests, and decisions needed. Its final `commands` entries are the exact `$cc:<mode> --continue <workflow-id>` and `$cc:<mode> --retry <workflow-id>` commands.

## Continue

Continue is foreground.

1. Read the explicit workflow in the current canonical workspace. Run `peer-resume-plan <id> --continue --owner-session-id <current-id> --json`, sending optional feedback as JSON on stdin. This explicitly rebinds a cross-session owner; never use generic rescue `--resume-last`. Capture the returned workflow epoch in every `peer-claude-critique` and `peer-final` command.
2. Spawn one pure Claude forwarder with `fork_turns: "none"`, inherited model, and medium effort. It runs exactly one foreground `peer-claude-critique` command and returns stdout unchanged. Wait for it.
3. The companion resumes only the workflow-owned Claude session with both `--resume <id>` and `--fork-session`. Its stdin prompt contains both frozen memos plus feedback; neither memo is rewritten.
4. Spawn one Codex synthesizer with `fork_turns: "none"`, the workflow's Codex model choice, and Codex effort. It reads the frozen workflow, produces the mode-specific final answer, sends it as JSON on stdin to `peer-final`, and performs zero workspace writes. Wait for it and return the stored final answer.

## Retry

Run `peer-resume-plan <id> --retry --owner-session-id <current-id> --json`. Execute only the returned work, passing the returned workflow epoch to each specialized mutating command:

- a missing `codex` branch gets an independent Codex reasoning worker;
- a missing `claude` branch gets the pure Claude forwarder;
- a missing `checkpoint` gets a Codex checkpoint worker after both memos are terminal;
- a missing `critique` gets the foreground Claude forwarder, then synthesis if still missing;
- a missing `synthesis` gets only the foreground Codex synthesizer.

Never restart or replace a completed branch/stage; retry only the missing stage. A cross-session retry uses the explicit workflow rebind, never generic task resume.

SessionEnd owns shutdown: active linked companion work is stopped first; only targets whose linked cancellation is terminally successful become retryable. Cancellation failure remains `cancel_failed`, exposes no retry work, and no child may keep the workflow running headless.
