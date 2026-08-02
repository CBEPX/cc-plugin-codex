# Changelog

## [Unreleased]

## v1.5.3

### Fixed

- Keep Codex SessionEnd cleanup within its three-second ceiling by bounding workspace detection and sharing one monotonic deadline across state-lock retries and bounded PID identity/termination commands, capped 500 ms before the hook ceiling.
- Record ended sessions before taking per-job locks, persist unresolved PID/identity handles in a non-terminal `session_cleanup_pending` phase before termination, surface automatic and identity-aware manual cleanup, and let the next top-level `SessionStart` recover unmarked or pending jobs without touching unrelated and nested sessions.
- Keep deadline-bound Windows lock publication independent of a cold CIM startup; target-process verification remains fail-closed and leaves an explicit pending/manual-cleanup state when PowerShell cannot finish inside the hook budget.

## v1.5.2

### Added

- Isolate every test process behind a temporary `CODEX_HOME` preload and add a sentinel regression test proving production state helpers cannot write into the user's real Codex state.
- Add enforced C8 coverage gates with a 89/89/79/96 ratchet, test-source type checking, full macOS/Linux and Node.js 18 unit coverage, a curated Windows-safe suite, and retained CI reports.
- Gate pull requests with Stryker's parser contracts at an 80% break threshold plus managed-cleanup and installer shards at 55%; run all seven shards on the weekly/manual job and fail if line-range scopes drift away from their named functions.

### Changed

- Replace broad prose snapshots with focused executable skill-contract checks while retaining workspace, foreground execution, empty-placeholder, model-inheritance, notification, routing, raw-CLI fallback, and background-launch invariants.
- Expand regression coverage for current Claude Code behavior, Opus aliases, hook block/error paths, installer RPC failures, job selection, managed cleanup, and the existing normalized `contextWindow` JSON contract.

### Fixed

- Refuse managed global cleanup when `hooks.json` is malformed or has an invalid shape, preserving hook and wrapper data instead of partially deleting it.
- Preserve unrelated hook document keys and entries while removing only plugin-managed hooks and wrappers after confirmed official uninstall signals.
- Validate marketplace and hook documents before mutation, tolerate unavailable or unrecognized Codex `plugin/uninstall` failures, and keep explicit RPC permission/auth refusals fail-closed unless the recovery override is set.
- Derive uninstall targets from observed config/cache state, attempt every installed marketplace even when an earlier uninstall RPC is unavailable, and continue validated local cleanup when stale Codex state or future RPC wording would otherwise make uninstall permanently unrepeatable.
- Match only anchored plugin-absence RPC messages so unexpected errors containing words such as `unknown` or `not found` are handled by the explicit recovery policy instead of being misclassified as confirmed absence.
- Keep install/update/uninstall recoverable when foreign hook data is malformed, with an explicit escape hatch that preserves risky legacy hook files while still removing official plugin config and cache state.
- Rewrite retained global `hooks.json`, shared `config.toml`, and personal `marketplace.json` documents through synced same-directory temporary files and atomic renames when inode identity can change; follow existing symlinks, preserve file modes, and recover hard-linked in-place rewrites from synced backups.
- Defer destructive legacy-install cleanup until the replacement Codex marketplace/plugin install succeeds, so an unavailable remote update leaves the working legacy install intact.
- Stop obsolete hooks after confirmed official uninstall even when malformed hook data blocks cleanup, with a resettable one-time repair warning.
- Keep refusal-marker cleanup best-effort so permissions or Windows file locking cannot fail healthy native hook invocations or an otherwise completed uninstall.
- Preserve foreign hook shapes and empty entries, and make the shipped legacy hook installer fail before changing config when cleanup is unsafe.
- Match managed hook paths case-insensitively on Windows, exercise cleanup and line-range guards in Windows CI, and validate complete function spans for mutation scopes.
- Launch both legacy JavaScript and current native Claude Code npm shims directly on Windows, skipping stale or unsupported shims when a later PATH entry is usable, avoiding Node.js `.cmd` spawn failures without routing prompts through a command shell.
- Record Windows process identities through CIM and atomically compare the stored identity before dispatching `taskkill`, re-checking failed terminations so processes that exit during cancellation are reported accurately.
- Keep Windows hooks responsive with a time-bounded, half-open circuit breaker for read-only CIM probes while bypassing it for required spawn-time identity capture, persist failed reaper-probe throttling across one-shot hook processes with a two-second read-only timeout, always attempt atomic identity-checked cancellation for every job, distinguish pre-check absence, CIM failure, and exit during `taskkill`, grant five-minute identity leases only after successful verification, retain the first unavailable-check timestamp without refreshing it, fail open when that timestamp cannot be persisted, stop treating the job as active after a fifteen-minute unverifiable ceiling while preserving late successful results and requiring explicit CIM verification before rendering any destructive Windows cleanup command, bound cancellation identity and termination calls to ten seconds, cap aggregate SessionEnd process cleanup at twenty seconds before preserving remaining jobs for manual recovery, and hide every spawned command window.
- Resolve lock-owner identity before publication, stage the complete ownership record privately and atomically hard-link it into place, fall back once per process to exclusive-create publication on filesystems that reject hard links, use per-owner tokens so stale holders cannot remove replacement locks, retry tagged lock contention without rewriting successful executions as raw filesystem failures, clean up only crash-orphaned staging files whose names exactly match the writer's format, protect legacy malformed locks with a fifteen-second grace period, and recover otherwise unverifiable locks after a two-minute hard ceiling.
- Keep unverifiable live-owner locks fail-closed within that ceiling, treat identity lookup races and timeouts as unverifiable instead of PID mismatches, deliberately keep POSIX job reaping fail-open when identity lookup is unavailable, treat `EPERM` liveness probes as proof that POSIX processes and process groups still exist, preserve recovery PIDs when POSIX cancellation cannot verify a live process group, re-check a surviving leader's identity before SIGKILL while still escalating orphaned child groups after their leader exits, classify already-exited POSIX and Windows process trees accurately, and render platform-correct manual cleanup commands against the same PID that was verified.
- Run the process lifecycle suite in Windows CI with platform-neutral Node.js fixtures, including a real CIM lookup and identity-checked child-process tree termination, and expand mutation shards across the complete changed process, reaper, and lock-recovery functions.

## v1.5.1

### Fixed

- Keep parent and foreground companion commands in the active Codex user workspace, validate explicit workspace paths, and reject an installed plugin-cache directory as the job workspace.
- Reuse the canonical `workspaceRoot` returned by `background-routing-context` in forwarding-child task and review commands, so reserved job IDs and their consumers always share the same workspace state.
- Canonicalize Codex plugin-cache detection so macOS `/var` versus `/private/var` aliases cannot bypass workspace and hook-trust safeguards.
- Refresh the transitive development-only `brace-expansion` lockfile entry to `5.0.8`, clearing the known high-severity audit finding without changing the Node.js 18+ plugin runtime.

## v1.5.0

### Added

- Expose Claude's terminal `contextWindow` telemetry in task and review JSON payloads, using `null` when the CLI does not report it.

### Changed

- Keep `requestedModel` as the forwarded Claude alias or pinned ID while reporting the concrete terminal `finalModel` observed from Claude Code.
- Pass `fable` through without the legacy `[1m]` suffix because Fable 5 has a native 1M context window, leaving current-model resolution to Claude Code.
- Let built-in forwarding subagents inherit the current Codex runtime model at medium effort; this avoids stale pins but can cost more than the former mini-model forwarder.

### Fixed

- Use the Claude CLI-compatible JSON Schema Draft-07 dialect for adversarial review structured output.
- Pass native Claude model aliases through to Claude Code so they follow current models such as Opus 5, while full model IDs remain pinned.
- Adapt built-in forwarding subagents to whether the runtime requires `agent_type`, instead of relying on removed metadata or a fixed `gpt-5.4-mini` to `gpt-5.4` fallback chain.
- Match terminal context telemetry across equivalent Claude model IDs, including multi-model usage and `[1m]` suffixes, without attributing a window when the terminal model is unknown or synthetic.
- Normalize pre-v1.5 task and review results so `status` and `result` JSON consistently expose `contextWindow: null`.
- Keep default effort selection exact for pinned model IDs while adding Opus 5, including current `[1m]` variants, so older pinned versions do not silently inherit current-family effort defaults.

## v1.4.0

### Added

- Stream subagent (Task) output from Claude turns as tagged display-only progress events (`subagent_text`/`subagent_thinking`/`subagent_tool_use`), so long turns blocked on a subagent show liveness in `[cc]` progress and job logs. Enabled via `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT=1` on the spawned `claude -p`; older Claude builds degrade silently.

### Fixed

- Keep forwarded subagent events out of parent-turn parser state so subagent text, tools, models, and results can never pollute `finalMessage`, `toolUses`, `touchedFiles`, or structured output — including when the forwarding env var is inherited from the user's shell.
- Trim job logs with a stat check and 75%-of-cap hysteresis instead of re-reading the whole log on every append, removing multi-thousand-fold read amplification on token-level progress streams.
- Stop late progress events from overwriting the phase of a job that already reached a terminal status.

## v1.3.2

### Fixed

- Replace stale upstream install, issue tracker, package metadata, installer defaults, and rendered asset links with CBEPX fork targets.

## v1.3.1

### Fixed

- Add a CBEPX fork marketplace snapshot and document fork-first install commands for the packaged fork release.

## v1.3.0

### Added

- Add `$cc:transfer` to import the current Claude transcript into a resumable Codex thread.
- Add explicit `--user-mcp-tool` opt-in for review and adversarial-review runs, with project `.mcp.json` servers gated behind `--allow-project-mcp-servers`.
- Add `$cc:mcp-diagnose` to explain which Claude MCP servers and requested tools the plugin can see for review commands without exposing raw server configs or secrets.
- Add the `fable` Claude model alias for review, adversarial-review, and rescue/task commands, resolving to `claude-fable-5[1m]` without adding a hidden effort default.

### Changed

- Track Claude model fallback events in task and review results, including terminal-only model changes.
- Harden foreground task observation, cancellation races, long/untracked review context handling, and Codex app-server waits.
- Update the built-in Claude model aliases to `claude-opus-4-8` and `claude-sonnet-5`.

### Fixed

- Classify Claude usage-limit failures separately from generic Claude failures without creating synthetic model fallback history.
- Preserve detached background worker stdout/stderr in job logs so auto-reaped review/task failures keep useful diagnostics.
- Keep successful Claude runs intact when their final output mentions rate limiting or `429` handling.
- Avoid usage-limit summaries for failed turns whose model output only discusses `429`, rate-limit handling, or quoted limit prose without Claude's terminal limit signal.
- Scope usage-limit reset extraction to canonical Claude limit lines so unrelated `reset` prose or fixture epoch fragments do not leak into user-facing summaries.
- Avoid usage-limit summaries for exit-zero `unknown` turns that produced a terminal result plus parse-error noise.
- Stop synthesizing model fallback warnings when a terminal model id only omits the Claude CLI `[1m]` context suffix.

## v1.2.1

- Switch marketplace installs to Codex native plugin hooks: bundled hooks now load from `hooks/hooks.json` in the active plugin cache with `$PLUGIN_ROOT` instead of writing managed global hook commands into `~/.codex/hooks.json`.
- Remove the local checkout/stable-root install path from the supported install flow. The installer now uses `marketplace/add` + `plugin/install`, cleans stale `~/.codex/plugins/cc` state, and enables `[features].hooks` plus `[features].plugin_hooks`.
- Update public skills to resolve the active plugin root from their `SKILL.md` path, so marketplace cache installs run the matching companion code after plugin updates.
- Refresh README, setup, installer, and E2E coverage around the marketplace/cache-only install path, native hook feature-gate repair, and `$cc:setup` trust repair for this plugin's hook hashes.

## v1.2.0

- Default the Claude model for `review`, `adversarial-review`, and `rescue`/`task` to `opus` (resolved to the 1M-context variant `claude-opus-4-7[1m]`) with `xhigh` effort. The `sonnet` alias resolves to `claude-sonnet-4-6[1m]` and defaults to `high` effort; `haiku` stays on `claude-haiku-4-5` with effort unset. `--model` and `--effort` remain user-overridable; `xhigh` is now a first-class effort level and `max` is reserved for users who explicitly opt in.
- Isolate `review` and `adversarial-review` from the user repo with a three-layer design instead of the previous Bash-pattern allowlist (which the Claude CLI does not strictly enforce — once `Bash` is in the allowlist with any sub-pattern, the entire `Bash` tool opens up). Reviews now run inside an ephemeral `git worktree` checked out at the branch tip (or the original repo for `working-tree` scope, so staged/unstaged/untracked changes remain visible), use a bundled read-only git MCP server (`mcp-git` subcommand) exposing `diff`/`log`/`show`/`blame`/`status`/`grep`/`ls_files` as structured tools with strict ref/path validation, and tighten the allowlist to `Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, and `mcp__gitReview__*` only (no `Bash` entry).
- Leave network unrestricted in the `read-only` sandbox preset so `WebFetch`/`WebSearch` and the Claude CLI's own API path keep working; safety comes from removing `Bash` from the allowlist rather than from blocking network. File writes outside the OS temp dir stay blocked.
- Expose `--effort` on `review` and `adversarial-review` and document the new defaults in `SKILL.md`, `README.md`, and the internal `cli-runtime` reference.
- Sweep stranded `review-worktrees/`, `sandbox/`, and `mcp/` runtime files older than six hours at the start of every review to reclaim resources after `kill -9` or crashed runs.

## v1.1.0

- Restructure the internal Claude runtime and prompt-shaping guidance from pseudo-hidden `SKILL.md` files into plain internal reference documents, while keeping the public `review`, `adversarial-review`, and `rescue` skills self-sufficient on their critical invocation rules.
- Add a shared internal runtime reference for review/adversarial-review and strengthen the contract tests so installed-root routing, exact `send_input` notification shape, and empty routing-placeholder guards stay locked in across future cleanup passes.
- Tighten the built-in background forwarding contract so the child must run the companion command as one blocking foreground shell-tool call instead of spawning a background terminal/session of its own, and add E2E coverage for that regression.
- Remove workstation-specific absolute internal-doc link targets from the public skill docs so source trees, installed copies, and marketplace snapshots all keep valid internal references.

## v1.0.9

- Add marketplace-aware install foundation for Codex 0.121+: the installer can now prefer `marketplace/add` + `plugin/install` when an official marketplace source is available, while keeping the existing legacy fallback path for unsupported builds.
- Generalize managed plugin identity handling so setup, hook cleanup, and cache detection work for `cc@<marketplace>` installs instead of assuming `cc@local-plugins`.
- Document the new canonical marketplace location at `sendbird/codex-marketplace` and make Sendbird marketplace install the first documented path, with `$cc:setup` called out as the required post-install hook repair step.

## v1.0.8

- Clarify the routing boundary between `$cc:review`, `$cc:adversarial-review`, and `$cc:rescue`, including the rule that ordinary code-review requests default to `review`, stronger scrutiny plus custom focus text belongs to `adversarial-review`, and rescue is only for Claude-owned follow-through work.
- Add E2E coverage that injects both review skills together and verifies the focus-text distinction is surfaced to the parent turn while the adversarial focus path still reaches Claude end to end.
- Refresh the macOS integration concurrency test so aggressive concurrent polling no longer flakes when some jobs finish slightly later than the initial polling window.
- Update development dependencies with the merged Dependabot patch bumps for `@types/node` and `globals`.

## v1.0.7

- Add GitHub CI coverage across Windows, macOS, and Linux, with a portable cross-platform test suite plus Linux-only full integration/E2E coverage.
- Harden background routing by validating `parentThreadId`, combining reserved-job and session-routing metadata into one helper, and making background review/rescue explicitly use built-in forwarding subagents rather than direct detached companion processes.
- Stop exposing managed job log paths through user/model-facing status and result surfaces while keeping on-disk logs for debugging.
- Make installed skill-path materialization consistent for both staged installs and direct local-checkout installs, and centralize installer path helpers for reuse.
- Switch sandbox temp-dir settings from a hardcoded `/tmp` path to the OS temp directory so the runtime configuration stays valid off Linux.

## v1.0.6

- Restore parent-session ownership for built-in background rescue/review runs so resume candidates, plain `$cc:status`, and no-argument `$cc:result` stay aligned after nested child sessions run.
- Distinguish the owning Codex session from the actual Claude Code session in job rendering so `claude --resume ...` points at the real Claude session instead of the parent owner marker.
- Tighten the background review and adversarial-review forwarding contracts around `send_input` notification behavior and add E2E coverage for built-in notification steering in both flows.

## v1.0.5

- Keep built-in background review jobs attached to the parent Codex session so plain `$cc:status` and `$cc:result` stay intuitive after nested rescue/review flows.
- Make `$cc:status --all` show the full job history for the current repository workspace instead of staying session-scoped.
- Harden large-diff review and hook fingerprinting so oversized `git diff` output degrades cleanly instead of failing with `ENOBUFS`.
- Clarify README guidance around review visibility, large diffs, and the difference between session-scoped status and repository-wide status.

## v1.0.4

- Make background built-in rescue/review completions steer users to `$cc:result <job-id>` instead of inlining raw child output.
- Harden reserved job-id handling by requiring real reservations, sanitizing reserved-job paths, and releasing reservations across validation and job-creation failures.
- Add regression coverage for reserved job ids, background completion steering, large diff omission, and untracked directory/symlink review context handling.
- Refresh the README to be more install-first and user-friendly for Codex users trying Claude Code for the first time.

## v1.0.3

- Refresh the README opening copy and update the bundled visual assets for launch/readme presentation.
- Add a GitHub-friendly social preview asset under `assets/social-preview.{svg,png}`.
- Add a changelog release gate so `check`, `prepack`, CI, publish, and `npm version` all fail when the current package version is missing from `CHANGELOG.md`.

## v1.0.2

- Add fallback `cc-*` skill and prompt wrappers only when Codex's official `plugin/install` path is unavailable.
- Remove stale managed fallback wrappers after official install succeeds again and during uninstall/self-cleanup.
- Clarify that marketplace-style installs which bypass the installer should run `$cc:setup` once to install hooks.
- Stabilize the concurrent polling integration assertion used in release verification.

## v1.0.1

- Install and uninstall through Codex app-server when available, with safe fallback activation on unsupported builds.
- Remove the global `cc-rescue` agent and keep only managed Codex hooks outside the plugin directory.
- Switch rescue to the built-in forwarding subagent path and harden hook self-clean behavior.
- Auto-install missing hooks during `$cc:setup`.
- Clarify background unread-result nudges and the hooks-only global state model in the README.

## v1.0.0

- Initial public release of the Claude Code plugin for Codex.
- Includes tracked review, adversarial review, rescue, status, result, cancel, and setup flows.
- Includes Codex hook integration and plugin installer automation.
