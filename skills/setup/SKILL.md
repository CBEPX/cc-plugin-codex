---
name: setup
description: 'Check whether Claude Code CLI is ready in this environment and optionally repair setup or toggle the stop-time review gate. Args: --check, --enable-review-gate, --disable-review-gate, --stop-review-advisor <inherit|off|alias-or-id>. Use for installation, authentication, or review-gate setup requests.'
---

# Claude Code Setup

Use this skill when the user wants to verify Claude Code readiness or toggle the review gate.
The review gate is a `Stop` hook: it reviews a Codex turn when that turn ends, not when the session closes (`SessionEnd` is a separate lifecycle hook).

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Keep the shell tool in the active Codex user workspace; never set its working directory to `<plugin-root>` or the directory used to read this skill. The companion uses that shell's current directory as the workspace.

Supported arguments:
- `--check` (read-only; do not combine with review-gate or advisor changes)
- `--enable-review-gate`
- `--disable-review-gate`
- `--stop-review-advisor <inherit|off|alias-or-id>` (sets the advisor policy of the stop-time review for this workspace, default `inherit`)

Workflow:
- First run the machine-readable read-only probe:
  `node "<plugin-root>/scripts/claude-companion.mjs" setup --check --json`
- `--check` is read-only: it reports config and hook-trust repairs without applying them.
- If it reports that Claude Code is unavailable and `npm` is available, ask whether to install Claude Code now.
- If the user agrees, run `npm install -g @anthropic-ai/claude-code` and rerun setup.
- If Claude Code is already installed or `npm` is unavailable, do not ask about installation.
- Unless the user explicitly requested `--check`, if the check reports a missing stable hook launcher, native plugin hook feature, or hook trust, run setup once without `--check`. The companion repairs the launcher, `[features].hooks`, and this plugin's native hook trust hashes itself.
- After the decision flow is complete, run the final user-facing command without `--json`:
  `node "<plugin-root>/scripts/claude-companion.mjs" setup $ARGUMENTS`

Output:
- Present the final non-JSON setup output exactly as returned by the companion.
- Use the JSON form only for branching logic such as install or auth decisions.
- Preserve any authentication guidance if setup reports that login is still required.

Stop-review advisor:
- Pass `--stop-review-advisor` to the companion exactly as the user wrote it. Never add it when the user did not supply it.
- `inherit` keeps the Claude Code settings. `off` turns the advisor tool off for the stop-time review only. An alias or a model ID needs Claude Code 2.1.293 or later.
- If setup reports an invalid stored advisor value or a Claude Code version below 2.1.293 for a configured alias or model ID, show that guidance unchanged. Do not repair it unless the user asks.
- If the installed Claude Code is older, the stop-time review blocks the turn and shows a message for the operator. Do not change this setting to get past that block unless the user asks.
