# remote/ — 远程接入能力

[English](README.md) | 中文

远程接入能力族：通过公网 HTTPS 隧道暴露本地 Web GUI 并支持手机扫码配对，且不改变现有的 `/api` 信任栅栏与仅限 loopback 的特权方法。全部为 **product** 包。

| 包 | 角色 | ctx key |
|---|---|---|
| [`remote-tunnel/`](remote-tunnel/README.md) | 隧道能力：Service + cloudflared 快速隧道 provider | `ctx.remoteTunnel` |
| [`remote-access/`](remote-access/README.md) | 配对闸门、loopback 反向代理与 URL/二维码呈现 | `ctx.remoteAccess` |

`remote-access` 消费 `remoteTunnel` Service 与宿主 Web 服务器端口；随附的 Web 组合通过 `dsh web --remote` 旗标启用这两个行（[web-app patch](../bundle/web-app/cordis.patch.yml)）。[原生移动语音 App](../../apps/mobile/README.md) 是配对闸门与 `/api` 协议的纯消费者。

