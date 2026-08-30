# Agent Note: CodeGraph MCP tools never registered without an inject declaration

Status: implemented

English | [中文](2026-08-31-codegraph-tools-inject-declaration.zh.md)

## Problem

Sessions in workspaces with a `.codegraph/` index received the CodeGraph checklist and the plugin spawned `codegraph serve --mcp`, but no `mcp__codegraph__*` tool ever appeared in any session's tool catalog, in any deployment. The failure was silent: the MCP connection stayed healthy, the daemon journal showed nothing, and the checklist's own fallback ("when the tools are absent, use the shell CLI") masked the missing integration as model behavior.

The cause was the plugin's mount declaration. `@deepseek-ai/dsh-codegraph` shipped with no `inject` export, deliberately: its comment argued that an inject list would defer `apply` until the tools service exists and "silently skip the plugin in bare-context tests", so it resolved `ctx.tools` lazily at sync time instead. Cordis rejects exactly that access — reading an undeclared service property from a plugin context throws `cannot get property "tools" without inject`. Every `syncTools` call therefore threw before registering anything; mcp-client's contained registration failure (`failOnStartupError: false`) returned an empty generation and kept the connection open; and because the connection never failed, `ready` resolved successfully, so the plugin's restart-on-ready-error path never fired either. The unit tests missed it because they mock `startConnection` wholesale — the real registration path never ran under test.

Reproduced outside the daemon with real components (real `dsh-tools`, the deployment's gated wrapper, the real local `codegraph serve --mcp`): the checklist folded, the server spawned and answered `tools/list` with all eight tools, and the registry stayed empty with the thrown error visible only through a logger hook.

## Decision

`@deepseek-ai/dsh-codegraph` declares the service it uses, the same way every tool plugin does: `export const inject = ['tools']`. A mount context that provides no `tools` defers `apply` until one appears, which is the correct activation semantics for a plugin whose only service touch is the tool registry; bare compositions that want the plugin mount a registry first.

The deployment wrapper (the web profile's `codegraph-gated.mjs`) mounts the real plugin as an object plugin, and an object plugin's inject list comes from the mounting object, not the wrapped module — so the wrapper restates the requirement on its inner mount (`inject: ['tools']`). Both sides now carry the declaration.

The plugin's tests mount the real `SystemPrompt` and `ToolRuntime` before the plugin, and a new test locks the wiring: mounting the plugin into a context without a tools registry folds no checklist and starts no connection. If the `inject` declaration is ever removed, `apply` runs immediately and that test fails.

## Verification

- Pre-fix probe (real tools registry + gated wrapper + real server): `mcp-client(codegraph): tool registration failed, no tools registered: Error: cannot get property "tools" without inject`, zero tools registered, connection stayed open.
- Post-fix probe, same composition: all eight `mcp__codegraph__*` tools register and are visible from the global registry view.
- `packages/codegraph/codegraph/tests`: 6/6 pass, including the new deferral test.
- The rebuilt bundle loads in the restarted web daemon; the boot audit accepts the row (an unresolvable inject name fails the boot loudly).

## Alternatives considered

**Resolve the registry without the declaration (thread the root context or a registry reference into `startConnection`).** Rejected — cordis gates every service resolution through the same inject mechanism, so the access keeps throwing wherever it is written; passing the root context in would couple the plugin to the application root and defeat scoped mounting.

**Fix only the deployment wrapper.** Rejected — the wrapper is one mount of a plugin any other profile, bundle, or test may mount directly; the plugin must satisfy its own service requirement at its own boundary. The wrapper still restates the declaration because object-plugin mounts take the inject list from the mounting object.

**Treat a contained zero-tool sync as a startup failure inside mcp-client.** Deferred — the contained path (log only, `ready` succeeds, no in-session retry) is a real gap this bug hid behind, but changing `contain` semantics affects every MCP client and deserves its own decision; this fix removes the trigger it was hiding.

## Consequences

Sessions in indexed workspaces now see the codegraph MCP tools on their first request after the lazy connection syncs, matching what the checklist has always promised. The cost: bare compositions must mount a tools registry before this plugin activates, and the deferral is silent by cordis design — a missing registry looks like "the plugin is not there", which the new test and this note make diagnosable. The contained-registration-failure gap (silent, never retried in-session) remains open for a separate mcp-client decision.

## Related

- The plugin's own fallback discipline lives in the checklist frame (`packages/codegraph/codegraph/src/checklist.ts`): check for `mcp__codegraph__*`, fall back to the shell CLI — until this fix, step two always missed.
