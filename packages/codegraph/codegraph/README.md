# @deepseek-ai/dsh-codegraph

English | [中文](README.zh.md)

CodeGraph integration for dsh sessions.

## Behavior

For every session whose workspace carries a `.codegraph/` index:

1. **Scoped checklist** — the first pre-step batch of that session folds in a
   `<system-reminder>` frame with the CodeGraph checklist (symbols between
   `<!-- CODEGRAPH_START -->` / `<!-- CODEGRAPH_END -->`, injected once per
   session). Workspaces without an index get nothing.
2. **MCP tools** — a `codegraph serve --mcp` server is spawned lazily (on the
   first indexed pre-step) and its tools are registered as
   `mcp__codegraph__codegraph_explore`, `codegraph_node`,
   `codegraph_search`, etc. DSH's mcp-client sends no `rootUri`, so the
   server has no default project: agents pass `projectPath` per call (the
   checklist says so), which opens any indexed project lazily.

Connection failures are logged and never fatal: agents fall back to the
`codegraph explore` CLI (also covered by the checklist).

## Configuration

```ts
export interface Config {
  command?: string       // codegraph CLI executable (default 'codegraph')
  args?: string[]        // extra CLI args after 'serve --mcp' (default [])
  toolCallTimeoutMs?: number // per-tool-call timeout (default 120000)
  enabled?: boolean      // set false to disable (default true)
}
```

## Model Experience

### CodeGraph checklist and tools

#### What the model sees

Indexed workspace, first turn: the session carries one additional user message with the CodeGraph checklist, and the tool catalog includes `mcp__codegraph__*`. Non-indexed workspace: no message, no server, no tools.

#### Token effect

One checklist message per session on the first indexed pre-step, plus the standard per-tool schema tokens of the mounted MCP tools.

#### KV Cache effect

None; the checklist text and tool schemas are static per session and the package makes no cache-specific arrangement.

## Known Limitations and Deferred Work

- **One shared server** — a single `codegraph serve --mcp` connection is global, not per-session: it starts on the first indexed pre-step and lives until plugin disposal, so every indexed workspace shares it and tools need an explicit `projectPath` per call (DSH's mcp-client sends no `rootUri`).
- **CLI is assumed installed** — the plugin resolves `codegraph` from `PATH` (or the configured `command`/`args`) and never pins or downloads a version; a missing or broken CLI is logged once and sessions fall back to the `codegraph explore` shell command.
- **Checklist is one-shot** — the checklist folds into the first `enter` pre-step of a session whose workspace carries an index at that point; later turns never re-inject it (the message already sits in the surface), and steps before an index exists get neither instructions nor a server.
