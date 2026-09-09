# Agent Note: The workspace tsdown factory must not wrap the shared preset's array

Status: implemented

English | [中文](2026-09-08-tsdown-factory-nested-array.zh.md)

## Problem

`ui-remote`'s `tsdown.config.ts` factory returned `[clientBundle(...)({ env })]`. `clientBundle(...)` is a `BuildFaceConfig` — a factory whose own invocation already returns a `UserConfig[]`; wrapping that array inside another array produced a nested `UserConfig[][]`. The tsdown workspace runner accepted the config file, logged its path, and emitted nothing for the package: no error, no build output, no artifact. `pnpm run build:lib:client` "succeeded" while `lib/client.js` stayed stale, and every browser reload of the remote panel served the old bundle. The defect is invisible in per-package success logs and only shows as a missing `[@deepseek-ai/dsh-client-ui-remote/client]` line among the workspace build output.

## Decision

**A workspace tsdown factory returns a flat `UserConfig[]`; when delegating to a shared preset factory, spread or return its result directly, never wrap it in another array literal.**

```ts ignore-check
// wrong: nested UserConfig[][]
export default (({ env }) => [clientBundle('id', ['lib/types/index.js'])({ env })])

// right: the preset factory's array is the config list
export default (({ env }) => clientBundle('id', ['lib/types/index.js'])({ env }))
```

The plain-`export default clientBundle(...)` form (most client packages, e.g. `ui-chat`) is structurally immune; the factory form exists only when a package needs face-dependent branching (e.g. returning `SKIP_WORKSPACE_BUILD` on the host face). Detection is one line of Node against the package config: `factory({ env: { DSH_BUILD_FACE: 'client' } })` must yield an array whose every element is a config object, not an array.

## Alternatives considered

- **Teaching the workspace runner to flatten one nesting level** — rejected: hides the authoring error and risks flattening a legitimate config-valued property; the closed set of shapes should stay strict.
- **A gate scanning every package tsdown config for this shape** — deferred: eight packages use the factory form and one was wrong; a lint-level structural check earns its keep only if the factory form spreads.

## Consequences

- Any client package can silently stop shipping its browser bundle through this one-token mistake; the symptom is "the UI change never appears" with a green build.
- Recovery is editing the config, rebuilding the client face, and restarting `dsh web` (the module table reads `lib/client.js` at activation and caches the bytes until restart).
- Reviewing a tsdown config factory change: confirm the returned array is flat by invoking the factory in isolation or watching for the package's own `[name]/client]` output line in the build log.

## Verification

`pnpm run build:lib:client` emits both `[@deepseek-ai/dsh-client-ui-remote]` (node half) and `[@deepseek-ai/dsh-client-ui-remote/client]` (browser half) lines, and `grep 有效期 packages/client/ui-remote/lib/client.js` finds the shipped copy. The browser face type check (`tsc -b tsconfig.client.json`) is unaffected — the defect was output-shaped, not type-shaped.
