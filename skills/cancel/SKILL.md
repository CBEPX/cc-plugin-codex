---
name: cancel
description: 'Cancel an active Claude Code job or peer workflow in this repository. Args: [id]. Use only when the user wants to stop tracked work.'
---

# Claude Code Cancel

Use this skill when the user wants to stop an active Claude Code job or aggregate peer workflow in this repository.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Keep the shell tool in the active Codex user workspace; never set its working directory to `<plugin-root>` or the directory used to read this skill. Always run:
`node "<plugin-root>/scripts/claude-companion.mjs" cancel $ARGUMENTS`

Supported arguments: `[job-id]`

Output:
- Present the companion stdout exactly as returned.
- Do not add extra prose unless the command itself failed before producing output.
- Workflow cancellation targets only linked jobs and preserves `cancel_failed` when process identity cannot be verified.
