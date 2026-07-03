---
name: transfer
description: 'Transfer the current Claude Code transcript into a resumable Codex thread. Args: [--source <claude-jsonl>]. Use when the user wants to hand off the current Claude session into Codex.'
---

# Claude Code Transfer

Use this skill when the user wants to transfer or hand off the current Claude Code session into a Codex thread.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Always run the companion from that active plugin root:
`node "<plugin-root>/scripts/claude-companion.mjs" transfer $ARGUMENTS`

Supported arguments: `--source <claude-jsonl>`

Output:
- Present the companion stdout exactly as returned.
- Preserve the Codex session ID and the `codex resume <session-id>` command.
- The SessionStart hook normally supplies the current transcript path automatically. Use `--source <claude-jsonl>` only as a manual override.
