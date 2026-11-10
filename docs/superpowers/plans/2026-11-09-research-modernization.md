# Research modernization implementation plan

Approved scope: diagnostics, current Claude CLI compatibility, multiple search providers, and background research continuation.
Tracking: https://github.com/CBEPX/cc-plugin-codex/issues/27. Base: v1.8.1 at `95cc226`.

## Constraints

- Use RED/GREEN regression tests and independent Codex review. Do not invoke Claude while its quota is unavailable.
- Preserve exact MCP selection, sandbox protections, ownership, epoch fences, and cancellation.
- Keep model, effort, and advisor defaults unchanged. Do not log in or refresh credentials automatically.
- Keep release, installation, hook trust, and shared-runtime migration as separate gates.
- Preserve a resumable handoff and release the claim on a requested pause. The original 10:15 MSK stop was completed; later work resumes only on the user's explicit instruction.

## Task 1: Diagnostics and compatibility

- Reproduce expired OAuth session classification, then classify the proven failure as authentication. Successful quoted text remains successful.
- Require Claude CLI 2.1.314 or later for protected reviews. Refuse an older or unknown version before launch.
- Accept boolean `permissions.denyInsteadOfPrompting` under forced `dontAsk`. Preserve other project restrictions and reject invalid types.
- Show `loginExpiresAt` in setup when the native CLI provides it.
- Test MCP name boundaries and new task events without assuming an upstream failure.

## Task 2: Search providers

- Add `research --search-provider all|brave|firecrawl|native`, default `all`.
- Discover routes separately for each participant and freeze selected exact tool IDs.
- Use all available selected searches. Continue after a partial provider failure with explicit gaps. Require at least one successful search.
- Separate search coverage from page reading. Verify tool results, not only tool calls or model claims.
- Preserve explicit pins and `--no-auto-tools`. Do not add Firecrawl autonomous agents, crawls, browser interaction, or Alexandria.
- Update qualification, worker prompts, and public reads together. Preserve legacy workflows.

## Task 3: Background continuation

- New research proceeds from memos through critique and synthesis to a parent planning turn. `--manual-continue` preserves the checkpoint stop.
- Old workflows remain manual. Design behavior is unchanged.
- Deliver compact fenced checkpoint/final events to the exact parent thread on its existing shared native Codex server.
- Use the existing native queue without resume or context overrides. A bounded trusted `PostToolUse` dispatcher delivers saved events; sandboxed workers do not access the privileged server socket. Qualify the exact parent before enabling delivery. Do not spawn a separate Codex server to deliver an event.
- Distinguish queue acceptance, turn start, and parent consumption. Duplicate delivery cannot start a stage twice.
- Preserve Plan Mode, current user steering, permissions, cancellation, rebind, and SessionEnd behavior.
- Test real parent wake in an isolated profile with fake Claude/MCP before separately migrating any intended task session.

## Verification

Run targeted regressions, `npm run check`, and required mutation gates without reducing thresholds.
Require changed-behavior E2E before commit or PR creation. Preserve any blocked live gate explicitly.
No release, installation, authentication changes, other-session restart, or runtime activation is implied by passing local tests.
