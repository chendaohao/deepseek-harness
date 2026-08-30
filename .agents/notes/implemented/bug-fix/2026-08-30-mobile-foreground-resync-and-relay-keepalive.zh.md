# Agent Note: 手机端前台恢复同步与中继保活

Status: implemented

[English](2026-08-30-mobile-foreground-resync-and-relay-keepalive.md) | 中文

## Problem

手机在长任务期间把 `/m` 页面切到后台——系统挂起页面并无 close 帧地掐断或饿死其 TCP 连接——再切回前台时，聊天停留在挂起前的尾部，直到手动刷新。唯一的恢复路径是挂起前排定的空闲看门狗加退避重拨，而且首条 follow 快照落地后 ChatView 吞掉了后续一切 `down` 状态，静默失败的重连与"健康但空闲"的聊天看起来毫无区别。手动刷新有效是因为整页重载重建整条传输链。服务端同样如此：中继会向已离开的手机连接无限期扇出帧——gateway ping 的是代理的上游连接，其 `ws` 客户端在协议层自动回应 pong，手机侧死亡对 gateway 不可见，而代理既不转发 ping 也不监视其缺失。

## Decision

`EventsClient.resume()` 强制一次全新拨号并重开 follow 流：回收现有 socket、用立即拨号替换挂起中的退避定时器；新快照经折叠水位幂等回填。App 把浏览器的前台转换接到它上面：`visibilitychange` 变为 visible，以及 `persisted` 为真的 `pageshow`（bfcache 恢复）。ChatView 不再丢弃非 open 的传输状态：传输持续非 open 达 3 秒后渲染停滞提示行（"实时连接已断开，正在重连…"），该延迟避免健康的空闲回收（down → connecting → open 在一个往返内完成）造成闪烁。空闲看门狗保留，继续兜底运营商切换网络。接入代理现在把上游的 WebSocket ping 转发给访客侧，并在连续 `PONG_MISS_MAX`（3）个 ping 无 pong 时关闭该中继对。这使关于 gateway `websocketHeartbeatIntervalMs` 的运营商保活声明成为事实——ping 真正到达手机——并给死腿消耗 follow 流的时长定了界。gateway 本身不变：协议层的 pong 检查在代理身后只能看到代理，看不到手机。

## Alternatives considered

**gateway 侧 pong 记账（N 次未收到 pong 即 terminate）。** 否决：代理的 `ws` 客户端在协议层自动应答上游腿上的 ping，gateway 观察到的永远只是代理；缺通监视应属于拥有访客腿的那一跳。

**代理为每条中继自持 keepalive 定时器。** 否决：gateway 的 `websocketHeartbeatIntervalMs` 已是可配置节拍；转发它只需一个旋钮，避免引入第二个可能失相位的定时器。

**前台返回时的 HTTP 轮询兜底。** 否决：Typert 线协议迁移刻意让 mux socket 成为历史与实时事件的唯一来源；强制全新拨号严格更强也更简单。

## Consequences

回到前台即确定性重取快照，挂起期间产生的输出无需手动刷新即可出现，重连失败可见而非静默。已离开手机的中继至多 `PONG_MISS_MAX + 1` 个心跳间隔内停止，而不是拖到内核超时。手机事件客户端里"multiplexer 每 15 秒 ping 一次"的过时注释已修正：配置默认是 30 秒（`websocketHeartbeatIntervalMs`），45 秒应用帧静默仍是看门狗信号。测试覆盖 resume 路径（活跃 socket 回收、退避取消、stop 后无操作）、停滞提示行的稳定延迟，以及中继的 ping 转发与无 ping 应答拆除。
