---
name: result
description: 'Show the stored final output for a finished Claude Code job in this repository. Args: [job-id]. Use when the user already has, or needs, a tracked job id.'
---

# Claude Code Result

Use this skill when the user wants the stored final output for a finished Claude Code job.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Keep the shell tool in the active Codex user workspace; never set its working directory to `<plugin-root>` or the directory used to read this skill. Always run:
`node "<plugin-root>/scripts/claude-companion.mjs" result --cwd "$PWD" $ARGUMENTS`

Supported arguments: `[job-id]`

Output:
- Present the full companion stdout exactly as returned.
- Do not summarize or condense it.
