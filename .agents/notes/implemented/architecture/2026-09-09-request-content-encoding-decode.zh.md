# Agent Note：在 /api 的 JSON 解析点解码压缩的 RPC 请求体

Status: implemented

[English](2026-09-09-request-content-encoding-decode.md) | 中文

## Problem

0.1.5-alpha.1 合并后，已配对手机在模型设置页报 `transport failure for /api/llm/listProviders: HTTP 400`，且所有工作区都加载不了会话——同一调用从桌面、以及经同一公网隧道的 curl 重放都返回 200。服务端日志干净：失败路径从不写日志。

差异在请求体。移动浏览器在计费网络下会压缩上传（POST 体带 `content-encoding: gzip`——夸克手机浏览器如此），而 WHATWG `fetch` 从不解码请求体。`/api` RPC 桥直接对原始字节执行 `request.json()`，gzip 体在 JSON 解析时失败，落进 `rpc-host.ts` 的 400 `body is not JSON` 分支——无日志拒绝，这解释了日志干净与手机全面 400 并存。

缺口早于合并（upstream master 同样存在）；合并只是让它在手机的缓存客户端状态失效、要求从蜂窝浏览器重新登录时显形。

## Decision

**JSON 解析点拥有请求体解码。** `packages/client/connection/src/rpc-host.ts` 的 `rpcFetchHandler` 读取缓冲体，按 `content-encoding` 解码后再 `JSON.parse`：

| `content-encoding` | 行为 |
| --- | --- |
| 缺省 / 空 / `identity` | 原样直读，行为不变 |
| `gzip` / `x-gzip` | `gunzipSync` |
| `deflate` | `unzipSync`，包裹解码失败时回退到 `inflateRawSync`：`unzipSync` 只认 zlib 包裹与 gzip 拼写，而部分客户端发出的是裸流 |
| `br` | `brotliDecompressSync`——与 webserver 已协商的响应压缩对称 |
| 其它 | 415，消息指名该编码 |

- **有意用同步解码器。** HTTP 桥（buffered 模式）已经缓冲了整个请求体再交给 fetch 处理器，字节已在内存里，编解码失败就是一个 400。流式 pipeline 只会给这条路径增加无人受益的背压机器。
- **64 MiB 解压后大小上限**（`MAX_DECOMPRESSED_BODY_BYTES`），超限回 413——解压炸弹的膨胀被约束在桥的 300 MiB 原始上限之下（该上限作用于它缓冲的压缩字节）。未压缩体不走此上限；它们归桥的上限管，行为不变。
- **remote-access 代理保持透明中继**——既不解码也不剥离途经的 `content-encoding`；解码只发生一次，在解析点。WebSocket mux 流基于帧协议，不受影响。

## Alternatives considered

- **在 HTTP 桥（`http-bridge.ts`）解码**——否决：桥是与精确 Fetch 路由（文件上传、日志下载）共享的载体管线，那些路由自有原始体语义；编码策略归路由决定，而 JSON 解析点正是这条路由契约所在。
- **在 remote-access 代理解码**——否决：它会对每一跳重复解码，而响应路径并无对称的再编码；未来桌面（非隧道）直连的带编码请求体仍会 400。
- **让用户关闭上传压缩**——否决：这个头由浏览器控制，不归用户。

## Consequences

- 压缩上传端到端可用：`llm/listProviders`、`session/list` 以及其余所有 buffered `/api` POST 都在解析前解码。
- 未知编码以 415 响亮失败，不再伪装成误导性的 400，且失败消息指名编码。
- 400 分支在响应体里指名 endpoint、媒体类型与客户端发来的 `content-encoding`，并同时写日志，无法解码的请求体因此既能从客户端自己的调试工具、也能从部署导出日志的地方诊断出来。
- upstream 带有同样的缺口；本 Note 让 fork 补丁及其理由在 upstream PR 吸收它之前得以留存。

## Verification

`packages/client/connection/tests/rpc-body-decode.host.spec.ts` 以挂载的 `HostConnectionService` 共享处理器驱动完整组合（围栏桩、共享处理器分发、interceptor 接收）：gzip、deflate 两种拼写、br、`x-gzip`、未压缩与 `identity` 直读、未知编码 → 415、损坏压缩字节 → 400、指名编码的 400 诊断、80 MiB 膨胀 → 413、65 MiB 未压缩体不受解码上限影响。connection 全套（16 文件 178 测试）通过。真机路径验证：gzip 体 curl 经公网隧道 URL 在修复前 400、服务重启后 200。
