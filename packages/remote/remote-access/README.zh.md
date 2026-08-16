# @deepseek-ai/dsh-remote-access

[English](README.md) | 中文

远程隧道能力的消费者：配对闸门、loopback 反向代理与 URL + 二维码呈现。随附的 Web 行通过 `dsh web --remote` 启用它；配置 `{enabled, resetSecret, wsCompression}`。初始化时读取或创建 32 字节配对密钥（`$DSH_HOME/secrets/remote-pair`，0700 目录下的 0600 文件；`resetSecret` 会先轮换），在操作系统分配的端口上启动仅监听 loopback 的代理，待 Loader 就绪后把隧道开到该端口，打印 `dsh web remote: https://<slug>.trycloudflare.com/pair/<ticket>` 与终端二维码，并通过 shell-env 接缝注册 `DSH_REMOTE_URL`——仅在会话存活期间存在。

安全模型：代理是唯一的公网信任边界。`GET /pair/<ticket>[?name=<设备名>]` 以常量时间校验当日有效的 HMAC 票据，成功则 302 并种下 `v2.<deviceId>.<mac>` 的 `HttpOnly; Secure; SameSite=Strict; Path=/` cookie（30 天 Max-Age 随使用刷新）；每次配对都会在注册表（`$DSH_HOME/secrets/remote-devices.json`，0600 原子写）中绑定一台设备，标签取自 `?name=` 参数（至多 64 字符）或 User-Agent 前缀。其余每个请求与升级都必须携带设备绑定仍在滑动窗口内的 cookie：放行即刷新 `lastUsedAt`，连续 30 天未使用则自动解绑（该设备下一次请求收到 401 配对提示页）——不存在基于 Host 或地址的捷径，因为隧道背后所有连接都来自 loopback 地址、Host 头又由客户端控制。每个 UTC 天的首个放行请求会在转发响应上回显一条新的 Set-Cookie，持续使用的浏览器 cookie 不会随时间失效。失败的配对尝试计入按客户端地址键控的失败预算（每 10 分钟 10 次）；隧道背后所有远程客户端共享 loopback 地址，因此该预算全局有效，而正确的票据永远成功并清零窗口。转发请求的 Host 被改写为 webserver 绑定权威（随附默认即 loopback）并移除浏览器信任头，现有 `/api` 信任栅栏原样生效；因此设置/凭据/agent-preset 端点持有效 cookie 即可达——Web UI 在非 loopback 页面上将其保留在按会话的内存作用域，本机原生对话框仍仅限本地。WebSocket 升级走同一闸门（仅在升级时鉴权一次；窗口在下一个普通请求上滑动）；上游握手完成前到达的下行帧在字节界内缓冲，帧级与发送队列上限拒绝洪泛连接。`wsCompression` 开启时（默认开启）转发到公网隧道腿的 WebSocket 帧以 permessage-deflate 压缩；loopback 腿保持明文（回环上压缩无收益）——不声明该扩展的客户端透明地不协商压缩，旧客户端不受影响。隧道退出后按线性退避重新开启（最多 5 次，成功即重置），并以新域名重打印 URL/QR；绑定不受域名变化影响，`resetSecret` 轮换密钥并清空全部绑定。隧道下的传输层携带 connection 包的心跳/看门狗组合：Host 在流空闲时向两条 WebSocket 下行发送心跳，手机端客户端在帧停止后回收其 generation（默认检测时间约 45 秒），或在浏览器网络变化信号到达时立即回收——手机在移动数据与 WiFi 之间切换时会无声撕断其 socket，这正是这两个机制覆盖的失效模式。

`remoteAccessDevices` Remote 服务（typert 命名空间，仅插件启用时注册）把注册表暴露给 Web GUI：`list()` 返回带 `expiresAt` 截止时间的活跃绑定，`unbind(deviceId)` 解绑一台——Web 设置的“远程访问”页（[ui-settings-remote](../../client/ui-settings-remote/README.md)）渲染该列表与手动解绑。

## Model Experience

Indirectly, through the `DSH_REMOTE_URL` shell-env contribution this package registers; the shell tools own what reaches a model request.

#### KV Cache effect

None; the contribution adds one per-shell environment value and does not touch request assembly.

## Known Limitations and Deferred Work

- **UI 收窄的特权面** — Web UI 在非 loopback 页面上把设置、凭据与 agent-preset 编辑保留在按会话的内存作用域，本机原生对话框仍仅限本地；端点本身在配对认证之后可达。把特权面整体置于配对认证之后，待认证层经过真实使用后再评估。
- **GUI 内的远程状态仅限设备列表** — URL/QR 仍只在终端呈现；隧道状态的 GUI 徽标需要转发事件，待有消费者后再做。
- **票据按日有效** — 二维码可在当天为任意设备配对；跨过 UTC 日界或执行 `--remote-reset` 后请重新扫码。cookie 在两者之后依然有效，直至过期。
