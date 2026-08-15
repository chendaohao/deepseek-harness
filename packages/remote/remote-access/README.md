# @deepseek-ai/dsh-remote-access

English | [中文](README.zh.md)

Remote-access consumer of the remote-tunnel capability: the pairing gate, the loopback reverse proxy, and the URL + QR surface. The shipped Web row enables it from `dsh web --remote`; config `{enabled, resetSecret}`. On init it loads or creates the 32-byte pairing secret (`$DSH_HOME/secrets/remote-pair`, 0600 under a 0700 directory; `resetSecret` rotates it first), starts a loopback-only proxy on an OS-assigned port, opens a tunnel to that port after Loader settlement, prints `dsh web remote: https://<slug>.trycloudflare.com/pair/<ticket>` plus a terminal QR code, and registers `DSH_REMOTE_URL` through the shell-env seam — present only while a session lives.

Security model: the proxy is the only public trust boundary. `GET /pair/<ticket>` verifies the day-scoped HMAC ticket in constant time and answers 302 with a 30-day `HttpOnly; Secure; SameSite=Strict; Path=/` cookie; every other request and upgrade must present a valid session cookie — there is no Host- or address-based shortcut, because behind the tunnel every connection arrives from the loopback address and the Host header is client-controlled — else 401 with a pairing-hint page. Failed pairing attempts count toward a failure budget (10 per 10 minutes) keyed by client address; behind the tunnel every remote client shares the loopback address, so the budget is global, and a correct ticket always succeeds and clears the window. Forwarded requests get their Host rewritten to the webserver's bind authority (loopback under the shipped defaults) and browser-trust headers removed, so the existing `/api` trust fence applies unchanged; the privileged settings/credentials/agent-preset endpoints are therefore reachable with a valid cookie — the Web UI keeps them in a per-session memory scope on non-loopback pages, and native host dialogs stay local. WebSocket upgrades pass the same gate; downstream frames arriving before the upstream handshake complete are buffered within a byte bound, and per-frame and send-queue bounds refuse flooding pairs. A tunnel exit reopens the tunnel with linear backoff (5 attempts, reset on success) and reprints the URL/QR under the new hostname; cookies survive a hostname change. The transport under the tunnel carries the connection package's heartbeat/watchdog pair: the host heartbeats both WebSocket downlinks while idle, and the phone-side client recycles its generation when frames stop (default detection ≈45 s) or immediately on the browser's network-change signals — a phone switching mobile data ↔ WiFi tears its sockets without a close frame, and this is the exact failure mode those two mechanisms cover.

## Model Experience

Indirectly, through the `DSH_REMOTE_URL` shell-env contribution this package registers; the shell tools own what reaches a model request.

#### KV Cache effect

None; the contribution adds one per-shell environment value and does not touch request assembly.

## Known Limitations and Deferred Work

- **UI-scoped privileged plane** — the Web UI keeps settings, credentials, and agent-preset authoring in a per-session memory scope on non-loopback pages, and native host dialogs stay local; the endpoints themselves sit behind pairing auth. Host-plane exposure behind pairing auth waits for the auth layer to earn real-world mileage.
- **No in-GUI remote status** — the URL/QR surface is the terminal; a GUI badge needs a forwarded event or a Remote method and is deferred until a consumer exists.
- **Day-scoped tickets** — the QR re-pairs any device for the current UTC day; after the day rolls or after `--remote-reset`, scan a fresh QR. Cookies outlive both until expiry.
