---
description: "The workspace extension bundle: fork-local rows for session pinning and remote access as the last bundle layer of the web profile."
kind: "package-bundle"
---

# @deepseek-ai/dsh-workspace-ext

English | [中文](README.zh.md)

## Summary

`dsh-workspace-ext` is the fork's own bundle layer: it inserts the session-pin service and the remote-access stack (tunnel, pairing gate, mobile `/m` surface) into the web profile without touching the shipped `dsh-base` or `dsh-web-app` patches. The web profile names it after `dsh-web-app`, so its rows compose over the finished upstream tree and stay inert until the `--remote` flag enables them.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

You get these rows automatically: the shipped `web` profile template lists this bundle after `dsh-web-app`, so every `dsh web` boot composes it. Session pinning activates with the profile; the remote rows stay inert until you pass `--remote` (or `--remote-reset` to also rotate the pairing secret and revoke paired devices).

### What you get

Out of the box, the web profile gains a durable `session/pin` event with pinned-first session ordering, and — behind `--remote` — a public HTTPS tunnel, a pairing-gated reverse proxy, and the standalone mobile surface at `/m`. Each row's package owns its behavior: `@deepseek-ai/dsh-session-pin`, `@deepseek-ai/dsh-remote-tunnel`, `@deepseek-ai/dsh-remote-access`, and `@deepseek-ai/dsh-client-ui-remote`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is a static patch document: one `insert` list applied over the tree the earlier layers composed. It mounts no service of its own, emits no events, and holds no mutable state; each inserted row's package owns that row's behavior and invariants.

### Composition mechanics

The bundle is the last layer of the web profile, after `dsh-web-app`, so its rows see every upstream row and override none — the patch contains no id-targeted entries. The remote rows read the `webStartup` flag service exactly as the `dsh-web-app` rows do: `inject` defers each row until the service exists, and `dsh --profile web --help` provides no `webStartup`, so no remote surface activates. A custom profile that wants these rows names the bundle explicitly; the keyless web e2e scaffold stacks the same patch so test and product compositions cannot drift.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The bundle substance: the four fork-local rows, with per-row rationale as inline comments |
| [`src/index.ts`](src/index.ts) | Package entry; carries no runtime API |
| — | No runtime invariant companion is published; the package is a static patch-list carrier (a YAML document of loader rows owned by other packages); it mounts no service, emits no events, and owns no mutable relation to check. Each inserted row's own package carries that row's invariants. |
| [`tests/workspace-ext.spec.ts`](tests/workspace-ext.spec.ts) | Manifest declaration and row-gating checks |

### Invariant ownership

No invariant companion is published because the package is a static patch-list carrier: each inserted row's package owns that row's invariants, and the bundle owns no mutable relation to check.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you want to go deeper into profiles, the surfaces these rows build on, or the exact composition.

- [app-boot profile section](../../boot/app-boot/README.md) — how profiles are resolved, layered, and customized.
- [Bundle package map](../README.md) — the surfaces built on this core.
- [Generated composition graph](../../../apps/cli/composition.md) — the exact plugin set each shipped profile uses.
- [Profile plugin bundles note](../../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md) — the profile and bundle composition design.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through each inserted row's package, which owns that row's model-facing behavior.

#### KV Cache effect

The bundle itself adds no request prefix; each inserted row's package owns any cache effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits tell you when the rows need extra care or where an override must go. They are current package constraints, not a general comparison or a task backlog.

- **Web-profile rows only** — the `headless`, `sdk`, and `acp` templates do not stack this bundle, so those surfaces have neither pinning nor the remote stack; a custom profile that wants them names this bundle explicitly.
- **Remote gating follows the web flags** — the remote rows read `ctx.webStartup.remote` from the `dsh-web-app` startup surface, so they cannot activate on a profile that does not mount that surface's startup plugin.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
