---
name: research
description: Use when investigating a repository question with independent Codex and Claude source research before producing a grounded conclusion.
---

# Codex and Claude research

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Keep the shell tool in the active Codex user workspace; never set its working directory to `<plugin-root>`. Companion commands use `<plugin-root>/scripts/claude-companion.mjs`.

Arguments: `$ARGUMENTS`

New research continues automatically through critique and synthesis when the trusted research `PostToolUse` and `Interrupt` hooks qualify its parent on a compatible shared Codex server. Use `--manual-continue` to stop at the checkpoint. Initial launch returns in background.
For a queued event, preserve `--wake-event` and `--wake-epoch` and use the shared runtime's automatic event contract. Duplicate or stale events start no work. A completed event resumes the parent's analysis and planning from the complete result. It does not authorize implementation.


Search policy: `--search-provider all|brave|firecrawl|native`. The default is `all`.
Inspect the tools exposed to each participant. Use every available provider in the selected scope.
For Codex, pass the exact exposed search IDs as repeated internal `--codex-search-tool` values to `peer-create`.
For Claude, select the exact eligible MCP search IDs and its native WebSearch route.
Do not infer one participant's tools from the other participant's configuration.
Record failed providers as gaps. At least one search must return a successful result for each memo.
Record actual call/result IDs. A tool call without a result is not successful search evidence.
The stored `searchEvidenceSource` distinguishes Claude native stream observations from Codex worker receipts.
Worker receipts do not cryptographically bind citations to provider responses.

Use the complete shared execution contract in `../../internal-skills/peer-runtime/runtime.md`. It defines the supported `--model`, `--fallback-model`, `--effort`, `--advisor`, `--codex-model`, `--codex-effort`, repeated `--user-mcp-tool`, `--allow-project-mcp-servers`, `--no-auto-tools`, `--continue <workflow-id> [feedback]`, and `--retry <workflow-id>` forms.

The final research answer must state findings, source quality, contradictions, confidence, and gaps grounded in the frozen peer memos. Preserve uncertainty and conflicting evidence.

For `web.run` and `web__run` receipts, set `operation: "search"` only for a non-empty `search_query` call. Use `operation: "read"` for page reads. A page open does not satisfy the search requirement. Do not store query terms or page content in receipts.
