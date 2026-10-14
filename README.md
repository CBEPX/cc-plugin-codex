<p align="center">
  <img src="assets/cc-plugin-codex-logo.svg" height="128" alt="cc-plugin-codex" />
</p>

<h3 align="center">Claude Code Plugin for Codex</h3>

<p align="center">
  Run Claude Code reviews, rescue tasks, transfers, and tracked background work from inside Codex.
</p>

<p align="center">
  <code>cc-plugin-codex</code> runs inside Codex and lets you use Claude Code and Claude models for review, rescue, transfer, and tracked background workflows.
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick Start</strong></a> ·
  <a href="#commands"><strong>Commands</strong></a> ·
  <a href="#peer-design-and-research"><strong>Peer Workflows</strong></a> ·
  <a href="#background-jobs"><strong>Background Jobs</strong></a> ·
  <a href="#review-gate"><strong>Review Gate</strong></a> ·
  <a href="#how-this-differs-from-upstream"><strong>vs Upstream</strong></a> ·
  <a href="https://github.com/CBEPX/cc-plugin-codex/issues"><strong>Issues</strong></a>
</p>

---

## What Is This?

`cc-plugin-codex` turns Codex into a host for Claude Code work.
**Codex stays in charge of the thread. Claude Code does the review and rescue work.**

You get eleven commands, including `$cc:design` and `$cc:research`, that launch tracked Claude Code work, compare independent Codex and Claude evidence, transfer transcripts, manage lifecycle and ownership, and surface results back into Codex.

That includes:
- Built-in Codex subagent orchestration for rescue and background review flows
- Session-scoped tracked jobs with status, result, and cancel commands
- Durable peer design/research workflows with independent evidence, failed-only retry, and cross-session continuation
- Background completion nudges that steer you to the right `$cc:result <job-id>`
- An optional stop-time review gate
- GitHub CI coverage on Windows, macOS, and Linux

It follows the shape of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) but runs in the opposite direction.

## Quick Start

### 1. Install

Install the fork release from the CBEPX marketplace snapshot:

```bash
codex plugin marketplace add CBEPX/cc-plugin-codex --ref v1.7.12
codex plugin add cc@cbepx
```

Then run `$cc:setup` once inside Codex.

`cc-plugin-codex` uses Codex native plugin hooks. Hook commands enter through a small launcher under `$PLUGIN_DATA`; it resolves the current valid version from Codex's plugin cache, so an already-running session does not keep executing a deleted cache path.

The optional `npx` helper can install this fork release and enable the required Codex feature gates:

```bash
CC_PLUGIN_CODEX_MARKETPLACE_NAME=cbepx \
CC_PLUGIN_CODEX_MARKETPLACE_SOURCE=CBEPX/cc-plugin-codex \
CC_PLUGIN_CODEX_MARKETPLACE_REF=v1.7.12 \
npx -y https://github.com/CBEPX/cc-plugin-codex/releases/download/v1.7.12/cc-plugin-codex-1.7.12.tgz install
```

On Windows, prefer the marketplace path or the `npx` helper. The shell-script helper below is POSIX-only.
Codex CLI's official guidance still treats Windows support as experimental and recommends a WSL workspace for the best Codex experience. Claude Code supports both native Windows and WSL.

If install/update/uninstall reports an invalid global `hooks.json` while a legacy cc install is present, repair that JSON before retrying. To continue without touching risky legacy hook files, set `CC_PLUGIN_CODEX_SKIP_LEGACY_CLEANUP=1`; uninstall still removes official plugin config/cache state but deliberately leaves the legacy files for manual repair. An explicit Codex RPC permission/auth refusal remains fail-closed; use `CC_PLUGIN_CODEX_IGNORE_UNINSTALL_RPC=1` only when you intentionally want local uninstall cleanup despite that refusal.

> **Prerequisites:** Node.js 18+, Codex with hook support, and `claude` CLI installed and authenticated.
> If you don't have the Claude CLI yet:
> ```bash
> npm install -g @anthropic-ai/claude-code && claude auth login
> ```

### 2. Verify

Open Codex and run:

```text
$cc:setup
```

All checks should pass. If any fail, `$cc:setup` tells you what to fix.

### 3. Try It

```text
$cc:review --background
```

That launches a Claude Code review from a Codex-managed background flow. You can check on it immediately:

```text
$cc:status
$cc:result
```

When it finishes, Codex should nudge you toward the right result. If not, `$cc:status` and `$cc:result` are always the fallback.

## Commands

| Command | What It Does |
| --- | --- |
| `$cc:review` | Read-only Claude Code review of your changes |
| `$cc:adversarial-review` | Design-challenging review — questions approach, tradeoffs, hidden assumptions |
| `$cc:rescue` | Hand a task to Claude Code — bugs, fixes, investigations, follow-ups |
| `$cc:design` | Compare technical alternatives with independent Codex and Claude evidence |
| `$cc:research` | Investigate a repository question with independent Codex and Claude evidence |
| `$cc:transfer` | Import the current Claude transcript into a resumable Codex thread |
| `$cc:status` | List jobs and aggregate peer workflows, or inspect one ID |
| `$cc:result` | Open a job result or peer checkpoint/final result |
| `$cc:cancel` | Cancel an active job or peer workflow |
| `$cc:mcp-diagnose` | Explain which Claude MCP tools would be available to reviews |
| `$cc:setup` | Verify installation, auth, hooks, and review gate |

Quick routing rule:
- Use `$cc:review` for straightforward correctness review of the current diff.
- Use `$cc:adversarial-review` for riskier config/template/migration/design changes, or whenever you want stronger challenge on assumptions and tradeoffs.
- Use `$cc:rescue` when you want Claude Code to investigate, validate by changing code, or actually fix/implement something.
- Use `$cc:design` or `$cc:research` when the decision benefits from two independent read-only evidence paths before synthesis.

### `$cc:review`

Standard read-only review of your current work.

```text
$cc:review                          # review uncommitted changes (default: opus + xhigh effort)
$cc:review --base main              # review branch vs main
$cc:review --scope branch           # explicitly compare branch tip to base
$cc:review --background             # run in background, check with $cc:status later
$cc:review --model sonnet           # switch to sonnet (defaults to high effort)
$cc:review --model fable --effort xhigh  # use Fable explicitly for hardest reviews
$cc:review --model opus --effort high   # opus with a lighter effort
$cc:review --user-mcp-tool mcp__context7__resolve-library-id
```

**Flags:** `--base <ref>`, `--scope <auto|working-tree|branch>`, `--wait`, `--background`, `--model <model>`, `--effort <low|medium|high|xhigh|max>`, `--advisor <inherit|off|alias-or-id>`, `--user-mcp-tool <mcp__server__tool>`, `--allow-project-mcp-servers`

**Defaults:** model `opus` is passed to Claude Code as its native alias with `xhigh` effort. `sonnet` is passed through with `high` effort; `haiku` and `fable` have no implicit effort. Explicit Fable effort, including `medium`, is forwarded unchanged. Claude Code resolves aliases to the current model for the active provider and account (for example, Opus 5). Pass a full model ID to pin a version; for older pinned IDs, pass `--effort` explicitly instead of inheriting a current-family default.

Fable 5.1 (`claude-fable-5-1`) has a native 1M context window and requires Claude Code 2.1.257 or newer. The bare `fable` alias remains floating and may still resolve to Fable 5 behind Claude Apps Gateway; use the full model ID when Fable 5.1 is required. No `[1m]` suffix or hidden Fable effort default is added. See Claude Code's [model configuration](https://code.claude.com/docs/en/model-config).

JSON task and review results keep `requestedModel` as the forwarded alias or full ID, report `finalModel` from Claude's terminal result, and expose the terminal `contextWindow` reported in `modelUsage` (`null` when Claude does not provide it). The plugin does not infer a context limit from a floating alias.

`requestedEffort` records the normalized effort actually forwarded to Claude Code, including plugin defaults; `null` means no effort was forwarded. Historical results may omit it. Peer memo and critique model metadata expose the same field. This is a request value, not a claim about the provider's effective effort after fallback.

For model qualification, compare `--model claude-opus-5-5 --effort medium` against `high` and `xhigh`, and `--model claude-fable-5-1 --effort high` against `xhigh` on identical tasks. Defaults remain unchanged until local quality and latency measurements justify a change. See Anthropic's [Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) and [Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1) prompting guides.

Scope `auto` (the default) inspects `git status` and chooses between working-tree and branch automatically.

In foreground, review returns the result directly. In background, the plugin uses a Codex built-in subagent, tracks the review as a job, and nudges you to open the result when it completes.

If the diff is too large to inline safely, the review prompt falls back to concise status/stat context and tells Claude to inspect the diff directly with the read-only `mcp__gitReview__diff` tool instead of failing the run.

By default, review runs with only the bundled read-only git MCP. Repeat `--user-mcp-tool <mcp__server__tool>` to opt in specific Claude MCP tools from your user-scope Claude config for a run. Opted-in user MCP tools run as external Claude MCP processes and are auto-approved for that review, so use only trusted tools when reviewing untrusted diffs. Eligibility is based on the server's `readOnlyHint` declaration or the immutable four-ID audited annotationless registry: Context7 `mcp__context7__query-docs` and `mcp__context7__resolve-library-id`, plus Brave `mcp__brave-search__brave_web_search` and `mcp__brave-search__brave_llm_context`. It is not an OS-enforced sandbox. A `destructiveHint` declaration is always vetoed. Project `.mcp.json` server definitions are ignored unless you also pass `--allow-project-mcp-servers`.

#### Advisor policy

Claude Code can call a stronger advisor model during a turn. The plugin does not change this by default. Use `--advisor` on `$cc:review`, `$cc:adversarial-review`, `$cc:rescue`, `$cc:design`, and `$cc:research` to set the policy for one run.

| Value | Effect |
| --- | --- |
| omitted or `inherit` | The plugin adds nothing. Claude Code uses your own settings. A `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` value in your environment stays in effect. |
| `off` | The plugin sets `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` in the Claude Code child process only. Your shell and your settings do not change. |
| alias or model ID, for example `fable` | The plugin passes `--advisor <value>` to Claude Code. This needs a stable Claude Code CLI 2.1.293 or later. |

The plugin refuses an invalid value, an older CLI, and an unverifiable version before any model turn. It does not retry without the advisor. It does not read `claude --help`, because Claude Code hides this flag. The plugin never unsets a global disable, so an explicit model does not override your `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` setting. The plugin does not check which primary and advisor models work together. Claude Code reports an unsupported pair.

This setting records the request only. Task and review JSON, `status`, `result`, peer model metadata, and the Stop snapshot can also contain an `advisor` object. This object reports what the native stream showed for the primary turn:

- `requested` is the plugin policy: `inherit`, `off`, or the model value. It is not an observation.
- `calls` is the number of distinct advisor call IDs. Calls from subagents do not count. A result block is not a call.
- `countExact` is `false` when a call has no valid ID or the plugin already stores 256 IDs. Then `calls` is a lower bound.
- `status` is `observed`, `not_observed`, or `incomplete`. Zero calls means that the stream showed no call. It does not show that the advisor was disabled.
- `observedModel` is always `null`. The stream does not identify the advisor model, so the plugin does not infer it from the request, your settings, or the primary model.
- `diagnostics` contains the codes `CALL_ID_MISSING` and `CALL_ID_LIMIT` when they apply.

Rendered output and `status` omit the object when the policy is `inherit` and the stream showed no call. The full result payload keeps it.

The plugin keeps only call IDs during the turn. It does not store the advisor input, the advice, or the encrypted content. A stream line that is not valid JSON adds `{ "code": "INVALID_JSON", "length": <n> }` to `parseErrors`, without the line text. The plugin does not estimate advisor usage or cost. Records from earlier versions have no `advisor` object and stay readable.

`$cc:rescue --resume` keeps the policy of the original task when you omit `--advisor`. The same version check applies. `--advisor inherit` resets the policy. A fresh task never takes the policy of an earlier task. `$cc:design` and `$cc:research` freeze the policy in the workflow when they start. The memo, the critique, and every retry use it, and `--continue` and `--retry` reject `--advisor`. For the stop-time review gate, use `$cc:setup --stop-review-advisor`.

### `$cc:mcp-diagnose`

Shows which Claude MCP servers the plugin can see for review commands, which requested tools would be allowed, and why a tool is missing.

```text
$cc:mcp-diagnose --user-mcp-tool mcp__context7__resolve-library-id
$cc:mcp-diagnose --allow-project-mcp-servers --user-mcp-tool mcp__localdocs__search
```

The diagnostic actively starts/probes servers (or sends HTTP initialize and tool-list requests), with a five-second absolute deadline per server. With `--user-mcp-tool` pins it probes only the servers those pins name; with `--no-auto-tools` and no pins it probes none; without either it probes every configured server in scope. Treat that discovery as potentially side-effecting. The output lists server names and config sources only; it does not print raw MCP server configs or secrets. Once a peer workflow freezes its selected manifest, later turn revalidation probes only those selected servers.

### Peer design and research

`$cc:design` and `$cc:research` start a durable read-only workflow with exactly two independent branches: one Codex reasoning worker and one Claude forwarder. The initial branches receive the same frozen brief and cannot read each other's memo before sealing their own evidence.

```text
$cc:design compare the queue ownership alternatives
$cc:research trace how cancellation state reaches the public CLI
$cc:status <workflow-id>
$cc:result <workflow-id>
$cc:design --continue <workflow-id> optional feedback
$cc:design --retry <workflow-id>
```

New workflows default to Claude `fable` with `opus` fallback and inherited Codex model at `xhigh` effort. Use `--model`, `--fallback-model`, `--effort`, `--advisor`, `--codex-model`, or `--codex-effort` to override them. Repeat `--user-mcp-tool <mcp__server__tool>` for explicitly trusted eligible tools; automatic selection is limited to the smallest relevant eligible set exposed to the active Codex turn. Eligibility records whether trust came from `readOnlyHint` or the audited registry, but does not independently enforce server behavior. Project MCP servers still require `--allow-project-mcp-servers`.

Only the two Brave IDs in that four-ID registry — `mcp__brave-search__brave_web_search` and `mcp__brave-search__brave_llm_context` — are Brave web-evidence tools; other Brave IDs are not eligible through the registry. A Brave event counts as Claude web evidence only when that exact ID is also in the workflow's frozen selected-tool manifest. The manifest records the selected ID and trust basis, not the provider's behavior: an `@latest` Brave server can still change a tool behind the same ID. Pin a server version when that drift is unacceptable.

Selected Brave MCP servers are external trusted processes/services, not an OS sandbox. Their query or context input can disclose the brief and research terms to the provider; do not send secrets or sensitive material through either tool. The workflow never persists raw MCP configuration or credentials, but that does not remove this upstream disclosure risk.

The stored and rendered workflow shows independent branch states, requested/final models and fallback events, source/tool evidence counts, selected public tool IDs and reasons, checkpoint or final result, and the exact continue/retry command. Raw MCP configuration, environment variables, headers, and credentials are never persisted or rendered. Claude receives no Bash, write, or Agent capability, and only selected MCP servers enter its strict runtime config. Peer turns also require the platform filesystem sandbox, deny unsandboxed commands and reads of canonical Codex/Claude state, persist no Claude transcript, and expose only content-free phase/tool/model-fallback progress before reveal. Native Windows peer execution is unsupported and isolation failures stop with `PEER_ISOLATION_UNAVAILABLE`.

Attempt leases are single-use secrets sent through stdin, while durable state keeps only their digests. A Claude-first memo remains process-local until Codex seals its independent memo. That wait has one absolute 30-minute deadline; retry keeps a committed waiter only while its current linked job is alive, rotates only unfinished reservations, and never rewrites completed payloads. A lost, terminal, or reaped worker becomes retryable, while unresolved process cancellation stays terminal as `cancel_failed`.

At the checkpoint, inspect the aggregate result and either continue with feedback or retry only failed/missing work. Continuation may run from a new Codex session: ownership is rebound explicitly, and critique starts a fresh ephemeral Claude turn from the frozen brief, memos, and feedback. SessionEnd marks unfinished work retryable after identity-checked linked-process cleanup; unresolved cancellation remains `cancel_failed`.

### `$cc:adversarial-review`

Same as `$cc:review`, but steers Claude to challenge the implementation — tradeoffs, alternative approaches, hidden assumptions.

```text
$cc:adversarial-review
$cc:adversarial-review --background question the retry and rollback strategy
$cc:adversarial-review --base main challenge the caching design
$cc:adversarial-review --user-mcp-tool mcp__context7__resolve-library-id focus on API parity
```

Accepts the same flags as `$cc:review`, plus free-text focus after flags to steer the review.

Background adversarial review uses the same tracked built-in subagent pattern as `$cc:review`.

### `$cc:rescue`

Hand a task to Claude Code. This is the main way to delegate real work — bug fixes, investigations, refactors.

```text
$cc:rescue investigate why the tests started failing
$cc:rescue fix the failing test with the smallest safe patch
$cc:rescue --resume apply the top fix from the last run
$cc:rescue --background investigate the regression
$cc:rescue --model sonnet --effort medium investigate the flaky test
```

**Flags:**

| Flag | Description |
| --- | --- |
| `--background` | Run in background; check later with `$cc:status` |
| `--wait` | Run in foreground |
| `--resume` | Continue the most recent Claude Code task |
| `--resume-last` | Alias for `--resume` |
| `--fresh` | Force a new task (don't resume) |
| `--write` | Allow file edits (default) |
| `--model <model>` | Claude model (`opus`, `sonnet`, `haiku`, `fable`, or full ID; defaults to `opus`). Aliases are resolved by Claude Code; a full ID pins a version. |
| `--effort <level>` | Reasoning effort: `low`, `medium`, `high`, `xhigh`, `max` (default: `xhigh` for opus, `high` for sonnet, unset for haiku and fable; explicit Fable effort such as `medium` is supported) |
| `--advisor <policy>` | Advisor policy for this task: `inherit`, `off`, or a model alias or ID (default: `inherit`). See [Advisor policy](#advisor-policy). Omit it on `--resume` to keep the original policy. |
| `--prompt-file <path>` | Read task description from a file |
| `--view-state on-terminal` | Mark the foreground terminal outcome as viewed |
| `--view-state defer` | Leave the terminal outcome unread for later inspection |
| `--wait-timeout-ms <ms>` | Foreground observer timeout before returning a retrievable job |
| `--timeout-ms <ms>` | Deprecated alias for `--wait-timeout-ms` |

**Resume behavior:** If you don't pass `--resume` or `--fresh`, rescue checks for a resumable Claude session and asks once whether to continue or start fresh. Your phrasing guides the recommendation — "continue the last run" → resume, "start over" → fresh.

Background rescue runs through a built-in Codex subagent. When the child finishes, the plugin tries to nudge the parent thread with the exact `$cc:result <job-id>` to open.

The forwarding subagent inherits the current Codex runtime model at `medium` effort. This avoids stale model pins, but it can cost more than the former mini-model forwarder.

### `$cc:transfer`

Transfer the current Claude transcript into a persistent Codex thread and print a resume command.

```text
$cc:transfer
$cc:transfer --source ~/.claude/projects/-Users-me-repo/session.jsonl
```

The SessionStart hook normally supplies the current transcript path automatically. `--source` is available as a manual override. Codex can import only Claude session JSONL files under `~/.claude/projects`, and the command requires a Codex version with native external-agent session import support.

### `$cc:status`

```text
$cc:status                          # list jobs and aggregate peer workflows
$cc:status task-abc123              # detailed status for one job or workflow
$cc:status --all                    # include all workspace jobs, including workflow-linked jobs
$cc:status --wait task-abc123       # block until the job/workflow stops running
```

By default, `$cc:status` shows current-session jobs plus one aggregate row per owned peer workflow; workflow-linked implementation jobs are hidden. Use `--all` for the wider repository view and linked-job diagnostics.

### `$cc:result`

```text
$cc:result                          # open the latest job or workflow result for this session
$cc:result task-abc123              # show job output or a workflow checkpoint/final result
$cc:result task-abc123 --output /tmp/new-result.json  # full private JSON export
```

When a job came from a built-in background child, the output can show both:
- the **Claude Code session** you can resume with `claude --resume ...`
- the **Owning Codex session** that owns the tracked job inside Codex

To reopen the Claude Code session directly:

```bash
claude --resume <session-id>
```

### `$cc:cancel`

```text
$cc:cancel task-abc123              # cancel a running job or peer workflow
```

Workflow cancellation targets only its linked work. A missing or unverifiable process identity remains visible as `cancel_failed`; the plugin does not turn that state into a successful cancellation.

On macOS, new jobs use process birth times to preserve identity across launcher `exec` transitions. The plugin reads these through the built-in `osascript` command. If a legacy record has the same start time but a different process name, cancellation preserves its handles and reports `cancel_failed`.

### `$cc:setup`

```text
$cc:setup                           # verify everything
$cc:setup --check                   # read-only readiness check
$cc:setup --enable-review-gate      # turn on stop-time review gate
$cc:setup --disable-review-gate     # turn it off
$cc:setup --stop-review-advisor fable  # advisor policy of the stop-time review: inherit, off, or alias/ID
```

Setup checks Claude Code availability, native plugin hook feature gates, review-gate state, and the stop-review advisor policy. `--check` reports required repairs without changing config or hook trust. `--check` rejects `--stop-review-advisor` before it makes any change. Setup reports an invalid stored advisor value instead of treating it as `inherit`, and it explains the Claude Code 2.1.293 prerequisite when the configured value is an alias or model ID and the installed CLI is older or unverifiable. The write still succeeds, because you can update Claude Code later. Run `$cc:setup --stop-review-advisor inherit` to repair a malformed value. If Claude Code isn't installed, setup offers to install it.
This is also the repair path for marketplace-installed copies of the plugin: `$cc:setup` installs or refreshes the stable hook launcher, confirms `[features].hooks = true`, then trusts this plugin's current native hook hashes.

## Background Jobs

All review and rescue commands support `--background`. Background jobs are tracked per-session with full lifecycle management:

1. **Queued → Running → Completed** — jobs progress through states automatically.
2. **Built-in subagent background flows** — background rescue, review, and adversarial review use Codex-managed subagent turns rather than stuffing `--background` into the companion command itself.
3. **Completion nudges** — when a background built-in flow finishes, the plugin tries to nudge the parent thread with the right `$cc:result <job-id>`. Peer workflows notify only at an aggregate checkpoint, incomplete state, or final completion; linked jobs never produce duplicate nudges. If a nudge cannot surface cleanly, unread-result hooks are the backstop.
   The nudge is intentionally just a pointer. The actual stored result still opens through `$cc:result`.
4. **Unread-result fallback** — when you submit your next prompt after a finished unread job, Codex can remind you that a result is waiting and point you to `$cc:status` / `$cc:result`.
5. **Session ownership** — jobs stay attached to the user-facing parent Codex session even when a built-in rescue/review child does the actual work, so plain `$cc:status`, `$cc:result`, and resume-candidate detection still follow the parent thread.
6. **Cleanup on exit** — when your Codex session ends, any still-running detached jobs are terminated via PID identity validation, and stale reserved job markers are cleaned up over time. Cleanup uses only the session id from the `SessionEnd` hook input or `CLAUDE_COMPANION_SESSION_ID`, never the workspace marker.

The owning session is resolved from `--owner-session-id`, then `CLAUDE_COMPANION_SESSION_ID`, then Codex's `CODEX_THREAD_ID`, then the workspace's `current-session.json` marker, which is used only while its `updatedAt` is less than 24 hours old. Reads and same-owner delegation never refresh that marker's age. New `task`, `review`, `adversarial-review`, and peer runs require an owner and fail with `SESSION_OWNER_REQUIRED` before contacting Claude Code, creating jobs, or reserving job ids. If you run the companion's `task` or `review` directly outside a Codex session, pass `--owner-session-id <session-id>` or set `CLAUDE_COMPANION_SESSION_ID`. Without an owner, plain `$cc:status` shows an empty, explained scope; `$cc:result` and `$cc:cancel` need an explicit id; `$cc:status --all` still lists every workspace job.

Request validation and the Claude Code loop guard still take precedence over missing-owner errors. If marker alignment cannot acquire its lock, delegation fails and releases an accepted reservation. `status --all` skips owner lookup, including invalid owner values.

Public `status`, `result`, `workflow-read`, `workflow-list` and `peer-wait` output is capped at 8192 UTF-8 bytes, including JSON. JSON reports `truncated` and omissions; workflow lists wrap rows as `{workflows,total,truncated,omissions}`. Status/list/poll omit memo and result bodies. Use `--output <new-path>` for full public JSON (workflow-list exports an array): a new mode-0600 file is created exclusively and the receipt includes `outputFile`, `bytes` and `sha256`. Existing files and symlinks are refused. Read large exports in sections and remove temporary exports when finished.

Job inspection can also reconcile stale `queued`, `running`, or `cancelling` records. It only terminates an orphaned owned process after its recorded PID identity matches; healthy active jobs are left unchanged. Successfully delivered complete `$cc:result` output or a full public JSON export may additionally record that a terminal result was viewed; status summaries and truncated previews leave notifications unread.

**Typical background flow:**

```text
$cc:rescue --background investigate the performance regression
# ... keep working ...
# Codex nudges with the exact result command when possible
$cc:result task-abc123
```

### What “background” means here

- The parent Codex thread does not wait.
- The Claude companion command still runs in the foreground inside its own worker/subagent thread.
- For rescue and background review flows, the plugin prefers Codex built-in subagents and only uses job polling/status commands as the durable backstop.

## Review Gate

The review gate is an **optional** `Stop` hook. In Codex, `Stop` fires when an assistant turn ends, not when you close the session (that is the separate `SessionEnd` lifecycle hook). When enabled, each Codex turn that ends after making edits triggers a Claude Code review of that response before the turn is allowed to end.

- Claude returns `ALLOW:` → the turn ends normally.
- Claude returns `BLOCK:` → the turn end is rejected and Codex keeps working on the reported issues.

Long inline `BLOCK` reasons keep a prefix of 1500 Unicode code points (including any running-task note), followed by `…` and a reference to the full `stop-review-last.json` snapshot, which always keeps the complete reason, raw Claude output, stderr, and running-task note; `stop-review-history.jsonl` keeps recent full records.

The snapshot is shared by sessions in the same workspace and is replaced by the next review. If it has changed, find the completed review in the adjacent `stop-review-history.jsonl` using its session and run IDs.

**Caveats:**

- **Disabled by default.** Enable with `$cc:setup --enable-review-gate`.
- **Token cost.** Every reviewed turn end triggers a Claude invocation. This can drain usage limits quickly in long edit-heavy sessions.
- **15-minute timeout.** The gate has a hard timeout. If Claude doesn't respond, the turn is allowed to end.
- **Skip-on-no-edits.** The gate computes a working-tree fingerprint baseline and skips review when the last Codex turn made no net edits.
- **Requires a recorded user turn.** If the UserPromptSubmit hook did not record a baseline for this session, the gate skips review instead of reviewing unrelated or headless work.
- **Requires an owning session.** If no session id resolves, the gate records `skipped_missing_owner_session` without listing jobs or invoking Claude.
- **Advisor policy.** The default is `inherit`. `$cc:setup --stop-review-advisor <inherit|off|alias-or-id>` sets `stopReviewAdvisor` for the workspace. If the installed Claude Code is too old for the configured model, the gate blocks the turn and shows a message for the operator. The Stop snapshot records `claudeInvoked: false`. The gate does not retry without the advisor. The snapshot and the history keep the `advisor` object of each completed review.
- **Snapshot write failure after spawn.** If the gate cannot write the running snapshot after Claude Code starts, it logs the error and continues. The final snapshot records `claudeInvoked: true`. A failure of the final write still stops the hook with an error.
- **Not in nested sessions.** Child sessions (e.g., rescue subagents) suppress the gate to avoid feedback loops.

**Only enable when you're actively monitoring the session.**

## How This Differs From Upstream

| | [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) | This repository |
| --- | --- | --- |
| **Host** | Claude Code hosts the plugin | Codex hosts the plugin |
| **Commands** | `/codex:review`, `/codex:rescue`, … | `$cc:review`, `$cc:rescue`, … |
| **Runtime** | Codex app-server + broker | Fresh `claude -p` subprocess per invocation |
| **Review gate** | Reviews previous Claude response | Reviews previous Codex response |
| **Model flags** | Codex model names and effort controls | Claude model names and effort values (`low` / `medium` / `high` / `max`) |

### Where This Goes Further

- **Smart review gate** — fingerprints the working tree and skips review when the last Codex turn made no net edits, avoiding unnecessary token spend.
- **Nested-session awareness** — suppresses stop-time review and unread-result prompts in child runs, keeping interactive hooks attached to the user-facing thread only.
- **Tracked job ownership** — background jobs track unread/viewed state and session ownership, with safe PID-validated cleanup on session exit.
- **Built-in background notify** — rescue and review flows can now wake the parent thread and point directly to `$cc:result <job-id>` instead of relying only on later polling.
- **Unread-result nudges** — completed background jobs are still surfaced in your next prompt as a reliable fallback.
- **Idempotent installer** — installs through Codex's marketplace/cache path and enables native hook feature gates. Safe to re-run for updates.

## Install Variants

### CBEPX fork marketplace (preferred for this fork)

Install from the fork's marketplace snapshot:

```bash
codex plugin marketplace add CBEPX/cc-plugin-codex --ref v1.7.12
codex plugin add cc@cbepx
```

Then run:

```text
$cc:setup
```

Marketplace/plugin install places the plugin under Codex's plugin cache. `$cc:setup` verifies Claude Code, installs or refreshes the stable hook launcher, confirms `[features].hooks = true`, and trusts the current `hooks/hooks.json` hook hashes.

### Upstream Sendbird build

This fork does not install from the upstream Sendbird marketplace. Use the CBEPX marketplace commands above when you want this fork.

### npx helper

```bash
CC_PLUGIN_CODEX_MARKETPLACE_NAME=cbepx \
CC_PLUGIN_CODEX_MARKETPLACE_SOURCE=CBEPX/cc-plugin-codex \
CC_PLUGIN_CODEX_MARKETPLACE_REF=v1.7.12 \
npx -y https://github.com/CBEPX/cc-plugin-codex/releases/download/v1.7.12/cc-plugin-codex-1.7.12.tgz install
```

After install, run:

```text
$cc:setup
```

The helper adds the configured marketplace, installs `cc` through Codex app-server, enables native hook feature gates, and removes stale global hook entries from older installs.

### Shell script (POSIX-only)

Install the fork from the current `CBEPX/cc-plugin-codex` `main` branch:

```bash
curl -fsSL "https://raw.githubusercontent.com/CBEPX/cc-plugin-codex/main/scripts/install.sh" | bash
```

After install, run:

```text
$cc:setup
```

### Update

Before an upgrade or rollback across v1.7.7, finish active cc jobs and resolve any `cancel_failed` jobs. Older versions cannot interpret the new macOS identity format safely.

Codex rejects re-adding an existing marketplace name when the pinned source/ref changes. Replace the existing marketplace and plugin, then install the exact release ref:

```bash
codex plugin remove cc@cbepx
codex plugin marketplace remove cbepx
codex plugin marketplace add CBEPX/cc-plugin-codex --ref v1.7.12
codex plugin add cc@cbepx
```

Restart Codex so the newly installed plugin is loaded, then run `$cc:setup` and `$cc:setup --check`. The latter is the existing read-only doctor-equivalent; there is no `$cc:doctor` command.

### Maintainer release qualification (#27)

This is an opt-in, credential-gated manual check against the selected exact tag and artifact. It is separate from hermetic CI. Record each result without printing secrets:

- [ ] Record the exact tag, commit, artifact basename, byte size, and SHA-256; confirm the installed marketplace/plugin ref and cache metadata match.
- [ ] Restart Codex, run `$cc:setup`, then run `$cc:setup --check`; record the read-only readiness result and confirm no `$cc:doctor` command is required.
- [ ] With authenticated Claude and the approved model setup, run real `$cc:design`, `$cc:research`, and critique/continuation flows; verify each returns its mode-specific structured schema, non-empty content, and required repository evidence.
- [ ] Exercise both exact Brave tools, `mcp__brave-search__brave_web_search` and `mcp__brave-search__brave_llm_context`; verify direct `https://` citations and that each event is present in the frozen selected-tool manifest.
- [ ] Verify negative evidence: an unselected Brave tool and a lookalike/non-registry Brave ID do not count as web evidence.
- [ ] Record requested/final model, context window, fallback events, and failure metadata; verify fallback and incomplete outcomes remain bounded and truthful.
- [ ] Confirm the repository worktree and touched-files snapshot are unchanged, no active jobs remain, and the exact result is retrievable without cleanup side effects.
- [ ] Review rendered output and logs for redaction: no credentials, raw leases, raw MCP configuration, headers, prompts, queries marked sensitive, or unrestricted provider output.

Do not treat CI as proof of these live provider, model, citation, or credential-dependent gates. Store only redacted evidence and keep live qualification approval separate from source, CI, and artifact readiness.

#### Native peer evidence gate

Use `scripts/qualify-peer-live.mjs` during manual peer qualification. The script requires `--live` and never starts a model or changes runtime settings.

Capture the baseline after `peer-create` reserves a workflow, before either memo worker starts. Use a disposable linked worktree. Use new output paths outside that worktree. Replace the sample paths, tag, and workflow ID with actual values:

```bash
node scripts/qualify-peer-live.mjs --live capture \
  --workspace /absolute/disposable-worktree \
  --runtime-root /absolute/installed-plugin \
  --source-repo /absolute/pinned-source \
  --revision v1.7.12 --mode installed \
  --workflow-id workflow-ID \
  --output /absolute/evidence/baseline.json
```

Complete the memo, critique, and synthesis stages through the peer runtime. Then check the result:

```bash
node scripts/qualify-peer-live.mjs --live verify \
  --baseline /absolute/evidence/baseline.json \
  --output /absolute/evidence/report.json
```

Installed mode compares file bytes and the entry set under the shipped paths against an exact local Git tag. Extra files, directories, and symlinks under those paths fail the check. To check candidate source, use `--mode candidate` with a full 40-character commit ID. Neither mode binds a workflow to the checked runtime or proves artifact publication, installation activation, or a client restart. The release checklist above still applies.

The gate checks pinned Draft-07 schemas, frozen manifests, memo citations, native model metadata, and both exact Brave calls in the Claude memo. Use a full Claude model ID. Aliases do not pass qualification. The memo and critique must report that exact model without fallback. The gate checks critique content and allowed tools through the existing peer contract. A candidate's memo and critique must report the frozen advisor policy with an exact, consistent count. An incomplete observation or an `off` policy with observed calls fails. Zero advisor calls mean `not_observed`. The supported stream does not identify the advisor model, so `observedModel` must remain `null`. A requested Fable model is not proof of its invocation.

The workspace inventory includes ignored files, modes, empty directories, and symlink targets. The inventory does not follow symlinks or cover Git metadata outside the linked worktree. The report records `workspaceEntriesUnchanged` and excludes memo text and advisor payload. Both memos and the critique must complete on their first attempt. Failed or incomplete workflows, failed branch attempt history, memo or critique retries, and model fallbacks do not pass this gate.

### Uninstall

```bash
codex plugin remove cc@cbepx
```

## Troubleshooting

**`$cc:setup` reports Claude Code not found**
```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

**Commands not recognized in Codex**
Re-run install and restart Codex. This plugin expects Codex plugin support and no longer installs local skill-wrapper fallbacks.

**Hooks not firing**
Check that `hooks = true` is set in `~/.codex/config.toml` under `[features]`. Run `$cc:setup` to verify and auto-repair the stable launcher, feature gate, and this plugin's hook trust hashes, then restart Codex if the flag was just changed.

**A background job finished but I did not get the result nudge**
Use:
```text
$cc:status
$cc:result
```
The built-in notify path is best-effort. The tracked job store and unread hook remain the reliable fallback.

If you think the job may belong to an older session in the same repository, use:
```text
$cc:status --all
```

If a finished result shows both a **Claude Code session** and an **Owning Codex session**, use the Claude Code session for `claude --resume ...`. The owning session is there only to explain which Codex thread owns the tracked job.

**Large review diff caused a failure or was omitted**
That is expected on very large diffs. The plugin now degrades to a compact review context and points Claude toward the read-only `mcp__gitReview__diff` tool instead of trying to inline everything. If you want the full picture, run a narrower review such as:
```text
$cc:review --base main
$cc:review --scope working-tree
```

**Review gate draining tokens**
Disable it: `$cc:setup --disable-review-gate`. The gate fires at the end of every edit-producing Codex turn, which adds up.

**Background jobs not cleaned up**
Jobs are terminated when the Codex session that owns them exits. If a session crashes without cleanup, use `$cc:status` and `$cc:cancel <job-id>` to clean up any leftovers.

## Development

Run the normal project gate before publishing or opening a PR:

```bash
npm run check
npm run test:coverage
```

`npm run check` requires a working `codex` executable for its real E2E suite. Constrained local environments may opt out explicitly with `CC_PLUGIN_ALLOW_E2E_SKIP=1 npm run check`; CI never uses that opt-out.
Coverage stays a separate instrumented run because `npm run check` already executes the full unit, integration, and Codex E2E suites. CI fails below 89% lines/statements, 79% branches, or 96% functions.

Mutation testing enforces the same pull-request profile used in CI:

```bash
npm run test:mutation:dry-run
npm run test:mutation
npm run test:mutation:force
```

`test:mutation` checks the critical parser contracts plus managed cleanup and installer orchestration. `test:mutation:force` runs all eight shards, matching the weekly/manual workflow. Scores below each configured break threshold fail the command, and reports are written under `reports/mutation/`. Use the force variant after changing only tests because command-runner incremental mode cannot reliably detect that. Do not mass-disable surviving mutants; improve the focused tests or use a `// Stryker disable ...: reason` comment only for an intentional equivalent mutant.

Mutation testing requires Node.js 20+ because Stryker 9 has a newer development-time engine requirement. The plugin runtime still supports the Node.js version listed in the prerequisites.

### Planned follow-ups

- Reduce surviving mutants and timeout-only kills in the `claude-cli` and state shards by classifying equivalent mutants and replacing timeout-only detection with deterministic assertions where practical.
- Treat mandatory `contextWindow` persistence across JSON payloads as a separate versioned telemetry-contract change, with explicit nullability, backward compatibility, payload coverage, tests, and an appropriate semver release.

## License

[Apache-2.0](LICENSE) — see [NOTICE](NOTICE) for attribution.
