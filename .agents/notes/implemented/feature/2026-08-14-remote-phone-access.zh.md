# Agent Note: 通过配对闸门 HTTPS 隧道实现手机远程接入

Status: implemented

[English](2026-08-14-remote-phone-access.md) | 中文

## 问题

`dsh web` 只服务本机：`--host 0.0.0.0` 被拒绝，`/api` 信任栅栏（`dsh-client-connection`）只是 DNS-rebinding 防御而非认证。手机“随时随地 coding”需要一个真正带认证的公网入口，同时不削弱现有栅栏。

## 决策

**在 `packages/remote/` 下新增两个插件，全部挂在既有扩展点上；Web 组合的标志提供者（`packages/bundle/web-app/src/startup.ts`）与 tool-cordis API 目录新增了 `--remote` 标志与目录条目，核心包零代码改动。** `dsh-remote-tunnel` 提供 `remoteTunnel` Service：固定版本（`2026.8.1`，校验和取自官方发布记录）且逐平台验证 SHA-256 的 cloudflared，把一个 loopback 端口暴露为 `https://<slug>.trycloudflare.com`，含启动重试、有界 stdout/stderr 解析与 SIGTERM→SIGKILL 清理。`dsh-remote-access` 消费它：仅监听 loopback 的反向代理（自有 `node:http` 服务器）是唯一公网信任边界，另有配对闸门与终端 URL + 二维码呈现。随附 Web 组合经 `dsh web --remote` 启用这两行；`--remote-reset` 轮换密钥。cloudflared 二进制首次使用时安装到 `$DSH_HOME/bin`（`download: 'deny'|'system'` 可退出该路径）。

**认证是与现有栅栏分离的配对 cookie。** 32 字节密钥存于 `$DSH_HOME/secrets/remote-pair`（0700 目录下 0600 文件）；`GET /pair/<ticket>` 以常量时间校验当日有效的 HMAC 票据，成功则 302 并种下 30 天有效的 `HttpOnly; Secure; SameSite=Strict` cookie。代理只放行携带有效会话 cookie 的请求，其余一律 401：隧道背后所有连接都来自 loopback 地址、Host 头又由客户端控制，因此不存在任何基于 Host 或地址形状的捷径。票据校验先于失败预算（每 10 分钟 10 次失败，按客户端地址键控——隧道背后所有远程客户端共享 loopback 地址，因此预算全局有效），正确票据永远成功。URL 中只出现票据、绝不出现密钥，且票据不做单次即焚：隧道提供方本就终止 TLS 并看到全部流量，即焚对唯一能观察票据的一方不增加保护，而可复用让多台设备从同一二维码配对。

**代理把请求归一化为 webserver 的权威。** 转发时 Host 改写为 webserver 的绑定权威（随附默认即 loopback）并移除 origin/sec-fetch 头，因此现有 `/api` 栅栏与 WebSocket 闸门原样生效；设置/凭据/agent-preset 特权端点持有效 cookie 即可达，Web UI 在非 loopback 页面上将其保留在按会话的内存作用域。隧道域名永不进入主服务器信任表。上游握手完成前到达的下行 WebSocket 帧在字节界内缓冲（8 MiB），帧级（64 MiB）与发送队列（128 MiB）上限拒绝洪泛连接。

**生命周期与呈现。** 隧道在 Loader 就绪后开启（打印的配对 URL 不能早于 `/api` 路由等兄弟行挂载）；子进程退出后按线性退避重开（最多 5 次，成功即重置），并以新域名重打印 URL/QR。会话存活期间通过 shell-env 接缝注册 `DSH_REMOTE_URL`。

**传输韧性：心跳 + 空闲看门狗。** 手机在移动数据与 WiFi 之间切换时，其到边缘的 TCP 链路被无声撕断，浏览器收不到任何 close 帧；而下行链路单向且事件驱动，空闲连接就这样静默死亡——没有帧、没有 close 事件，重连机器永不启动，页面停止响应。两个机制共同覆盖该失效模式，均位于 `packages/client/connection`：Host 侧 `WebSocketDownlinks` 在每条安静流上每隔 `heartbeatIntervalMs`（Host 插件 Config，默认 15 秒，0 关闭）发送一条 `stream/heartbeat` 帧（两个帧联合体的新成员；业务层忽略它，它从不落日志、从不进入模型请求）——同时避免隧道边缘回收空闲 socket；客户端 `ConnectionController` 为每个 generation 运行空闲看门狗（`idleTimeoutMs`，默认 45 秒 = 3 个心跳，0 关闭；loopback 页面默认关闭，因为其 socket 不跨网络边界）。任何帧都会重置看门狗，因此只有传输层无声死亡时它才会触发；触发即中止该 generation，由既有退避机器重连并重新同步。浏览器的 `online` 事件与 Network Information API 的 `change` 事件会立即回收 generation 作为快速通道（Safari 两者都不触发，由看门狗兜底）。

## 已考虑并拒绝的方案

**为 connection 插件增加运行时信任条目与请求闸门。** 拒绝：自持反向代理把 Host 归一化为 loopback，在现有包零改动的前提下达到相同的信任性质。

**单次即焚配对票据。** 拒绝（理由同上）：唯一能观察票据的一方是隧道提供方，而它本就看得见全部流量。

**由 apps/web 提供配对页。** 拒绝：插件自服务的 `/pair/<ticket>` 页让前端壳保持不动，密钥也不进入应用。

**frp/Tailscale 或 provider 注册表。** 拒绝（v1）：cloudflared 快速隧道无需账号、服务器或 DNS；provider 已隔离在 Service 之后，未来第二个 provider 可在不触碰 `remote-access` 的情况下替换。

## 后果

手机扫码后可经 HTTPS 使用完整 GUI（聊天、审批、提问、工具）；未配对访客得到 401 配对页；本机与局域网行为与之前完全一致（不加 `--remote` 时两行保持惰性）。手机网络切换不再卡死页面：Host 心跳加客户端空闲看门狗检测静默死亡的传输层（最坏约 45 秒），网络切换快速通道通常在不到一秒内重连，二者都走既有重连/重同步机器。历史分页读取也能扛住慢速远程链路：Web 载体让 `session.history`／`subagent.history` 退出固定 30 秒 unary 截止（页面载荷随会话内容增长——用户的真实尾页可达数兆字节），运行时为读取配一个按 generation 作用的中止信号（重连会取消陈旧 fetch，使其无法与新一代自身的 fetch 竞争）加宽裕的 5 分钟页面上限；不传信号的载体（mobile core）保持默认预算。Web UI 在非 loopback 页面上把设置/凭据特权面保留在按会话的内存作用域；端点本身位于配对认证之后——作为 Known Limitation，待认证层经过真实使用后再评估放宽。二进制每台主机下载一次且执行前校验；TryCloudflare 的随机子域名与测试定位已在文档中列为限制。
