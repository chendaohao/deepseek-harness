# @deepseek-ai/dsh-client-ui-settings-remote

English | [中文](README.zh.md)

**Remote Access** page for Web Settings: the bound-device list of the remote-access pairing gate. The browser plugin registers one localized `settings.section` contribution with id `remote` (after General, Models, and Plugins); the settings shell owns the navigation and panel chrome. It performs no Remote read during plugin activation; opening the page lazily calls `ctx.remote.remoteAccessDevices.list()` through [`api-remotes`](../../api/remotes/README.md), and because the plugin injects the `remote.remoteAccessDevices` service, the section simply does not activate on deployments without `--remote`.

Each row shows the device label captured at pairing (the phone-supplied name or the browser User-Agent), the binding date, the relative last-use time, and the sliding auto-unbind countdown (`{n} 天后自动解绑`); any admitted request refreshes that window host-side. Unbinding is a two-step inline confirmation that calls `remoteAccessDevices.unbind` and reloads the list; the unbound device's next request receives 401 and re-pairs through the QR flow. Loading, empty, and generic failure states stay local to the mounted component; failures retry without exposing transport detail. The registration uses `ctx.slots.inject()`, so it follows late section declaration, redeclaration, locale changes, and teardown without importing the shell.

## Model Experience

None, as this package only visualizes and mutates the remote-access device registry in browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One snapshot per page mount or retry** — the page does not subscribe to registry changes (pairing or unbinding from another client appears after reopen or retry).
- **No current-device marker** — the `dsh_remote` cookie is HttpOnly, so the page cannot match a row against this browser; the host-side RPC carries no caller identity.
