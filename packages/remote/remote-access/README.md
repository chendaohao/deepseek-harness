---
description: "Pairing gate, revocable device registry, loopback reverse proxy, and the URL/QR plus `/remote/*` control-plane consumer."
kind: "package-reference"
---
# @deepseek-ai/dsh-remote-access

English | [中文](README.zh.md)

## Summary

Remote-access consumer of the remote-tunnel capability: the pairing gate, the loopback reverse proxy, the revocable device registry, and the URL + QR surface. The shipped Web row enables it from `dsh web --remote`; config `{enabled, resetSecret}`. On init it loads or creates the 32-byte pairing secret (`$DSH_HOME/secrets/remote-pair`, 0600 under a 0700 directory; `resetSecret` rotates it first), loads the device roster (`$DSH_HOME/secrets/remote-roster.json`, 0600), starts a loopback-only proxy on an OS-assigned port, opens a tunnel to that port after Loader settlement, prints `dsh web remote: <session-url>/pair/<token>` (a `*.trycloudflare.com` slug in quick mode, the configured hostname in named mode) plus a terminal QR code (a one-time token with a 15-minute TTL), registers `DSH_REMOTE_URL` through the shell-env seam — present only while a session lives — and exposes a desktop-only `/remote/*` control plane that the in-GUI panel (`@deepseek-ai/dsh-client-ui-remote`) drives.

Security model: the proxy is the only public trust boundary. `GET /pair/<token>` consumes the one-time pairing token (single active, 15-minute TTL) and answers 302 with an `HttpOnly; Secure; SameSite=Strict; Path=/` cookie bound to the minted device id; every other request and upgrade must present a valid cookie whose device binding is inside its 30-day inactivity window, and admission slides the window — the first admitted request of each UTC day re-issues the cookie with a fresh 30-day `Max-Age`, so daily use never needs re-pairing, while 30 idle days auto-unbind the device — there is no Host- or address-based shortcut, because behind the tunnel every connection arrives from the loopback address and the Host header is client-controlled — else 401 with a pairing-hint page. Revoking a device (through the control plane) ends its cookie immediately: the next request answers 401, and an established WebSocket dies on reconnect. `--remote-reset` rotates the secret and revokes the whole roster. Failed pairing attempts count toward a failure budget (10 per 10 minutes) keyed per (client address, User-Agent) bucket — behind the tunnel every remote client shares the loopback address, so the UA component separates distinct devices and one failing client cannot burn the budget for every visitor; a deployment behind a trusted edge may supply its own bucket key, and a correct token always succeeds and clears the window. Forwarded requests get their Host rewritten to the webserver's bind authority (loopback under the shipped defaults), browser-trust headers removed, and an `x-dsh-proxied: 1` marker stamped (inbound copies stripped), so the existing `/api` trust fence applies unchanged and the `/remote/*` control plane can tell tunnel traffic from desktop loopback; the privileged settings/credentials/agent-preset endpoints are therefore reachable with a valid cookie — the Web UI keeps them in a per-session memory scope on non-loopback pages, and native host dialogs stay local. WebSocket upgrades pass the same gate; downstream frames arriving before the upstream handshake complete are buffered within a byte bound, and per-frame and send-queue bounds refuse flooding pairs. A tunnel exit reopens the tunnel with linear backoff (5 attempts, reset on success) and reprints the URL/QR; under a quick tunnel the rotated hostname forces the phone to re-pair (the pairing cookie is host-bound), while a named tunnel (`mode: named`, see [`dsh-remote-tunnel`](../remote-tunnel/README.md)) keeps the hostname stable so the sliding 30-day window survives restarts. The transport under the tunnel keeps carriers alive: the proxy relays the gateway's configurable WebSocket pings (`websocketHeartbeatIntervalMs`, default 30 s) to the visitor leg, so tunnel edges do not reap quiet connections, and it closes a relayed pair once three consecutive pings go unanswered, so a departed client stops consuming its streams.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----
<a id="model-experience"></a>
## Model Experience

Indirectly, through the `DSH_REMOTE_URL` shell-env contribution this package registers; the shell tools own what reaches a model request.

#### KV Cache effect

None; the contribution adds one per-shell environment value and does not touch request assembly.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **UI-scoped privileged plane** — the Web UI keeps settings, credentials, and agent-preset authoring in a per-session memory scope on non-loopback pages, and native host dialogs stay local; the endpoints themselves sit behind pairing auth. Host-plane exposure behind pairing auth waits for the auth layer to earn real-world mileage.
- **One-time pairing tokens** — the QR encodes a single-use token with a 15-minute TTL; after it is consumed or expires, mint a fresh one from the in-GUI panel's refresh action or by restarting `dsh web --remote`. `--remote-reset` rotates the secret and revokes every device.
- **Control plane trusts the loopback bind** — the desktop-only `/remote/*` control plane rejects tunnel-originated traffic through the `x-dsh-proxied` stamp but has no other authentication, so it must be reachable only from the host machine. The shipped Web bundle enforces this by refusing `--host 0.0.0.0`; a hand-composed row that binds the Web server to all interfaces would expose pairing-token issuance and device revocation to the LAN.

<a id="dev-note"></a>
### Invariant ownership

No runtime invariant companion is published because the pairing-gate and proxy state is covered end-to-end by the package's tests; no owned relation needs a boot-time recheck.

### Dev Note

<details>
<summary>Trust boundary facts</summary>

The loopback proxy is the only public trust boundary: one-time pairing tokens mint device cookies whose 30-day inactivity window slides on use (daily cookie refresh, idle auto-unbind), every request and upgrade re-checks the binding, and forwarded requests keep the `/api` trust fence intact (`x-dsh-proxied: 1` marker, browser-trust headers stripped). The carrier under the tunnel keeps alive through the gateway's configurable WebSocket ping interval (`websocketHeartbeatIntervalMs`).

</details>
