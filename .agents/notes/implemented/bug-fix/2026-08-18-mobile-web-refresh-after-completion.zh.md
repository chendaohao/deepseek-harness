# Agent Note：任务完成后手机 web 的实时更新

Status: implemented

[English](2026-08-18-mobile-web-refresh-after-completion.md) | 中文

## 问题

任务完成后，宿主端 Stop hook 能推送飞书通知，但手机 web（手机浏览器访问的远程 Web GUI，以及 `/m` 表面）不更新：最后的会话事件永远不到达，页面停在旧状态，直到手动刷新。桌面与移动客户端都漏掉了同一个失效模式：手机在移动数据与 WiFi 之间切换（或浏览器标签页被后台化）时，WebSocket 的 TCP 链路被静默撕断——浏览器收不到 close 帧——于是 `onerror`/`onclose` 永不触发，重连机器永不启动，也永远不会 resync。

远程接入设计（[2026-08-14-remote-phone-access](../feature/2026-08-14-remote-phone-access.zh.md)）已经记录了覆盖这一失效模式的心跳 + 空闲看门狗对（位于 `packages/client/connection`），但当前工作分支缺少它：宿主 `WebSocketDownlinks` 从不发送 `stream/heartbeat`，客户端 `ConnectionController` 没有 `idleTimeoutMs` 看门狗也没有 `recycle()`，更没有挂载网络切换监听。

## 决策

把 `dev`（2026-08-15 的原生移动语音应用）的 connection 包心跳/看门狗实现移植到当前工作分支，并把同一看门狗扩展到 `/m` 移动表面自有的 `EventsClient`：

- 宿主 `WebSocketDownlinks` 在每条安静流上每隔 `heartbeatIntervalMs`（Host 插件 Config，默认 15 000 毫秒，0 关闭）发送一条 `stream/heartbeat` 帧，同时也避免隧道边缘回收空闲 socket。
- 客户端 `ConnectionController` 为每个 generation 运行空闲看门狗（`idleTimeoutMs`，默认 45 000 毫秒 = 三个心跳间隔，0 关闭；loopback 页面默认关闭，因为其 socket 不跨网络边界）。任何帧都会重置计时器；看门狗触发即中止该 generation，由既有退避机器重连并重新同步。
- 浏览器的 `online` 事件与 Network Information API 的 `change` 事件立即回收 generation，作为快速通道（Safari 两者都不触发，由看门狗兜底）。
- 移动 `/m` 的 `EventsClient` 增加同一空闲看门狗（`idleTimeoutMs`，默认 45 000 毫秒，0 关闭）：任何到达的帧（含宿主心跳）都会重置它，静默死亡的传输会回收进既有轮询回退 + 重连路径。

运行时 `SessionManager` 已会在 mux 流上丢弃 `stream/heartbeat` 帧并忽略未知 host 帧，因此新帧不会进入会话状态或模型请求。

## 验证

Connection 包测试覆盖心跳发射（安静流、忙碌流、关闭间隔、发送失败）与空闲看门狗（静默回收、帧/心跳重置、`recycle()`、关闭），以及浏览器 `online` 快速通道与监听器销毁。移动 wire 测试覆盖 `/m` 看门狗（静默回收进轮询、帧保持轮询休眠、关闭）。`pnpm run test:gui` 通过（275 文件 / 3830 测试），`tsc -b tsconfig.client.json` 干净。

## 已考虑并拒绝的方案

**依赖浏览器 close/error 事件。** 拒绝：移动数据 ↔ WiFi 切换会在没有 close 帧的情况下撕断 TCP 链路，这正是看门狗要覆盖的静默死亡场景。

**从移动页面轮询会话列表。** 拒绝：`/m` 表面已有 history 轮询回退，但它只在 socket 失败被检测到后才启动；正是看门狗让静默死亡变得可检测，回退才能开始。

## 后果

手机网络切换不再卡死页面：Host 心跳加客户端空闲看门狗检测静默死亡的传输层（最坏约 45 秒），网络切换快速通道通常在不到一秒内重连，二者都走既有重连/重同步机器——任务完成事件实时到达，页面无需手动刷新即更新。心跳帧被业务层忽略（从不落日志、从不进入模型请求）。loopback 页面默认关闭看门狗，本机行为不变；远程（隧道）与 LAN 页面使用默认时限。`/m` 表面的轮询回退在其看门狗检测到死 socket 后立即启动。
