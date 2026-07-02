---
name: mcp-diagnose
description: 'Diagnose which Claude MCP servers and exact tools would be available to Claude Code reviews through this plugin. Args: --user-mcp-tool <mcp__server__tool>, --allow-project-mcp-servers. Use when MCP tools do not appear to work through $cc:review or $cc:adversarial-review.'
---

# Claude MCP Diagnostics

Use this skill when the user wants to understand why a Claude MCP tool is or is not available through the plugin.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Always run the companion from that active plugin root:
`node "<plugin-root>/scripts/claude-companion.mjs" mcp-diagnose $ARGUMENTS`

Supported arguments: `--user-mcp-tool <mcp__server__tool>`, `--allow-project-mcp-servers`

Output:
- Present the companion stdout exactly as returned.
- Do not print raw MCP server configs or secrets.
