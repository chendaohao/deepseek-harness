---
kind: upgrade-guide
description: "remote-access 代理不再压缩面向 Host 的 WebSocket 一跳，因此绑定具体接口地址时，远程客户端流量在该段不再压缩。"
---

# remote-access 只压缩面向远端的 WebSocket 一跳

[English](guide.md) | 中文

## 变更

`remote-access` 代理原先在两条 WebSocket 中继 hop 上分别协商 `permessage-deflate`。现在它只在面向远程客户端的一跳协商该扩展，并在拨向本地 Web 服务器时拒绝。因此 `websocketCompression: 'deflate'` 的含义是"压缩面向远端的一跳"，而不是"压缩两跳"；`'none'` 仍完全关闭压缩。

此前一个大型下行载荷会先被 Gateway deflate、再被代理 inflate、然后为远程客户端再次 deflate。在 loopback 上以 1.4 MiB 历史形态 opening、20 个约 6.5 KB 的回答帧和一组阈值以下对照帧实测，该改动把整链路进程 CPU 降低约 23%，而远程客户端收到的字节完全一致。

## 迁移

1. 保持默认 `127.0.0.1` 绑定的部署无需改动：面向 Host 的一跳从不出机器，本来就没有带宽可省。
2. 以 `dsh web --host <接口地址>` 启动的部署，现在会让面向 Host 的一跳以明文穿过该接口。若这一段跨过你不控制的网络，请改为绑定 loopback 地址并通过 remote 隧道暴露 Web GUI。这里没有逐跳压缩开关：该设置只控制面向远端的一跳。
3. 没有配置键、持久化值、wire 格式或 Session 字段发生变化。`websocketCompression: 'none' | 'deflate'` 名称与取值都不变。
