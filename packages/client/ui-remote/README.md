---
description: "Browser-side remote-control surface: the desktop pairing/device panel, rendered over the remote-access control plane."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-remote

English | [中文](README.zh.md)

## Summary

Browser-side remote-control surface for the Web GUI. A Remote settings page (`settings.section`) carries the panel: tunnel status badge, one-time pairing QR, paired-device roster with per-device rename and revocation, and stop-all. Data rides the desktop-only remote-access control plane — `GET /remote/state`, `POST /remote/pair/issue`, `POST /remote/devices/<deviceId>/revoke`, `POST /remote/devices/<deviceId>/rename`, and `POST /remote/stop` — plus the forwarded `remote/devices/change` and `remote-tunnel/state` events while the page is mounted.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

None, as the remote surfaces render logged state over the `/api` wire and never assemble or send a provider request themselves.

#### KV Cache effect

None; the panel assembles no model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The control plane is loopback-only** — tunnel traffic is refused, so the desktop panel reads empty/error states when the host tunnel is off or the browser is remote.
- **One QR at a time** — a fresh issuance invalidates the previous token, so the panel shows a single QR, not a rotating set.
- **A long roster scrolls** — the settings column scrolls the panel body, so the pairing QR leaves the top of the page once the device list outgrows it; the stop row stays pinned to the scrollport floor.

<a id="dev-note"></a>
### Invariant ownership

No runtime invariant companion is published because the surface renders logged state over the /api wire; nothing durable or model-facing needs a boot-time recheck.

### Dev Note

<details>
<summary>How the surfaces are wired</summary>

The panel mounts through the `settings.section` slot and subscribes to the forwarded remote events only while the section is mounted. Export discipline follows packages/client/AGENTS.md: no cross-plugin value imports; `ctx.remote`, `ctx.slots`, and `ctx.locale` are injected peers.

</details>
