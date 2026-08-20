# Agent Note: 弱远程链路下的历史加载韧性

Status: implemented

[English](2026-08-20-history-load-resilience-remote-links.md) | 中文

## 问题（Problem）

在外部 Cloudflare 隧道（`dsh web --remote`）下，手机网页有两个症状，同源于一个根因：

1. **历史加载不出来。** 打开会话卡在"载入历史…"（`openState === 'loading'`）——`session.history` 这个 unary 在抖动链路上要么挂起、要么失败。
2. **实时更新停止。** 传输层空闲看门狗会重连并 resync，但 resync 要靠 history 拉取重建窗口；一旦该拉取被卡死，清空的窗口就永远不再填充，于是"最新消息"永远不出现。

实时更新的恢复路径 —— 看门狗 → 重连 → `resync` → `doOpen` → history —— 只取决于它依赖的那次 history 拉取。本地该路径可靠；隧道上一个丢包、或慢链路上的大页面就能打断它，且两个界面都无法自愈：

- 桌面端 `doOpen` 只做一次 history 尝试、没有重试，还受固定的 30s unary 预算约束——apiproxy 客户端自己的注释就说这个预算"在慢速远程链路上会截断页面读取"。设计好的逃生通道（`deadlineExemptHistory`）从未接线。
- `/m` 页面自写的 `callUnary`（`mobile/rpc.ts`）**完全没有超时**，响应丢失就会永远挂起——这同时也锁死了 `/m` 的 EventsClient 轮询回退（其轮询用的正是同一个 history 拉取），进而让 `/m` 的实时更新也停摆。
- `/m` 的 EventsClient 空闲看门狗只在 `onopen` 之后才布防，所以 socket 一直建立不起来（隧道边缘吞掉 upgrade）时，既不会启动回退也不会重连。

## 决策（Decision）

让两个界面的 history 读取都有界、可重试：

- **桌面端：时限 + 重试。** `WebApiClient` 接入 `deadlineExemptHistory`；运行时 `Session.history()` 汇聚点（普通与子代理读取的唯一调用点）提供 `AbortSignal.timeout(60_000)`，于是 `doOpen`、`loadOlder`、`repairGap` 都自带宽松上限。`doOpen` 的两次拉取改走 `historyWithRetry` 助手：对抛出的传输层 rejection（apiproxy carrier 在丢包、HTTP 状态码、超时时都会抛）最多重试 3 次，退避 1s/3s；折叠的错误结果是业务错误，绝不重试。这同时也让间隙检测的二次拉取在失败时弱失败（按其 `if (result.ok)` 守卫的本意），不再把已装好的窗口打成 `'error'`。
- **`/m`：unary 超时。** `callUnary` 用 `AbortSignal.timeout(30_000)` 给每次调用设限（有调用方 signal 时用 `AbortSignal.any` 合并），超时折叠为 `transport` 错误。这把此前挂在无超时 history 拉取上的 EventsClient 轮询退避也解开了。
- **`/m`：连接时即布防看门狗。** `connectSocket()` 在 `onopen` 之前就调用 `this.touchIdle()`，于是 socket 一直建立不起来时，`idleTimeoutMs` 后仍会循环进入轮询 + 重连。

既有的空闲看门狗/心跳决策（[2026-08-18-mobile-web-refresh-after-completion](2026-08-18-mobile-web-refresh-after-completion.md)）仍是传输活跃机制；本笔记让它的恢复路径在抖动链路上也能存活。

## 验证（Verification）

单元测试覆盖三处行为：`doOpen` 对一次瞬态 history 抛错重试后成功打开（重试耗尽后落入 `'error'`，且业务错误绝不重试）、间隙检测二次拉取失败时保留已装好的窗口、`/m` 的 `callUnary` 在超时后把永不返回的 fetch 折叠为 `transport` 错误、`/m` 的 EventsClient 看门狗对从不打开的 socket 触发并启动轮询 + 重连。`pnpm run test`（connection/runtime/ui-remote）、`pnpm run typecheck` 与客户端 bundle 构建均通过。

## 备选方案（Alternatives considered）

**给桌面端加 history 轮询回退**（当 mux 帧静默时按会话做陈旧轮询）。因范围原因被婉拒：报告的症状源自 history 读取失败/挂起，而非"mux 停滞但 host 活跃"的传输状态，因此有界、可重试的 history 路径已可修复它们。残余缺口——mux 流停滞但 host 流仍让看门狗保持活跃时桌面实时更新无法自愈——仍是一个已记录的已知限制（桌面没有轮询回退，`/m` 有）。

## 影响（Consequences）

一次丢包的历史请求不再让网页卡死在"载入历史…"；重连后看门狗的 resync 能扛住瞬态失败并重新填充窗口。`/m` 的 unary 调用折叠为错误而非挂起，其轮询回退也能真正退避重试。业务错误绝不重试，真正不存在的会话仍然立刻暴露。时限均为传输层常量（`HISTORY_DEADLINE_MS`、`DEFAULT_RPC_TIMEOUT_MS`、`HISTORY_RETRY_*`），与 `PAGE_MESSAGES` 等既有可调项一致。
