---
name: setup
description: 'Check whether Claude Code CLI is ready in this environment and optionally repair setup or toggle the stop-time review gate. Args: --check, --enable-review-gate, --disable-review-gate. Use for installation, authentication, or review-gate setup requests.'
---

# Claude Code Setup

Use this skill when the user wants to verify Claude Code readiness or toggle the review gate.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Keep the shell tool in the active Codex user workspace; never set its working directory to `<plugin-root>` or the directory used to read this skill. The companion uses that shell's current directory as the workspace.

Supported arguments:
- `--check` (read-only; do not combine with review-gate changes)
- `--enable-review-gate`
- `--disable-review-gate`

Workflow:
- First run the machine-readable read-only probe:
  `node "<plugin-root>/scripts/claude-companion.mjs" setup --check --json`
- `--check` is read-only: it reports config and hook-trust repairs without applying them.
- If it reports that Claude Code is unavailable and `npm` is available, ask whether to install Claude Code now.
- If the user agrees, run `npm install -g @anthropic-ai/claude-code` and rerun setup.
- If Claude Code is already installed or `npm` is unavailable, do not ask about installation.
- Unless the user explicitly requested `--check`, if the check reports missing native plugin hook features or hook trust, run setup once without `--check`. The companion repairs `[features].hooks`, `[features].plugin_hooks`, and this plugin's native hook trust hashes itself.
- After the decision flow is complete, run the final user-facing command without `--json`:
  `node "<plugin-root>/scripts/claude-companion.mjs" setup $ARGUMENTS`

Output:
- Present the final non-JSON setup output exactly as returned by the companion.
- Use the JSON form only for branching logic such as install or auth decisions.
- Preserve any authentication guidance if setup reports that login is still required.
