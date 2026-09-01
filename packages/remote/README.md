---
description: "Remote-access capability family: public HTTPS tunnel exposure of the Web GUI with phone pairing."
kind: "package-group"
---
# remote/ — remote-access capability

English | [中文](README.zh.md)

The remote-access capability family: exposing the local Web GUI over a public HTTPS tunnel with phone pairing, keeping the existing `/api` trust fence and loopback-only privileged methods unchanged. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| [`remote-tunnel/`](remote-tunnel/README.md) | Tunnel capability: Service + cloudflared quick-tunnel provider | `ctx.remoteTunnel` |
| [`remote-access/`](remote-access/README.md) | Pairing gate, revocable device registry, loopback reverse proxy, and the URL/QR + `/remote/*` control-plane consumer | `ctx.remoteAccess` |

`remote-access` consumes the `remoteTunnel` Service and the host webserver port; the shipped Web composition enables both rows from the `dsh web --remote` flag ([web-app patch](../bundle/web-app/cordis.patch.yml)). The [mobile control surface (`/m`)](../client/ui-remote/README.md) is a pure consumer of the pairing gate and the `/api` protocol.

- [Remote access subsystem](../../docs/subsystems/remote-access.md) — the pairing gate, device registry, tunnel Service contract, and control-plane surfaces.

