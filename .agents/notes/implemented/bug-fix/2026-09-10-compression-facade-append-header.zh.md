# Agent Note: 让压缩 facade 转发 appendHeader

Status: implemented

[English](2026-09-10-compression-facade-append-header.md) | 中文

## Problem

`maybeCompressResponse` 交给每个路由处理器的是自己手写的响应替身，而不是 node 的响应对象。只要客户端接受某种编码——浏览器都接受——处理器拿到的就是这个替身，因此它必须携带处理器会用到的每一个响应成员。`appendHeader` 缺席，而 `/api` 载波在每个 UTC 日的第一个通过鉴权的请求上会调用它：`HostConnectionService.requestRejection` 通过交到手里的响应追加刷新的浏览器会话 cookie。

该调用在路由处理器内部抛出 `TypeError: res.appendHeader is not a function`，载波的最后兜底分支回以 HTTP 400 和空响应体。刷新 cookie 因此从未到达浏览器，浏览器持有的 cookie 始终是旧日期的，该客户端当天之后每一次 `/api` 请求都重复同一条路径：已配对的手机失去 settings describe、会话列表、模型目录和 Agent preset 列表。桌面浏览器会在下一次 `dsh web` 启动时恢复，因为访问带启动令牌的 URL 会重新签发 cookie。请求侧找不出两者的差别——失败的请求体是普通 JSON，没有 `content-encoding`，而隧道链路对当天签发的 cookie 提供同样的调用是正常的。

## Decision

facade 实现 `appendHeader`：在延迟提交之前，把追加的值（字符串或数组）并入待提交头集合，使刷新 cookie 与处理器其余头在首次写 body 时一同落地；在提交之后，委派给被包装的响应，由它持有 node 对已发送头的判定。头修改面现在由 `setHeader`、`appendHeader`、`removeHeader` 三者转发，模块文档与事件面、可写状态 getter 并列写明。

## Alternatives considered

**让 `/api` 路由改用 `setHeader` 追加。** 已拒绝：追加语义属于响应面，因为处理器可能在刷新 cookie 之外再添加自己的 cookie，而第三方路由经由同一载波注册——在调用方绕过会让 facade 的承诺（包装响应但不改变路由 API）对它们继续失效。

**用转发未知成员的 proxy 取代 facade。** 已拒绝：字面量记录了载波保证哪些成员，而万能 proxy 会把缺失成员推迟到第一个碰到它的处理器才暴露，正是本记录要修掉的失败形态。

## Consequences

每日 cookie 刷新不再取决于是否协商了压缩，已配对设备得以跨过 UTC 日界继续工作，而不是在重新配对之前让每一次 `/api` 调用都失败。[compress.spec.ts](../../../../packages/host/webserver/tests/compress.spec.ts) 固定了对外提供的表面——`/refresh` 在 brotli 响应上返回 200 并带两条追加的 `Set-Cookie`——并用替身驱动 facade 的头表面，覆盖没有任何真实响应能走到的提交后分支。

这类缺陷整体仍未关闭：替身是结构性真子集，处理器调用它省略的成员就会得到载波那个空响应体的 400，而且没有运维可见的痕迹，因为已发布的 Web 组合里没有任何组件挂载 `ctx.logger` 的 exporter（[logger 的消息只写进环形缓冲](../../../../vendor/cordis/src/logger.ts)）。
