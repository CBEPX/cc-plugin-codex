---
name: design
description: Use when comparing implementation or architecture alternatives with independent Codex and Claude evidence before making a technical decision.
---

# Codex and Claude design

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Keep the shell tool in the active Codex user workspace; never set its working directory to `<plugin-root>`. Companion commands use `<plugin-root>/scripts/claude-companion.mjs`.

Arguments: `$ARGUMENTS`

Use the complete shared execution contract in `../../internal-skills/peer-runtime/runtime.md`. It defines the supported `--model`, `--fallback-model`, `--effort`, `--codex-model`, `--codex-effort`, repeated `--user-mcp-tool`, `--allow-project-mcp-servers`, `--no-auto-tools`, `--continue <workflow-id> [feedback]`, and `--retry <workflow-id>` forms.

The final design answer must compare alternatives, trade-offs, decision drivers, and a recommendation grounded in the frozen peer memos. Preserve disagreements instead of forcing consensus.
