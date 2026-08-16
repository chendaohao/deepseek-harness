# codegraph/ — CodeGraph integration

English | [中文](README.zh.md)

The CodeGraph integration plugin: scoped checklist instructions for sessions whose workspace carries a `.codegraph/` index, plus a lazily started codegraph MCP server. **Product** package.

| Package | Role | ctx key |
|---|---|---|
| [`codegraph/`](codegraph/README.md) | Scoped CodeGraph checklist + lazily started `codegraph serve --mcp` connection | — |

The plugin is inert for non-indexed workspaces: no message, no server, no tools. Sessions fall back to the `codegraph explore` CLI when the MCP connection fails, and the connection is restarted on the next session's first indexed pre-step ([codegraph README](codegraph/README.md)).
