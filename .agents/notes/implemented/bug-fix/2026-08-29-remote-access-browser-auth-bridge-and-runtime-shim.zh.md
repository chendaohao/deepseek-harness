# Agent Note: 跨浏览器鉴权栅栏的 remote-access 配对桥，与 client-runtime shim 行

Status: implemented

[English](2026-08-29-remote-access-browser-auth-bridge-and-runtime-shim.md) | 中文

## Problem

上游 dsh 0.1.2-alpha.1 引入了 Connection 浏览器鉴权（`client/connection/browser-auth.ts`）：webserver 首页与每个 `/api` 路由都要求启动 token 交换或绑定权威的 cookie（`dsh-auth-<hash(Host)>`）。remote-access 配对闸门是独立的一层：它自行铸造设备 cookie（`dsh_remote`），并把转发请求的 Host 改写为 loopback 绑定。两者之间没有桥，配对成功的隧道访客过了闸门却停在栅栏的 401 `dsh web authentication required`——只有桌面端打印的 `?token=` URL 能铸造栅栏 cookie。

同一版本移除了 `@deepseek-ai/dsh-client-runtime`（Store 重构，`packages/client/store`）。四个第三方 profile 插件（`dsh-live-stats`、`dsh-pet`、`dsh-client-ui-web-ui-settings`、`dsh-client-ui-aionui-panel`）的浏览器 bundle 仍在 `require("@deepseek-ai/dsh-client-runtime/client")`，Loader 因此拒绝了它们的入口。

## Decision

1. **配对桥** —— `createAccessPolicy` 接受 `indexLoginUrl?: () => string | undefined`；配对交换的 302 以它替代裸 `/`。`RemoteAccess` 注入 `connection` 并以 `ctx.connection.authenticatedUrl(session.url)` 应答，让刚配对的设备重定向带着启动 token 穿过隧道、自动铸出栅栏 cookie。连接面以结构类型（`IndexLoginConnection`）声明，remote-access 不因此依赖任何包。
2. **运行时 shim 行** —— `~/.dsh/fixes/dsh-client-runtime-shim/` 是一个名为 `@deepseek-ai/dsh-client-runtime` 的插件包，其 client bundle（tsdown closure-factory 协议，zustand + immer 内联）从 `packages/client/store/src/index.ts`（被移除运行时的 `contract/store.ts` 迁入的模块）re-export `createSnapshotStore` 与 `defineStore`，外加一个空操作 `apply`，因为 client kernel 会把每个图条目的导出当作浏览器插件经 cordis registry 应用。两个工厂都是每次调用一个实例，内联的重复引擎不会产生共享状态分歧。Web profile 补丁插入该行；扫描器以被移除包的名字发布它，Loader 据此应答插件的 `/client` 子路径 require。
3. **升级 cookie 中继** —— 代理的 WebSocket 升级路径带着访客的 `Cookie` 头向上游 webserver 拨号（`proxy.ts`）。栅栏用与中继 HTTP 请求相同的权威 cookie 鉴别升级；匿名拨号被拒，并在 101 之后立刻拆除配对——这曾静默杀掉所有隧道流（`/api/remote.mux`）以及浏览器的 Workspace 名册与实时事件，而一元请求仍然可用。

`web-ui-task-board` 在 profile 补丁中保持禁用：其 host half 注入被移除的 `apiProxy` 服务，启动审计会对此大声失败。

## Audit findings

一次全链路审计（配对 → 隧道 → 代理 → 栅栏 → /api → /m）确认链路自洽：栅栏 cookie 的权威是被改写的 loopback Host（127.0.0.1:<port>），每个被中继的 HTTP 请求与 WebSocket 升级都呈现同一权威，铸造与校验一致。四个发现已处理：

1. **Redirect Location 未测** —— 配对 302 的 location（栅栏登录 URL）没有断言，不可用时的回退分支（裸 /）也没有覆盖。policy.spec.ts 现在同时断言桥接的 Location 与 / 回退。
2. **共享限流桶** —— 隧道背后所有请求都来自一个 loopback 地址，按地址键控的失败窗口会让一个失败客户端耗尽所有访客的配对预算（远程 DoS 配对）。窗口默认改为按（地址，User-Agent）分桶——同一地址背后的不同设备各得独立桶——并为可信边缘后的部署提供 pairAttemptKey 选项（例如已验证的 X-Forwarded-For）。测试覆盖 UA 区分与自定义键。
3. **/m 在栅栏之外** —— 移动路由是精确匹配的 webserver 路由，同时绕过 Host 栅栏与浏览器鉴权；隧道内只有配对闸门覆盖它们。ui-remote 现在以 connection.requestRejection 门控 /m 与 /m/mobile.js，与 /api 一致。没有栅栏 cookie 的直接 loopback 访问被拒（桌面浏览器的启动 token URL 负责铸造）。
4. **栅栏 cookie 无 Secure 标志** —— 有意保留的上游取舍：桌面经纯 HTTP 到达 loopback webserver，Secure cookie 在此永远不会被发送。隧道始终是 HTTPS，远程使用不需要该标志；配对闸门 cookie（dsh_remote）保持 Secure，因为它只在隧道中发送。记录在案，不做更改。

## Alternatives considered

**在桌面侧对每个隧道请求重复栅栏鉴权。** 被否：桌面浏览器本就持有有效栅栏 cookie，失败的只是配对后的首次重定向；通过配对重定向铸造 cookie 使桌面流程原样不动，把桥放进一个响应头而非逐请求的代理改写。

**Fork 或逐个修补四个第三方插件。** 被否：其源码在外部，每次上游发版都会重演；一个把被移除包名下的 store 模块 re-export 出去的 shim 包一次性修复全部四个，待其发布适配新 client API 的构建后，删除一行 profile 补丁即可退出。

**不携带 cookie 代理 WebSocket 升级。** 被否：栅栏拒绝匿名升级并在 101 后立刻关闭配对——这正是该中继要修复的静默流死亡；不呈现与 HTTP 请求相同的权威 cookie 就无法让升级存活。

## Consequences

- 设备经隧道 URL 配对一次即落入 GUI；栅栏 cookie 有效期 `cookieMaxAgeDays`（默认 30），因签名密钥持久化在凭据存储中而跨重启存活。
- 隧道 WebSocket 现在与隧道 HTTP 请求行为一致：配对闸门升级、栅栏鉴别升级、中继随设备存亡（reauthorize 间隔仍会在流中切断被吊销的设备）。
- 两项都是相对上游的本地分歧：下一次上游合并会在 `remote-access/src/{index,policy}.ts` 冲突；插件作者发布适配新 client API 的构建后，shim 与两条 profile 补丁行应予移除。
- 启动 token 位于配对重定向的 URL 中；暴露面被配对闸门兜住——每个隧道请求都必须先过它。
