# Official Guidance Digest

This file summarizes the current Anthropic official guidance that is most relevant to rescue prompt shaping.

Primary sources:
- Opus 5.5 prompting: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5
- Fable 5.1 prompting: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1
- Prompting best practices: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- Claude Code common workflows: https://code.claude.com/docs/en/common-workflows
- Agent Skills best practices: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices

Key takeaways to preserve in rescue prompt shaping:
- Be clear and direct. Claude responds best when the task, output, and constraints are explicit.
- Use examples only when they materially improve format or behavior.
- Use XML tags to separate instructions, context, examples, and inputs.
- For long context, place long evidence blocks high in the prompt and keep the final ask near the end.
- Add roles or output contracts only when they sharpen the behavior.
- Let subagents orchestrate naturally when the work is truly separable, but avoid over-delegating simple tasks.
- Keep skills concise and use progressive disclosure for larger references.
- Prefer deterministic scripts or helpers for deterministic operations instead of asking Claude to improvise them.

Implications for this repo:
- The rescue subagent may tighten the forwarded prompt.
- The rescue subagent should not inspect the repository just to make the prompt nicer.
- The rescue subagent should preserve user intent, add only already-known context, and keep the prompt contract compact.

Model-specific qualification (2026-09-24):
- Start evaluations at explicit `medium` for Opus 5.5 and `high` for Fable 5.1. Compare against higher effort on the same tasks before changing defaults; effort names are not comparable across model generations.
- Empty thinking blocks can be normal. The companion can report their phase without inventing reasoning text. Messages API controls such as `thinking.display` are not automatically Claude Code CLI flags.
- Keep resume instructions as a delta. Do not rewrite earlier conversation turns or switch system prompts to deliver routine follow-ups.
- Apply unattended follow-through instructions only within authorized task scope. Assessment requests still finish with findings, and required confirmations remain in force.
