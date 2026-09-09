---
description: "远程接入能力族：通过公网 HTTPS 隧道暴露 Web GUI 并支持手机扫码配对。"
kind: "package-group"
---
# remote/ — 远程接入能力

[English](README.md) | 中文

## Summary

`remote/` 能力族通过公网 HTTPS 隧道暴露本地 Web GUI 并支持手机扫码配对：`remote-tunnel` 拥有 cloudflared 隧道 Service，`remote-access` 在其上构建配对闸门、设备注册表与 loopback 反向代理。两者由 `dsh web --remote` 一并启用（[web-app patch](../bundle/web-app/cordis.patch.yml)）；`/api` 信任栅栏保持不变。全部为 **product** 包。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx key |
|---|---|---|
| [`remote-tunnel/`](remote-tunnel/README.zh.md) | 隧道能力：Service + cloudflared 快速隧道 provider | `ctx.remoteTunnel` |
| [`remote-access/`](remote-access/README.zh.md) | 配对闸门、可吊销设备注册表、loopback 反向代理与 URL/二维码 + `/remote/*` 控制面消费者 | `ctx.remoteAccess` |

`remote-access` 消费 `remoteTunnel` Service 与宿主 Web 服务器端口。

<a id="related-documentation"></a>
## 相关文档

- [远程接入子系统](../../docs/subsystems/remote-access.zh.md) — 配对闸门、设备注册表、隧道 Service 契约与控制面。

