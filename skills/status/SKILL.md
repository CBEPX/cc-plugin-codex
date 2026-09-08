---
name: status
description: 'Show active or recent Claude Code jobs and peer workflows, or detailed status for one id, with optional waiting and repository-wide listing.'
---

# Claude Code Status

Use this skill when the user wants the current state of Claude Code jobs in this repository.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Keep the shell tool in the active Codex user workspace; never set its working directory to `<plugin-root>` or the directory used to read this skill. Always run:
`node "<plugin-root>/scripts/claude-companion.mjs" status $ARGUMENTS`

Supported arguments: `[job-id]`, `--wait`, `--wait-timeout-ms <ms>`, deprecated alias `--timeout-ms <ms>`, `--poll-interval-ms <ms>`, `--all`, `--json`, `--output <new-path>`

Output:
- Present the companion stdout exactly as returned.
- Do not add extra prose or reformat it.
- By default, status overview is scoped to the current Codex session, shows each peer workflow once, and hides its linked implementation jobs. `--all` widens the overview to the repository workspace and includes linked jobs.
- A specific ID may identify either a tracked job or a peer design/research workflow.
- Status inspection may reconcile stale owned jobs. Process cleanup remains PID-identity checked; healthy active jobs are not rewritten.

Default output (including JSON) is a summary capped at 8192 UTF-8 bytes. It never consumes terminal notifications. `--all` widens scope but keeps the cap and reports omitted counts. `--output <new-path>` writes the full public JSON read payload to a new private file and returns an outputFile/bytes/sha256 receipt; existing paths and symlinks are refused.
