# Agent Note: 面向移动浏览器的 Web 传输优化 —— 压缩、缓存、WS deflate、预加载与 service worker

Status: implemented

[English](2026-08-20-web-transport-optimization.md) | 中文

## 问题（Problem）

dsh Web GUI 的传输链（node:http 载体、SPA dist 服务器、插件 bundle 路由、WebSocket downlink）发布时没有任何传输优化。首次页面加载经 HTTP/1.1 传输约 5.8 MB 未压缩的 JavaScript 与 CSS（shell 1.16 MB + 53 个插件 bundle 4.58 MB），每次刷新都会重新拉取全部内容（bundle 无 `no-cache`、哈希 shell 资源无缓存头、无校验器），两条事件流 WebSocket 携带未压缩的 JSON 文本。在手机蜂窝链路上，这是数秒无谓延迟与反复的每日流量开销。

## 决策（Decision）

webserver 载体新增逐请求压缩通道（`packages/host/webserver/src/compress.ts`）：优先 brotli、回退 gzip，按 `Accept-Encoding` 协商；只有可压缩 MIME 类型、带响应体的状态码且已知体积超过 1 KiB 阈值才压缩；SSE（`text/event-stream`）始终逐字节透传、零附加延迟。被压缩的响应去掉 `content-length`（改用 chunked 分帧）并加 `Vary: accept-encoding`。配置：`compression: 'auto' | 'br' | 'gzip' | 'none'`、`compressionThresholdBytes` 与 `keepAliveTimeoutMs`（针对慢速移动链路默认 30 秒）。web-app bundle 以 `DSH_WEB_COMPRESSION` 环境变量逃生门接入 `compression: 'auto'`。

SPA dist 服务器（`frontend-static`）为 Vite 内容寻址资源（`assets/*`、字体、语言包）提供 `Cache-Control: public, max-age=31536000, immutable`；未哈希的静态文件得到 `public, max-age=3600, must-revalidate`——service worker 脚本除外，它保持 `no-cache` 以便已部署的 worker 在下次访问时接管；每个 index 响应保持 `no-cache` 并带强 ETag，`If-None-Match` 命中即答 304——启动 manifest 的 index-tap 注入随插件集合不断变化，因此文档重新校验而载荷停止重下载。

插件 bundle（`/plugins/<id>/client.js?rev=…`）按 rev 内容哈希，modules 路由以 `immutable` 提供；重建的 bundle 获得新 rev URL，HMR 链替换 URL，因此过期缓存永远无法提供撕裂内容。

connection 插件的 WebSocket downlink 协商 `perMessageDeflate`（默认开启；可配置关闭）——帧载荷是 JSON 文本，在聊天密集的流上可压缩 60-80%。

启动 manifest 注入（`client-modules`）为 stage-one 的 `immediately` 行添加 `<link rel=preload as=script>` 提示，在 HTML 解析期间启动这些传输，从而折叠 HTTP/1.1 请求瀑布（已脚本化的 bootstrap 行不重复提示）。

service worker（`apps/web/public/sw.js`，仅 http(s) 源从 `main.ts` 注册——Electron file:// 跳过，`updateViaCache: 'none'` 让更新检查绕开 HTTP 缓存）使 shell 可离线：导航网络优先（manifest 必须保持新鲜）、`/assets/*` 与 rev 哈希的 `/plugins/*` 缓存优先，且绝不缓存 `/api/*` 或事件流。

## 备选方案（Alternatives considered）

**共享压缩中间件包** —— 新建 `dsh-http-util` 压缩模块本可同时服务 webserver 与 remote-access 代理。代理已用自身语义处理配对与中继，webserver 的 facade 方式让压缩对路由处理器不可见；共享包在无当前消费者的情况下增加了耦合。

**载体中启用 HTTP/2** —— 以 `node:http2` 替换 `node:http` 可原生多路复用 53-bundle 瀑布，但 `http2` 的请求/响应对象不是 `IncomingMessage`/`ServerResponse`，每个路由处理器、fetch 桥与 upgrade 机制都要返工。preload 提示已覆盖首载瀑布；h2 仍是部署层选项（前置反向代理），已在 README 记录。

**压缩 SSE** —— 对 text/event-stream 做 brotli 会引入延迟（编解码器有缓冲）并破坏代理的字节级分帧；实时路径保持 identity。

**插件 bundle 上 ETag** —— rev 查询参数本身就是校验器；immutable 缓存让重新校验失去意义。

## 影响（Consequences）

- 现代浏览器首载从约 5.8 MB 降到约 1.5-1.8 MB（brotli）；重复加载直到插件集合或 shell 变化前只付出 index 重新校验的往返（约 100 字节）。
- 压缩为每个请求带来一点 CPU 开销（默认质量的 brotli 在现代 Node 上很快）；1 KiB 阈值与 MIME/状态门禁让微小与二进制响应绕过编解码路径。`compression: 'none'` 留给自行压缩的反向代理。
- service worker 增加首次访问安装步骤与缓存管理面；失败退化为普通网络路径（注册失败仅警告）。
- webserver facade 把响应头提交推迟到首次写响应体之后；在写响应体前调用 `flushHeaders()` 的处理器会把响应钉在 identity（响应头已在线上）——已在函数上记录。facade 的 `statusCode` 访问器与 `writeHead` 都会喂给这次延迟提交，因此用 `statusCode` 赋值拒绝的处理器会保留自己的状态码，而不是被当成 200 送出。
- keep-alive 默认从 5 秒升到 30 秒：抖动移动链路上更少重新握手，代价是服务器上更多空闲 socket；部署在激进代理之后可调低 `keepAliveTimeoutMs`。

## 验证（Testing）

- `packages/host/webserver/tests/compress.spec.ts`（真实 Loader 组合、裸 socket 读取）：brotli/gzip 协商、阈值、MIME 与 SSE 门禁、content-length 移除、Vary、identity 路径，以及通过 `statusCode` 赋值的状态码。
- `frontend-static` 组合测试在既有 fixture 上覆盖缓存头与 304；`client-modules` node-half 测试断言 immutable 插件 bundle 头与 preload 提示。
- webserver 与 connection downlink 套件保持原样全绿（压缩对路由透明；deflate 按连接协商）。
