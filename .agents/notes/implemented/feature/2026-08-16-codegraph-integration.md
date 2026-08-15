# Agent Note: CodeGraph integration for indexed workspaces

Status: implemented

English | [中文](2026-08-16-codegraph-integration.zh.md)

## Problem

Large repositories are hard to navigate by grep alone: call chains, structure, and blast radius hide behind symbol relationships. The codegraph CLI exposes that index, but without guidance agents never reach for it — the tool exists, the habit does not. The repository needs a scoped, per-workspace instruction surface plus tools that open any indexed project.

## Decision

**One plugin, `dsh-codegraph`, on two existing seams — the agent pre-step waterfall and the mcp-client connection API — with no core changes.**

- **Scoped checklist.** For every session whose workspace carries a `.codegraph/` index, the first `enter` pre-step batch folds in a `<system-reminder>` frame with the CodeGraph checklist (symbols between `<!-- CODEGRAPH_START -->` / `<!-- CODEGRAPH_END -->`, injected once per session; the message is a durable `codegraph-instructions` source so replay and dedupe work). Workspaces without an index get nothing: no message, no server, no tools.
- **Lazy MCP server.** The first indexed pre-step spawns one `codegraph serve --mcp` child through the existing mcp-client connection API with a reconnect policy and a per-tool-call timeout; its tools register as `mcp__codegraph__codegraph_explore`, `codegraph_node`, `codegraph_search`, etc. DSH's mcp-client sends no `rootUri`, so the server has no default project and agents pass `projectPath` per call — which opens any indexed project lazily, in any workspace. Connection failures log once and are never fatal: sessions fall back to the `codegraph explore` CLI.
- **Configuration** `{command?, args?, toolCallTimeoutMs?, enabled?}` is validated through the standard Config schema; the CLI binary is never pinned or downloaded (PATH or an explicit command).

## Alternatives considered

- **Always-on server** — rejected: one child per plugin lifetime started lazily on the first indexed pre-step is enough; a warm server would consume resources in non-indexed sessions.
- **Per-session servers** — rejected: the connection is global because mcp-client carries no rootUri; per-session isolation would multiply children for no benefit.
- **Prompt-only integration** — rejected: without the MCP tools the checklist would point at tools that do not exist; the seam is instruction plus tools or nothing.

## Consequences

- Indexed sessions carry one extra user message on the first turn (the checklist) and the `mcp__codegraph__*` tool catalog; the model experience is documented in the package README.
- A missing or broken codegraph CLI degrades to the shell fallback with a logged warning — the plugin never fails a session.
- The checklist is one-shot: later turns never re-inject it (the message already sits in the surface).
