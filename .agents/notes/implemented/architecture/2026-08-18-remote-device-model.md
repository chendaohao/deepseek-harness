# Agent Note: Remote-access device model — one-time pairing tokens, a revocable roster, and a desktop-only control plane

Status: implemented

English | [中文](2026-08-18-remote-device-model.zh.md)

## Problem

The remote-access capability (public HTTPS tunnel + pairing gate for the Web GUI) paired with a **day-scoped HMAC ticket**: any device could pair within the UTC day, and the 30-day cookie carried no device identity, so there was no way to revoke one phone without rotating the master secret (which evicted everyone) and no in-GUI status — the terminal QR was the only surface. The third-party `@linxin666/dsh-remote-web-ui` offered the missing UX (in-GUI panel, device revocation, live status) but as a parallel implementation with its own tunnel, its own pairing store, and its own `/m/api` proxy that bypassed the platform RPC surface.

## Decision

**Absorb the mobile remote-control experience into the first-party remote family, reusing the existing tunnel and platform protocol.** The host pairing gate becomes a **device model**:

- **One-time pairing token** replaces the day ticket: 32 random bytes, 15-minute TTL, single active (a fresh issuance invalidates the previous), consumed exactly once. The terminal and in-GUI QR both encode `…/pair/<token>`.
- **Device-scoped cookie v2** (`dsh_remote = v2.<deviceId>.<expiresDay>.<mac>`): the HMAC binds the device id, and `authorize` requires the device to still be **live** in the persisted roster (`$DSH_HOME/secrets/remote-roster.json`, 0600). Revocation deletes the record, so the next request answers 401 — no rotation of the master secret needed.
- **`/remote/*` control plane** on the main webserver, desktop-only: the proxy stamps `x-dsh-proxied: 1` on every relayed request (stripping inbound copies), so the control plane rejects anything tunnel-originated — a paired phone cannot manage other devices. Endpoints: `GET /remote/state`, `GET /remote/devices`, `POST /remote/pair/issue`, `POST /remote/stop`, `POST /remote/devices/<id>/revoke`.
- **Events over the existing allowlist bridge**: `remote/devices/change` (roster snapshot) and `remote-tunnel/state` ride `API_REMOTE_FORWARDED_EVENTS` → `ctx.remote.$on`, so the panel stays live with no new wire.
- **`--remote-reset`** now rotates the secret **and** revokes every device.

**A new dual-face package `@deepseek-ai/dsh-client-ui-remote` owns the client surfaces**: the desktop panel (sidebar-foot phone entry → Modal with QR, tunnel badge, device list, stop/refresh/copy) and the standalone `/m` mobile bundle. `/m` is a thin self-bootstrapped React app that reuses the platform `/api` unary RPC and the `events.mux` WebSocket — **not a parallel `/m/api`** — so the paired-device cookie authenticates it and the session-log discipline holds (render derives from `session.history`/`session/event`; sends go through `session.prompt`/`session.selectModel`/`session.rename`).

## Consequences

The third-party's parallel tunnel/pairing/`/m/api` are not ported; its `remote-web-ui` update feature is out of scope. The day ticket, `pairingTicket`/`verifyTicket`, and cookie v1 are removed (pre-release: no compatibility shims). `./types` subpaths were added to remote-access and remote-tunnel so the api-remotes allowlist and the api-proxy forwarding loop see the new events; the api-remotes and host-apiproxy faces reference those packages. Uninstalling `@linxin666/dsh-remote-web-ui` from the web profile is a separate step gated on user confirmation.

## Alternatives considered

- **Keep the third-party plugin, make it reuse first-party infra** — retained the ownership split and left two pairing stores; rejected because the feature is core to the product and the first-party already owns the tunnel and gate.
- **Device model on top of the day ticket** — a ticket that admits any device still cannot express "revoke phone A only"; the one-time token is the minimal unit that carries device identity.
- **`/m` reusing the full client-runtime** — the standalone page has no cordis/shell module table; a thin wire layer over the platform protocol is the smallest correct surface.
