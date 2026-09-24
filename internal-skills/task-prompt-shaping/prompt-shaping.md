# Claude Code Rescue Prompt Shaping Reference

Use this document only when the rescue forwarding worker needs to turn the user's request into a tighter Claude Code task prompt before one companion `task` call.
This is an internal prompt-shaping reference, not a public skill. It owns prompt text only. It does not decide execution mode, resume/fresh routing, or any other runtime controls.

Core rules:
- Prefer one clear task per Claude Code run. Split unrelated asks into separate runs.
- Be clear and direct. Tell Claude Code exactly what to do, what done looks like, and what output shape is required.
- Prefer a tighter prompt contract over adding more reasoning effort or more prose.
- Use consistent XML tags when structure helps.
- Add verification, grounding, or safety blocks only when the task needs them.
- If the user is continuing an existing Claude Code thread, send only the delta instruction unless the direction changed materially.
- For assessment, review, or diagnosis requests, the deliverable is the assessment; do not turn it into permission to edit.
- For authorized implementation, define completion as the requested change plus its relevant verification. Continue reversible work already covered by the request; stop for a genuine blocker, protected action, or material scope decision. A progress report or promise of the next step is not completion.
- Keep edits and tests within the requested scope. Prefer targeted edits to whole-file rewrites; preserve required project checks.
- Batch independent reads or searches when their inputs are known; wait for results before dependent calls. Do not add subagents merely to parallelize a small task.
- Preserve a requested exact-output or structured-output contract. Progress notes must not become extra final-answer text.

Allowed additions:
- `<task>`
- `<output_contract>`
- `<default_follow_through_policy>`
- `<verification_loop>` for debugging, implementation, or risky edits
- `<grounding_rules>` for diagnosis, review, or research
- `<action_safety>` for write-capable work

Hard limits:
- Do not inspect the repository just to improve the prompt.
- Do not add file paths, architecture claims, or root-cause theories that were not already provided or observed in the current turn.
- Do not solve the task yourself.
- Do not add long boilerplate that does not change behavior.

When to use this reference:
- The raw request is vague, chatty, or underspecified.
- The request needs a clearer output contract or follow-through default.
- A follow-up should become a short delta prompt for resume.

When not to use this reference:
- The raw request is already clear and compact.
- The request is so short that rewriting would add more words than value.
- You would need to inspect the repository first to improve the prompt. Do not do that here.

Default prompt recipe:
```xml
<task>Describe the concrete job and expected end state.</task>
<output_contract>State the exact response shape and brevity.</output_contract>
<default_follow_through_policy>Say when Claude Code should keep going without routine questions.</default_follow_through_policy>
```

Add only the blocks the task needs:
- `<verification_loop>` for implementation, debugging, or risky edits
- `<grounding_rules>` for diagnosis, review, or research
- `<action_safety>` for write-capable tasks that must stay narrow

Before forwarding:
1. Strip routing flags from the task text.
2. Preserve user intent and add only already-known context.
3. Put long pasted evidence before the final ask when needed.
4. Remove repetition.
5. Forward exactly one companion `task` call.

Detailed Anthropic-derived notes live in [references/official-guidance.md](references/official-guidance.md).
