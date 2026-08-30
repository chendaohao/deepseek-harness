# Agent Note: 手机端迁移到 Typert 线协议与远程流复用器

Status: implemented

[English](2026-08-29-mobile-surface-typert-wire-migration.md) | 中文

## Problem

上游 dsh 0.1.2-alpha.1 删除了 ApiProxy 包——旧点号协议 `/api/session.list` 的唯一后端。`/m` 手机端仍在使用该协议，合并后每个 unary 调用都返回 404，手机 web 的工作区和会话列表全部清空。新 host 侧还不存在：unary 的 roster 读取、按会话的模型目录、以及 HTTP 历史读取——`session/page` 要求 `throughSeq` 游标，而该游标只能来自 `session/follow` 快照；实时事件也只通过 `/api/remote.mux` 复用器上的 `session/follow` 流下发。

## Decision

手机端整体迁移到现行线协议。`rpc.ts` 向斜杠端点发送 client-request 信封，payload 换成以描述符 wire 名为键的 `{ args }`（`session/list` 用 `_request`，其余用 `request`）；响应信封不变。`session/page` 的记录经 `@deepseek-ai/dsh-session/chunk-rows` 转换为折叠事件，把打包的 `chunkrow/*` 行还原为 `assistant/chunk` 增量。工作区 roster 通过短命 socket 上的一条 `workspace/follow` 流解析：open、取 baseline、cancel。subagent 来源的行不进入会话列表，与桌面树一致。

`events.ts` 在常驻的 `/api/remote.mux` socket 上为被观察会话维护一条 `session/follow` 流。opening 快照经新的 `onSnapshot` 面供给聊天尾部（records、cursor、hasMore、投影基线），后续条目以 `session/event` 帧扇出，与从前完全一致；切换被观察会话时在活跃 socket 上发送 `cancel` + `open`。旧的 HTTP 轮询回退已删除：page 严格以快照游标为上界，无 socket 的客户端既读不到历史也读不到实时事件——复用器 socket 成为必经路径，重连退避与空闲看门狗（浏览器无法感知服务端 WebSocket ping，故保留回收逻辑）构成失败面，经新的 `onStatus` 面上报。

`ChatView` 的尾部、翻页游标、当前模型（`modelSelection` 投影的 `next ?? lastUsed`）均来自快照；更早的历史经 `session/page` 在游标之下加载；模型目录改读部署级 `session/modelCatalog`；`session/prompt` 现在铸造必需的客户端 `requestId`。

## Alternatives considered

**在网关前加一层点号协议 shim。** 否决：这会把刚删除的 ApiProxy 缝重新树为永久本地面，与合并方向相悖，且 roster 与历史游标的缺口依旧无解。

**给 workspace 能力新增 roster 快照端点。** 否决：为单一消费方改动 host 侧；对现有流采用 baseline-then-cancel 模式即可，能力保持不变。

## Consequences

手机端与桌面端共享同一套线词汇，此后 host 变更只需一次迁移而非两次。不转发 WebSocket upgrade 的隧道现在会破坏聊天历史与工作区 roster——此前只影响实时流——分别表现为 roster 的错误态与聊天的"实时连接不可用"横幅。空闲看门狗每 45 秒回收一次闲置 socket；重连会重新快照并经 seq 水位幂等重折。测试覆盖信封与 args 形状、mux 帧解析、follow 的打开/切换/回收路径、快照尾部折叠、游标翻页与投影推导的模型角标。
