# Agent Note: 手机 web 在桌面 GUI 链路上的前台恢复同步

Status: implemented

[English](2026-08-30-phone-web-foreground-resync-gateway-client.md) | 中文

## Problem

桌面 GUI 页面（源点 web 面，手机也经隧道访问）通过 Gateway 的 `RemoteStreamMuxClient` 消费实时 `session/follow` 流。该客户端只靠浏览器 `close`/`error` 事件重连（0.5–10 秒抖动退避）。手机把页面切到后台时，系统无 close 帧地掐断 TCP 连接，任何事件都不会触发，实时流停留在挂起前的尾部直到手动刷新——与 `/m` 手机面曾有的缺口同源，而这次是在手机访客真正使用的面上。

## Decision

`RemoteStreamMuxClient.resume()` 强制一条全新物理 socket：看似健在的 socket 以 4001 关闭，其逻辑流以指明 resync 的 carrier 错误失败，既有的领域 supervisor（`RemoteStream`）将其视为可重试丢失、以 attempt-1 立即重开并拿到全新快照；挂起的拨号经 cancel candidate 切断，重连循环改为重拨而不是永远等一个被吞掉的 upgrade 永远不会发的事件。`installForegroundResync` 把浏览器前台转换（`visibilitychange` 变为 visible、`persisted` 为真的 `pageshow`）接到它上面，以 `isPhoneWeb()`（主指针粗略/移动 UA 回退）为门禁；`ClientRemoteService` 在 carrier 为浏览器传输时安装，并随插件 effect 释放。

## Scope

桌面浏览器行为零变化：非手机不安装，`resume()` 也没有其它调用方。宿主与 in-process carrier 根本到不了安装点。`/m` 面保持其独立恢复。

## Alternatives considered

**移植 45 秒空闲看门狗。** 否决：它会把整个桌面 GUI 拖进手机看门狗为之存在的回收加重快照 churn，远超"只影响手机 web"的范围；前台转换本身就是确定性信号，不需要定时器。

**在 session-controller 领域层做前台重开。** 否决：物理层死活属于 mux 客户端；领域层已拥有 carrier 重试语义，只需要物理层诚实地失败。

## Consequences

手机上回到前台即确定性重取快照，挂起期间产生的输出无需手动刷新即可出现，挂起的重连拨号会在下一次前台返回时被切断而不是永久悬挂。若全新拨号自身失败，既有的"连续两次 carrier 失败终结流"领域规则照常生效——可见失败优于静默冻结。测试覆盖 resume 路径（健康 socket 回收、挂起拨号切断）与安装器的门禁、targets 与卸载。
