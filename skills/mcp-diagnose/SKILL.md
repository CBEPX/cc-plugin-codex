---
name: mcp-diagnose
description: 'Diagnose which Claude MCP servers and exact tools would be available to Claude Code reviews through this plugin. Args: --user-mcp-tool <mcp__server__tool>, --allow-project-mcp-servers, --no-auto-tools. Use when MCP tools do not appear to work through $cc:review or $cc:adversarial-review.'
---

# Claude MCP Diagnostics

Use this skill when the user wants to understand why a Claude MCP tool is or is not available through the plugin.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Keep the shell tool in the active Codex user workspace; never set its working directory to `<plugin-root>` or the directory used to read this skill. Always run:
`node "<plugin-root>/scripts/claude-companion.mjs" mcp-diagnose $ARGUMENTS`

Supported arguments: `--user-mcp-tool <mcp__server__tool>`, `--allow-project-mcp-servers`, `--no-auto-tools`

The diagnostic actively starts/probes MCP servers (or sends HTTP initialize and tool-list requests). With `--user-mcp-tool` pins it probes only the servers those pins name; with `--no-auto-tools` and no pins it probes none; without either it probes every configured server in scope. Treat discovery as potentially side-effecting even though the plugin applies an absolute per-server deadline and never persists raw configuration.

Output:
- Present the companion stdout exactly as returned.
- Do not print raw MCP server configs or secrets.
