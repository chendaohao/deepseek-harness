# @deepseek-ai/dsh-client-ui-remote

English | [中文](README.zh.md)

Remote-control surface for the Web GUI. Two halves:

**Desktop panel** — a phone-glyph trigger beside Settings in the sidebar foot (`sidebar.footer.action`) opens a modal that shows the tunnel status badge, the one-time pairing QR, the paired-device roster with per-device revocation, and the stop-all action. Data rides the desktop-only remote-access control plane — `GET /remote/state`, `POST /remote/pair/issue`, `POST /remote/devices/<deviceId>/revoke`, and `POST /remote/stop` — plus the forwarded `remote/devices/change` and `remote-tunnel/state` events while the panel is open.

**Mobile surface (`/m`)** — the node half serves a standalone small-screen UI at `/m` (document shell + self-contained `lib/mobile.js` bundle) when enabled (the shipped bundle row derives `enabled` from `--remote`). After phone pairing, the page talks to the host over the same platform `/api` transport the desktop UI uses — unary RPC (`session.list`, `session.history`, `session.prompt`, `session.models`, `session.selectModel`, `session.rename`, `workspace.list`, `session.search`, `session.create`) plus the `events.mux` WebSocket for live `session/event` frames, with a `session.history` polling fallback when the socket cannot deliver. The paired-device cookie authenticates it; no separate mobile channel exists. Rendering derives only from history pulls and live frames — the session log is the source of truth.

The mobile client runs an idle watchdog over the open socket (`idleTimeoutMs`, default 45 s; 0 disables): every delivered frame (host heartbeats included) resets the timer, so a silently dead transport (a phone switching mobile data <-> WiFi tears its TCP leg without a close frame) recycles into the polling fallback + reconnect path on timeout — the same failure mode the desktop connection package's heartbeat/watchdog pair covers.

## Model Experience

None. The mobile surface renders browser UI over the `/api` wire and never assembles or sends a provider request itself.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The `/m` page and the `/api` transport require the paired-device cookie; opening `/m` unpaired shows the device gate's rejection, not an onboarding flow.
- The control-plane routes are loopback-only (tunnel traffic is refused), so the desktop panel reads empty/error states when the host tunnel is off or the browser is remote.
- The mobile surface ships as one ESM bundle (`lib/mobile.js`) inlined from source by the package's standalone tsdown entry; the `bundle` script must run before the `/m` routes can serve it, and the node half answers 500 until then.
- The pairing QR is minted one at a time (a fresh issuance invalidates the previous token), so the panel shows a single QR, not a rotating set.
