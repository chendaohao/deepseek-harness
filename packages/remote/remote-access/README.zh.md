---
description: "配对闸门、可吊销设备注册表、loopback 反向代理，以及 URL/QR 与 `/remote/*` 控制面消费方。"
kind: "package-reference"
---
# @deepseek-ai/dsh-remote-access

[English](README.md) | 中文

## 概述

远程隧道能力的消费者：配对闸门、loopback 反向代理、可吊销设备注册表与 URL + 二维码呈现。随附的 Web 行通过 `dsh web --remote` 启用它；配置 `{enabled, resetSecret}`。初始化时读取或创建 32 字节配对密钥（`$DSH_HOME/secrets/remote-pair`，0700 目录下的 0600 文件；`resetSecret` 会先轮换），加载设备注册表（`$DSH_HOME/secrets/remote-roster.json`，0600），在操作系统分配的端口上启动仅监听 loopback 的代理，待 Loader 就绪后把隧道开到该端口，打印 `dsh web remote: <session-url>/pair/<token>`（快速模式为 `*.trycloudflare.com` slug，named 模式为配置的 hostname）与终端二维码（一次性 token，15 分钟 TTL），并通过 shell-env 接缝注册 `DSH_REMOTE_URL`——仅在会话存活期间存在——同时暴露仅桌面可达的 `/remote/*` 控制面，由界面内面板（`@deepseek-ai/dsh-client-ui-remote`）驱动。

安全模型：代理是唯一的公网信任边界。`GET /pair/<token>` 消费一次性配对 token（单活跃，15 分钟 TTL）并 302 种下 30 天有效的 `HttpOnly; Secure; SameSite=Strict; Path=/` cookie，绑定到新签发的设备 id；其余每个请求与升级都必须携带"设备仍在存活"的有效 cookie——不存在基于 Host 或地址的捷径，因为隧道背后所有连接都来自 loopback 地址、Host 头又由客户端控制——否则 401 并展示配对提示页。通过控制面吊销设备会立刻终止其 cookie：下一次请求即 401，已建立的 WebSocket 会在重连时断开。`--remote-reset` 轮换密钥并吊销整个注册表。失败的配对尝试计入按（客户端地址、User-Agent）桶键控的失败预算（每 10 分钟 10 次）——隧道背后所有远程客户端共享 loopback 地址，UA 分量区分不同设备，单个失败客户端不会耗尽所有访客的预算；位于可信边缘之后的部署可自行提供桶键，而正确的 token 永远成功并清零窗口。转发请求的 Host 被改写为 webserver 的绑定权威（随附默认即 loopback）、移除浏览器信任头并盖上 `x-dsh-proxied: 1` 标记（入站同名头被剥除），现有 `/api` 信任栅栏原样生效，`/remote/*` 控制面也能据此区分隧道流量与桌面 loopback；因此设置/凭据/agent-preset 端点持有效 cookie 即可达——Web UI 在非 loopback 页面上将其保留在按会话的内存作用域，本机原生对话框仍仅限本地。WebSocket 升级走同一闸门；上游握手完成前到达的下行帧在字节界内缓冲，帧级与发送队列上限拒绝洪泛连接。隧道退出后按线性退避重新开启（最多 5 次，成功即重置）并重打印 URL/QR；快速模式下域名轮换会迫使手机重新配对（配对 cookie 绑定主机名），而命名隧道（`mode: named`，见 [`dsh-remote-tunnel`](../remote-tunnel/README.zh.md)）保持域名稳定，30 天 cookie 可跨重启继续生效。隧道下的传输层保活：代理把 gateway 可配置的 WebSocket Ping（`websocketHeartbeatIntervalMs`，默认 30 秒）转发到访客连接，隧道边缘不会回收空闲连接；连续三次 ping 无 pong 即关闭中继对，离开的客户端不再占用其流。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----
<a id="model-experience"></a>
## 模型体验

Indirectly, through the `DSH_REMOTE_URL` shell-env contribution this package registers; the shell tools own what reaches a model request.

#### KV Cache effect

None; the contribution adds one per-shell environment value and does not touch request assembly.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **UI 收窄的特权面** — Web UI 在非 loopback 页面上把设置、凭据与 agent-preset 编辑保留在按会话的内存作用域，本机原生对话框仍仅限本地；端点本身在配对认证之后可达。把特权面整体置于配对认证之后，待认证层经过真实使用后再评估。
- **一次性配对 token** — 二维码编码的是单次使用、15 分钟 TTL 的 token；消费或过期后，请在界面内面板点"刷新二维码"或重启 `dsh web --remote` 以获取新 token。`--remote-reset` 轮换密钥并吊销所有设备。
- **控制平面信任 loopback 绑定** — 仅桌面端的 `/remote/*` 控制平面通过 `x-dsh-proxied` 标记拒绝隧道来源流量，但没有其他鉴权，因此必须只从宿主机可达。随附 Web bundle 通过拒绝 `--host 0.0.0.0` 强制这一点；手工组合若把 Web 服务器绑定到所有接口，会把配对 token 签发与设备吊销暴露给局域网。

<a id="dev-note"></a>
### 不变量归属

未发布运行时不变量伴生文件，因为配对门与代理状态已由本包测试端到端覆盖；没有需要在启动时复核的所属关系。

### 开发备注

<details>
<summary>信任边界事实</summary>

loopback 代理是唯一的公网信任边界：一次性配对 token 铸造 30 天设备 cookie，每个请求与升级都复查设备存活，转发请求保持 `/api` 信任栅栏原样生效（盖 `x-dsh-proxied: 1` 标记、剥除浏览器信任头）。隧道下的载体通过 gateway 可配置的 WebSocket Ping 间隔（`websocketHeartbeatIntervalMs`）保活。

</details>
