---
name: research
description: Use when investigating a repository question with independent Codex and Claude source research before producing a grounded conclusion.
---

# Codex and Claude research

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Keep the shell tool in the active Codex user workspace; never set its working directory to `<plugin-root>`. Companion commands use `<plugin-root>/scripts/claude-companion.mjs`.

Arguments: `$ARGUMENTS`

Use the complete shared execution contract in `../../internal-skills/peer-runtime/runtime.md`. It defines the supported `--model`, `--fallback-model`, `--effort`, `--codex-model`, `--codex-effort`, repeated `--user-mcp-tool`, `--allow-project-mcp-servers`, `--no-auto-tools`, `--continue <workflow-id> [feedback]`, and `--retry <workflow-id>` forms.

The final research answer must state findings, source quality, contradictions, confidence, and gaps grounded in the frozen peer memos. Preserve uncertainty and conflicting evidence.
