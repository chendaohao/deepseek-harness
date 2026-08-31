# Agent Note: 会话置顶经由会话日志持久化并决定列表排序

Status: implemented

[English](2026-08-31-session-pin-pinned-projection-and-order.md) | 中文

## Problem

会话列表界面只按最近活动（`updatedAt = max(createdAt, lastPromptAt)`）排序，重要会话因此不断被更新的活动挤下去。此前没有跨设备持久、可靠的"把会话保持在最前"状态：工作区视图存储的手动顺序只存在于浏览器本地，而 `updated` 排序模式会把任何新活动的会话提升到手动排列之上。置顶需要像标题一样在重启、重放与换设备后依然存在。

## Decision

**置顶是带投影的持久会话日志属性，遵循 `session/title` 先例。** 新包 `@deepseek-ai/dsh-session-pin` 拥有 `session/pin` 事件（载荷 `{ pinned: boolean }`，仅记录日志，绝不进入模型面）与 `pinned` 投影键，其值为 `{ pinned: boolean, pinAt: number | null }`。`pinAt` 取事件时间戳，为置顶组提供确定性顺序（后置顶的在前）。投影单元经 `ctx.sessionProjections` 注册，冷会话通过投影缓存获得置顶状态，控制流像 `title` 一样实时推送变化。

**宿主列表把置顶行排在前面。** `ApiSessionList.list()` 现在排序为：置顶行按 `pinAt` 降序，随后未置顶行按 `updatedAt` 降序。`SessionSummary` 携带可选的 `pinned`/`pinAt` 投影镜像，让不读投影块的消费者也能正确排序。

**`session.setPin` 是 Remote 命令。** `SessionController` 暴露 `@Remote('setPin')`，委托给 `SessionCommandController.setPin()`，经 `ctx.sessionPin` 追加事件。未挂载置顶服务的部署映射为 `pin-unavailable`；其余失败映射为 `internal`。客户端 `ISession` 面新增 `setPin(pinned)`，接受后立即落定 `pinned` 投影单元（高 seq 胜出的规则让稍后到达的控制帧成为无害重放）。

**UI 把置顶作为行菜单动词。** 侧边栏会话行菜单新增 置顶会话/取消置顶；动作经注入的 `pinSession` 回调派发，与归档相同的无对话框、非破坏性姿态。树推导（`deriveGroups`/`deriveFlat`/`deriveSearchResults`）与浏览器最近活动比较器都先把置顶行排前，工作区分组与扁平列表都遵循置顶。

## Alternatives considered

**浏览器本地置顶存储。** 已否决——置顶是对会话的持久声明，不是查看偏好；本地视图存储在换设备时会丢失，且 `updated` 排序模式仍会把它覆盖。

**registry 侧置顶集合（类似归档）。** 已否决——归档是不进会话日志的 UI 隐藏关注点；置顶要喂给宿主列表排序，并且必须能在重放时从日志重建，只有事件+投影能做到。

**用 `insertSessionBefore` 重排置顶。** 已否决——工作区账户是按工作区的手动顺序；置顶跨列表、跨工作区全局生效。

## Consequences

置顶在分组与扁平列表、冷会话与热会话中都生效，并在重启/重放/分叉后保持（分叉继承种子前缀的置顶状态）。事件词汇表重新生成（`known-event-types.ts`、`docs/persistence-catalog.md`）。`pnpm run test:gui` 覆盖客户端套件，新宿主 spec 覆盖 RPC 与排序。

## Testing

`pnpm vitest run packages/session/session-pin packages/api/session-controller packages/client/ui-workspace`（565 个测试）与 `pnpm run test:gui`；新增 spec：`session-set-pin.host.spec.ts`（接受、pin-unavailable、internal 映射）、`session-pin-order.host.spec.ts`（经投影缓存的置顶优先排序）、`tree.client.spec.ts` 置顶排序、`rows.client.spec.tsx` 置顶/取消置顶菜单派发。`pnpm run verify-persistence-catalog`、`verify-doc-graphs` 与 README 门禁均通过。

## Related

- [日志会话标题与标题投影先例](../../../../packages/session/session-title/README.zh.md) —— `session-pin` 遵循的事件+投影模式。
