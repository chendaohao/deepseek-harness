# remote/ — remote-access capability

English | [中文](README.zh.md)

The remote-access capability family: exposing the local Web GUI over a public HTTPS tunnel with phone pairing, keeping the existing `/api` trust fence and loopback-only privileged methods unchanged. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| [`remote-tunnel/`](remote-tunnel/README.md) | Tunnel capability: Service + cloudflared quick-tunnel provider | `ctx.remoteTunnel` |
| [`remote-access/`](remote-access/README.md) | Pairing gate, loopback reverse proxy, and the URL/QR consumer | `ctx.remoteAccess` |

`remote-access` consumes the `remoteTunnel` Service and the host webserver port; the shipped Web composition enables both rows from the `dsh web --remote` flag ([web-app patch](../bundle/web-app/cordis.patch.yml)). The [native mobile voice app](../../apps/mobile/README.md) is a pure consumer of the pairing gate and the `/api` protocol.

