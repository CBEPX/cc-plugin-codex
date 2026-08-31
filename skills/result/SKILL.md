---
name: result
description: 'Show the stored output for a Claude Code job or peer workflow in this repository. Args: [id].'
---

# Claude Code Result

Use this skill when the user wants a stored Claude Code result or a peer workflow checkpoint/final result.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Keep the shell tool in the active Codex user workspace; never set its working directory to `<plugin-root>` or the directory used to read this skill. Always run:
`node "<plugin-root>/scripts/claude-companion.mjs" result $ARGUMENTS`

Supported arguments: `[job-id]`

Output:
- Present the full companion stdout exactly as returned.
- Do not summarize or condense it.
- A specific ID may identify either a tracked job or a peer design/research workflow.
- Result inspection records the current aggregate milestone or terminal job output as viewed. Process cleanup remains PID-identity checked.
