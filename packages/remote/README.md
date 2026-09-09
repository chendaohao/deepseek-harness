---
description: "Remote-access capability family: public HTTPS tunnel exposure of the Web GUI with phone pairing."
kind: "package-group"
---
# remote/ — remote-access capability

English | [中文](README.zh.md)

## Summary

The `remote/` group exposes the local Web GUI over a public HTTPS tunnel with phone pairing: `remote-tunnel` owns the cloudflared tunnel Service, and `remote-access` builds the pairing gate, device registry, and loopback reverse proxy on it. Both run from `dsh web --remote` ([web-app patch](../bundle/web-app/cordis.patch.yml)); the `/api` trust fence stays unchanged. All **product** packages.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`remote-tunnel/`](remote-tunnel/README.md) | Tunnel capability: Service + cloudflared quick-tunnel provider | `ctx.remoteTunnel` |
| [`remote-access/`](remote-access/README.md) | Pairing gate, revocable device registry, loopback reverse proxy, and the URL/QR + `/remote/*` control-plane consumer | `ctx.remoteAccess` |

`remote-access` consumes the `remoteTunnel` Service and the host webserver port.

<a id="related-documentation"></a>
## Related documentation

- [Remote access subsystem](../../docs/subsystems/remote-access.md) — the pairing gate, device registry, tunnel Service contract, and control-plane surfaces.

