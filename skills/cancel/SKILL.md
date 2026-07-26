---
name: cancel
description: 'Cancel an active tracked Claude Code job in this repository. Args: [job-id]. Use only when the user wants to stop a queued or running Claude Code job.'
---

# Claude Code Cancel

Use this skill when the user wants to stop an active Claude Code job in this repository.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Resolve `<workspace-root>` from the active Codex session's user workspace, never from `<plugin-root>` or the directory used to read this skill. Always run:
`node "<plugin-root>/scripts/claude-companion.mjs" cancel --cwd "<workspace-root>" $ARGUMENTS`

Supported arguments: `[job-id]`

Output:
- Present the companion stdout exactly as returned.
- Do not add extra prose unless the command itself failed before producing output.
