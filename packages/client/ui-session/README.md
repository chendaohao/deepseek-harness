---
description: "React and Slot adapters for Session Controller lists, interaction state, and per-session context."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-session

English | [中文](README.zh.md)

## Summary

Use this package to expose Session catalog, retain information, and unified UI status through standard Slot hooks. It materializes per-`SessionBinding` hooks and props, while `SessionProvider` can inherit an outer binding or bind an explicit `SessionReference`. It owns process-local pending-interaction and completion-reminder policy without owning Controller transport, history, or references.

Running status comes from Host list baselines or status events; subagent catalog rows do not establish it.

The package also owns the completion notifier: a General-settings preference (`completionNotifications`, default off) gates one system notification per Session that stops running while the document is hidden.

## Table of Contents

- [Access Hooks](#access-hooks)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="access-hooks"></a>
## Access Hooks

The package injects the Client `remoteAccess` service and publishes Session access Hooks over its `source()`: the root `useSessionAccess(sessionId, action)` answers on one Session resource, and the Session-scope `useAccess(action)` answers on the bound Session's resource; the `global` resource's answer is a different Hook, `useRemoteAccess(action)`, so neither shadows the other. `ctx.uiSession.whenAccess(sessionId, action, callback)` is the JS counterpart of `useSessionAccess`: it keeps the callback's effects installed while the current Peer may call `action` on that Session, with the semantics of `ctx.remoteAccess.whenAccess`. The SessionMaybe-scope `useAccess(action)` returns `undefined` while no Session is bound, which callers treat as not allowed; a decision on the `global` resource reads `useRemoteAccess` instead. Snapshot semantics belong to [`dsh-api-remote-access`](../../api/remote-access/README.md#client-face).

<a id="model-experience"></a>
## Model Experience

None, as this package adapts browser-side Session state and registers nothing model-facing.

#### KV Cache effect

None; Session selectors and Slot scopes do not assemble model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Pending interactions are process-local projections** — the owning Remote waterfall must replay an outstanding request after a browser reconnect.
- **Completion notifications ride a loaded page** — the notifier fires from the live tab (or installed PWA) while it stays loaded in the background; it is not a server push channel, so a page the OS discarded notifies nothing. Web Push remains deferred work.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
