---
description: "远程接入能力族：通过公网 HTTPS 隧道暴露 Web GUI 并支持手机扫码配对。"
kind: "package-group"
---
# remote/ — 远程接入能力

[English](README.md) | 中文

远程接入能力族：通过公网 HTTPS 隧道暴露本地 Web GUI 并支持手机扫码配对，且不改变现有的 `/api` 信任栅栏与仅限 loopback 的特权方法。全部为 **product** 包。

| 包 | 角色 | ctx key |
|---|---|---|
| [`remote-tunnel/`](remote-tunnel/README.zh.md) | 隧道能力：Service + cloudflared 快速隧道 provider | `ctx.remoteTunnel` |
| [`remote-access/`](remote-access/README.zh.md) | 配对闸门、可吊销设备注册表、loopback 反向代理与 URL/二维码 + `/remote/*` 控制面消费者 | `ctx.remoteAccess` |

`remote-access` 消费 `remoteTunnel` Service 与宿主 Web 服务器端口；随附的 Web 组合通过 `dsh web --remote` 旗标启用这两个行（[web-app patch](../bundle/web-app/cordis.patch.yml)）。[移动控制面（`/m`）](../client/ui-remote/README.zh.md) 是配对闸门与 `/api` 协议的纯消费者。

- [远程接入子系统](../../docs/subsystems/remote-access.zh.md) — 配对闸门、设备注册表、隧道 Service 契约与控制面。

