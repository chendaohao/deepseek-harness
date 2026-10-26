# Agent Note: 被回收的载体重开流，而不是终止它

Status: implemented

[English](2026-10-24-carrier-recycle-reopens-streams.md) | 中文

## 问题

手机页面离开前台一段时间后，回来要么是健康的，要么是彻底死的，没有中间态。死掉的那个只能靠刷新页面解除，于是整个外壳——明明还画着、还能点——对所有需要 Host 的操作都不再响应。

这是三个缺陷叠加出来的。

**一次有意的 socket 回收被报告成了终态流失败。** `RemoteStream` 只允许重试一次 `RemoteStreamCarrierError`。它的重试辅助函数读取 Connection generation，当该 generation 仍是当前代次时，只允许重开一次，然后把 carrier error 重新抛给终态边界（`terminalStreamFailure`），后者将其转成 `RemoteError<'gateway/internal'>`。一次回收能恢复，第二次就终止了流。在手机上连续两次回收不是边缘情况而是常态，因为一次前台恢复和一次 Network Information 变化各自都会回收那条共享的 mux socket。在隧道路径上实测，十二个 `change` 事件的突发产生了 13 条 socket 和 142 次逻辑流开启，会话流没能活过来。

**此后 Session 无处可去。** `Session.failEventStream` 把 `openState` 置为 `'error'` 并销毁了流。没有任何东西重开它：与控制流不同，`SessionEventStream` 构造时没有 `carrierFailed` 回调，因此没有监督者重启它。失败在对象层就是终态，而 `ui-chat` 在仍可输入的输入框旁渲染了 `chat.loadError`。唯一出口是刷新。

**一次前台恢复拨了两次号。** `installForegroundResync` 调 `mux.resume()`，后者立即替换 socket。随后 Connection 观察到自己的 generation 已死并要求 Gateway 替换载体，于是 `mux.reconnect()` 丢掉了 `resume()` 刚拨出的那条 socket。每次前台恢复为同一个事件付出两次握手和两轮流失败。

这条链在原理上没有一处是手机专属的，但只有远程页面会撞上：`isLoopback` 会为回环权威关掉浏览器网络监控，所以桌面页面或 `127.0.0.1` 页面最多经历单次回收那一档，而那一档是能恢复的。隧道路径才是突发落地的地方，这也是该缺陷读起来像是「只有手机」的原因。

## 决策

载体恢复按失败的含义划分，而不是按它发生的次数划分。

**只要 Connection generation 仍是当前代次，carrier failure 就重开流，且无次数上限。** 当前代次本身就是 Host 可达的证据：弄断 socket 的那次回收是前台恢复、射频转换或静默期限。调用方可能正在读窗口，因此终止流永远不是正确答案。`RemoteStream` 按自己的抖动退避重开——首次立即重开，之后从 2 秒上限增长到 10 秒天花板并保持在那里。该节奏由 `packages/api/gateway/src/client/stream-retry.ts` 拥有，避免网关长出第二套时序词汇。

**在流的首次 opening 被接受之前，预算有限。** `preopenRetries` 默认重开一次。挂起的首次 opening 没有窗口供调用方持有；无限重试会把这一个调用变成只能由调用方自己取消才能结束的无界等待。一次重开仍能配合正在恢复的射频，因为那次重开是立即的。

**generation 一旦消失，一切不变。** 流仍然等待 Connection 按自己的退避发布下一代，因为更早重开只会去拨一个页面根本到不了的 Host。

**`Session` 吸收仍然会落到它身上的可重试失败。** `failEventStream` 和终态失败的 `doOpen` 按同一节奏安排一次自动重开，并在 `dispose()` 与 `resync()` 时取消。只吸收本客户端层自己拥有的码——`gateway/internal`、`gateway/cancelled` 与 `session/stream-overflow` 命名的是传输或 journal 条件，其修复方式就是一次新的 opening。Host 点名的判决（`session/not-found` 及其同类）不重试，因为重开只会重复它。

**触发侧移除了两处冗余中断。** Network Information 的 `change` 处理器防抖 1.5 秒：射频转换会报告一串事件，只有其中最后一个描述了页面实际会使用的载体。`RemoteStreamMuxClient.reconnect()` 消费一个由自身回收设置的一次性标记，因此一次有意回收所引发的替换请求被视为已满足；更晚的请求照常替换。该标记把仍在拨号中的替代也算作已满足，而不只是已经打开的——为什么"只认已打开"的判断在手机上从未成立，见[重连不再重建页面已经显示的内容](2026-10-26-reconnect-stops-rebuilding-published-state.zh.md)。

## 考虑过的替代方案

**保留有限预算，靠 Session 层重开。** 否决：这会让一个还活着、还能恢复的窗口绕上好几秒，并且让其他所有 `RemoteStream` 消费方——jobs、workspace、terminal、control——在第二次回收时死掉。错的是 `RemoteStream` 里的那个终态边界。

**连首次 opening 也无限重试。** 否决，因为它违反了「从未打开的流必须结算」这一既有契约：在首次 opening 被接受前连续两次载体丢失，一直是在恰好两次尝试之后产生 `openState = 'error'`；而对一个到不了 Host 的页面打开会话，必须能报告这件事，而不是挂住。

**让 mux 拥有重试节奏，流去观察它。** 否决：流本就跨越载体代次，而拥有恢复 cursor 的领域才是唯一知道重开是便宜（一次续传）还是昂贵（一整个窗口）的那一层。共享节奏会把这份知识向上推移。

**把防抖放进 `ConnectionController.reconnect()` 而不是 Network Information 处理器。** 否决：`reconnect()` 同时是明确的用户动作（"立即重连"），那绝不能被延迟。

## 后果

带着死射频回到前台的手机现在会自己恢复，且恢复期间外壳保持可交互。该修复经过验证的形态是：generation 保持当前时连续三次载体失败，第四次代次完成投递。

代价是：只要 generation 报告为当前，流现在可以无界重试。实践中它被退避天花板和调用方生命周期约束——销毁一条流会结束其重试——但一个能应答 generation 握手却让每条流都失败的 Host，会产生稳定的重开流量（停在 10 秒天花板），而不是一个终态错误。`preopenRetries` 边界正是让这一点不适用于「还什么都没有可展示」的调用。

Session 层的重开使浏览器的错误态变成瞬态。想观察 `openState === 'error'` 的测试必须订阅监听，因为紧接着成功的重开会在轮询看到之前就清掉它。`session.client.spec.ts` 里两个恢复测试为此通过 `SessionOptions.recoveryDelayMs` 缩短了延迟。

一次性的 `recycleSuperseded` 标记按意图耦合了两层：`RemoteStreamMuxClient` 必须知道「来自 Connection 的请求通常是它自己那次回收的后果」。这个耦合是不拨两次号的代价，并且它被刻意做成一次性的，好让真正过时的 socket 替换仍然发生。它必须把尚未打开的拨号也算进去，因为 Connection 是在握手期间就发现 generation 丢失的——[后续修复](2026-10-26-reconnect-stops-rebuilding-published-state.zh.md)实测到了绕过这个修复第一版的那两次拨号与两轮重建。

## 测试

`packages/api/gateway/tests/control-retry.client.spec.ts` 钉住节奏与边界两侧：generation 当前时的反复重开、有限的 opening 前预算、增长的延迟，以及丢失 generation 时不变的等待。`packages/api/session-controller/tests/session.client.spec.ts` 钉住 Session 的吸收行为，以及它拒绝重开 Host 点名的失败。`packages/client/connection/tests/client-apply.client.spec.ts` 钉住突发防抖及其产生的单次中断。
