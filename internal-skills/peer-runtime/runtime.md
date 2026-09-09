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
2. Run `mcp-diagnose --json` with the user's exact MCP flags. This actively starts/probes every configured server in scope and can therefore have server-defined side effects. The active Codex controller chooses the smallest relevant subset of eligible exact IDs from their descriptions. Pass those choices as repeated internal `--auto-mcp-tool` values to `peer-create`; Node validates exact IDs and safety only. Eligibility trusts a server's `readOnlyHint` declaration or an immutable four-ID audited registry — Context7 `mcp__context7__query-docs` and `mcp__context7__resolve-library-id`, plus Brave `mcp__brave-search__brave_web_search` and `mcp__brave-search__brave_llm_context`. It is not an OS sandbox and always vetoes `destructiveHint`. Only the two Brave IDs are Brave web-evidence tools; no other Brave ID is eligible through the registry. With `--no-auto-tools`, choose none automatically. Exact user pins remain exact and still must be eligible.
3. Keep a shell-hostile or multiline brief out of argv: normalize it once, write it to an OS temporary file outside the workspace, and use the internal `--brief-file`. Delete that temporary file after `peer-create` returns.
4. Run `peer-create --mode <mode> --cwd <workspaceRoot> --owner-session-id <ownerSessionId> ... --json`. Preserve public model/MCP flags and controller-selected internal IDs.
5. `peer-create` has already reserved the Codex memo, Claude memo, and checkpoint attempts atomically. Use its returned `spawnPlan` with built-in `spawn_agent`: spawn exactly two children. For both, pass `fork_turns: "none"` and the returned self-contained message. Do not add parent history.

The Codex reasoning child uses `reasoning_effort: "xhigh"` by default. Omit `model` when `--codex-model` was not supplied; otherwise pass the requested model. The Claude forwarder uses `reasoning_effort: "medium"` and omits `model`, inheriting the active runtime model.

Both messages carry identical normalized brief bytes and SHA-256 hash. Each child cannot read the sibling memo before submitting its own.

Initial execution is always background: do not wait in the parent turn. Return the workflow ID; the checkpoint supplies the exact continue/retry commands when the background workers finish.

## Child contracts

The Codex reasoning worker is not a forwarder. It first activates its reserved memo attempt by sending the raw lease through JSON stdin to the returned `peer-activate-attempt` command, then researches independently with the repo and web routes exposed to its turn and performs zero workspace writes. It sends `{lease,payload:{content,repoCitations,webCitations,toolEvents}}` as JSON on stdin to `peer-submit-memo`. Every specialized mutating command includes `--epoch <returned-epoch>` from its spawn or resume plan; never omit or refresh that captured workflow epoch inside an old worker. That command accepts only the Codex memo; Claude memo submission occurs only inside the trusted `peer-claude-turn` execution path. It then makes separate short foreground one-shot `peer-wait` calls, waiting for each call to exit before starting another; never use `while`, shell loops, background processes, or persistent pollers. The status-only view always omits memo bodies and redacts the sibling payload until the Codex memo is sealed. After `readyForCheckpoint` becomes true, run the generated `CC_PEER_READ_EXPORT` recipe and inspect every required field with `CC_PEER_READ_SECTION`, advancing `nextOffset` until null. These recipes use `workflow-read --output <new-path>` in a private temporary directory outside the workspace. Clean the export after all required sections have been read. Never compare a truncated preview. If Claude completed, it activates its checkpoint reservation immediately before comparison and sends `{lease,payload:{agreements,disagreements,decisionsNeeded}}` as JSON on stdin to `peer-checkpoint`. If Claude is incomplete, it stops without replacing either memo.

A Claude-first forwarder uses one absolute 30-minute deadline while waiting for the Codex memo, with exponential polling from 100 ms capped at 2 seconds; transient Codex retry does not reset the deadline. The unrevealed Claude payload stays process-local throughout that wait. On timeout, discard it and mark only Claude retryable with `PEER_SIBLING_TIMEOUT`. Explicit retry preserves a committed waiter only when its newest linked memo job is still active and not reaped; a missing, terminal, or lost current worker rotates that unfinished target, while `cancel_failed` remains terminal with no retry plan. Rebind, SessionEnd, and cancellation invalidate old epochs before late callbacks can write.

Each worker receives only its own raw lease in its spawn message. A raw lease is never a Node argv value and never enters workflow, job, log, status, result, or rendered state. Durable targets contain only `attemptReservation: { leaseDigest, epoch, reservedAt, previousFailureDetail }`; `previousFailureDetail` is nullable and restricted to the bounded workflow failure-detail allowlist. Attempts and append-only attempt history advance when activation wins, not when the controller reserves work. Submit and failure transitions reuse the activated lease and epoch fence.

The pure Claude forwarder must run exactly one companion command, in the foreground, and return its bounded receipt stdout unchanged. It does no repository inspection or reasoning itself. Never use shell backgrounding (`nohup`, detached spawn, or an ampersand operator). Never invoke `codex exec`. If the shell yields a session, poll that same session until exit.

Initial and critique peer turns explicitly select Read, Glob, Grep, WebSearch, WebFetch, and ToolSearch with `--tools`, preserving exact selected MCP permission grants. The companion enforces `permission-mode=dontAsk`, a strict MCP config, and exact `--disallowedTools` rules for every discovered unselected MCP ID; peer turns have no Bash, no Agent, and no write builtins. ToolSearch and schema-injected StructuredOutput are narrow protocol exceptions, not repository or web evidence. Before accepting either memo or critique, the companion rejects actual tool events outside the base tools, frozen exact MCP selection, and those two protocol exceptions with `EVIDENCE_INCOMPLETE` / `TOOL_EVENT_NOT_ALLOWED`. This acceptance guard cannot undo a tool call already executed. Peer-only CLI settings set `disableAllHooks: true` to suppress ordinary user, project, local, and plugin hooks; managed administrator hooks remain a managed-policy trust boundary. It also requires a fail-closed filesystem sandbox: native Windows is unsupported, unsandboxed commands are disabled, the canonical workspace is the only explicit read allowance, and canonical `CODEX_HOME` plus `~/.claude/projects` are denied by both the sandbox and Read permission rules. If the required filesystem sandbox is unavailable or the workspace overlaps protected state, fail closed with `PEER_ISOLATION_UNAVAILABLE` before research can proceed. Selected external MCP servers remain trusted declarations rather than an OS sandbox; the rendered manifest preserves the exact trust basis. Revalidation starts/probes only the servers represented in the frozen selection. It records requested/final/fallback model telemetry and actual public tool-event names. A Brave event is web evidence only if its exact ID is one of the two audited IDs and is present in that frozen manifest; an unselected or lookalike Brave ID does not count.

The frozen manifest binds selected tool IDs and their audited eligibility, not a remote provider implementation. An `@latest` Brave server can change behavior behind an unchanged ID, so pin the server when that residual drift is unacceptable. Brave query and LLM-context input are disclosed to the selected external provider; do not send secrets or sensitive brief/context material. Redacting raw MCP configuration and credentials from workflow state does not remove that disclosure risk.

Initial and critique turns are each a fresh Claude turn with `--no-session-persistence`; they never resume or fork a prior session. Tracked progress is content-free until reveal: only phase, tool name, and model-fallback metadata may reach tracked jobs or logs. Text, thinking, tool input, prompt, memo, and terminal payload stay out of tracked state until the trusted reveal transition succeeds.

Each foreground Claude peer turn is registered as a workflow-linked tracked job owned by the workflow session, so SessionEnd can terminate the identity-matched Claude process before marking unfinished work retryable. A failed or unresolved linked cancellation leaves the target `cancel_failed` with no retry work.

Every initial memo needs non-empty structured content, a canonical in-workspace repository citation, a direct `https://` citation, and an unchanged workspace fingerprint. Claude additionally needs actual repository and web tool events, and continuation requires non-empty structured critique content. Missing evidence becomes `incomplete`; never waive or fabricate it.

`peer-checkpoint` preserves separate frozen memos and adds agreements, disagreements, source/tool manifests, and decisions needed. Its final `commands` entries are the exact `$cc:<mode> --continue <workflow-id>` and `$cc:<mode> --retry <workflow-id>` commands.

## Continue

Continue is foreground.

1. Read the explicit workflow in the current canonical workspace. Run `peer-resume-plan <id> --continue --owner-session-id <current-id> --json`. Empty or closed stdin means no optional feedback; non-empty feedback must be a JSON object on stdin. This explicitly rebinds a cross-session owner and reserves critique plus synthesis before dispatch; never use generic rescue `--resume-last`.
2. Execute the returned plans sequentially. Spawn the pure Claude forwarder with `fork_turns: "none"`, inherited model, and medium effort. Its heredoc supplies the reserved critique lease to the one foreground `peer-claude-critique` command. Wait for it.
3. The companion starts one fresh Claude turn with `--no-session-persistence`. Its stdin prompt contains the frozen brief, both frozen memos, and feedback; neither memo is rewritten.
4. Spawn the returned Codex synthesizer with `fork_turns: "none"`, the workflow's Codex model choice, and Codex effort. It makes short one-shot `peer-wait` calls until `stages.critique.status` is `completed`, exports the full frozen workflow with the returned read recipe, reads both memos, checkpoint, feedback, critique and manifests completely in sections, removes the temporary export, activates its supplied synthesis lease immediately before synthesis, produces the mode-specific final answer, sends `{lease,payload}` as JSON on stdin to `peer-final`, and performs zero workspace writes. Its stdout is only a bounded receipt; wait for it, then export `result <id> --output <new-path> --json` into a temporary directory outside the workspace, inspect the complete `workflow.finalResult` in sections, clean up the export and return the stored final answer.

## Retry

Run `peer-resume-plan <id> --retry --owner-session-id <current-id> --json`. It rotates reservations only for unfinished targets and returns the exact fenced spawn plans. Execute only those plans:

- a missing `codex` branch gets an independent Codex reasoning worker;
- a missing `claude` branch gets the pure Claude forwarder plus a checkpoint waiter even when Codex is already complete;
- a missing `checkpoint` gets a Codex checkpoint worker after both memos are terminal;
- a missing `critique` gets the foreground Claude forwarder, then synthesis if still missing;
- a missing `synthesis` gets only the foreground Codex synthesizer.

When Codex itself retries, its worker owns the checkpoint lease instead of spawning a second waiter. Never restart or replace a completed branch/stage; retry only the missing stage and its still-unfinished downstream work, while completed payload bytes stay immutable. A cross-session retry uses the explicit workflow rebind, never generic task resume.

SessionEnd owns shutdown: active linked companion work is stopped first; only targets whose linked cancellation is terminally successful become retryable. Cancellation failure remains `cancel_failed`, exposes no retry work, and no child may keep the workflow running headless.

## Public reads

`status`, `result`, `workflow-read`, `workflow-list` and `peer-wait` default to at most 8192 UTF-8 bytes in either format. JSON stays parseable and includes `truncated` plus explicit omissions. `workflow-list --json` returns `{workflows,total,truncated,omissions}`. Status/list/poll omit result bodies and attempt history. Short one-shot polling never consumes terminal notifications; do not treat readiness as memo delivery.

All five accept `--output <new-path>` to export their full authorized JSON shape without the preview cap (workflow-list exports its original array). The receipt contains `outputFile`, `bytes` and `sha256`; existing files and symlinks are refused. Export failures leave notifications unread. `peer-wait --output` also leaves aggregate notifications unread because its exported memos do not deliver checkpoint/final output; pre-seal redacted exports never acknowledge a withheld aggregate. Public exports never reveal raw leases or sibling data before Codex seals its memo. Use the generated export and section commands for workers, retain their captured epoch, and never synthesize silently from a preview.
