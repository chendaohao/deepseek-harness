# Agent Note: 取消置顶通过控制流即时生效——投影覆盖宿主摘要中的过期置顶字段

Status: implemented

[English](2026-08-31-session-pin-unpin-live-clears-stale-summary.md) | 中文

## Problem

会话置顶后，即使点击「取消置顶」，侧边栏仍把该会话留在「置顶」区、并从其工作区分组中隐藏——直到手动刷新页面。置顶功能笔记声称控制流会实时推送投影变化，但取消置顶路径实际上从未更新列表行：客户端列表行的置顶状态由 `SessionManager.buildListSnapshot()` 构建，它先展开宿主列表摘要，仅在投影显示已置顶时*追加*`pinned: true`。宿主要摘要的 `pinned`/`pinAt` 字段在列表拉取时计算，因此置顶后行上带有上次 `session.list` 响应的 `pinned: true`；取消置顶的投影帧更新了投影存储，但展开并没有移除过期的摘要字段——行保持置顶状态，直到下一次列表重新拉取（即用户手动做的刷新）。由于过期行仍带 `pinned: true`，工作区浏览器也继续把该会话从工作区账目中过滤掉，于是它同时从两个分组的应有位置消失。

## Decision

在 `SessionManager.buildListSnapshot()` 中，只要投影存在，`pinned` 投影就对摘要自身的置顶字段拥有权威：投影缺失时摘要保留自身字段；投影存在时先剥离摘要的 `pinned`/`pinAt`，再应用投影值（已置顶 → `{ pinned: true, pinAt }`，未置顶 → 两个字段都不带）。未置顶的线协议表示仍是"字段缺失"，与宿主 `pinFields()` 的输出一致，因此下游消费者（`flattenLineage`、`projectList`、`groupByWorkspace`）无需改动——通过控制帧取消置顶的行现在会立即退出置顶集合并回到其工作区账目，无需重新拉取列表。

## Verification

- 新增 manager 客户端 spec「宿主摘要的过期置顶在取消置顶投影帧到达后被清除」：列表拉取返回 `pinned: true, pinAt: 500`，随后取消置顶投影帧 `{ pinned: false, pinAt: 600 }` 到达——行的 `pinned` 与 `pinAt` 均被清除，无需重新拉取。
- `packages/api/session-controller` 423/423、`packages/client/ui-workspace` 149/149、session-pin + session-projection 42/42、connection fixture + client-runtime 72/72——全部通过。

## Alternatives considered

**在行上发出 `pinned: false` 而非缺省。** 否决——线协议（以及每个消费者）都把未置顶视为*字段缺失*：宿主 `pinFields()` 省略两个字段，`service.ts` 只映射 `pinned === true`，`deriveGroups`/树排序读 `pinned === true`。引入新的 `false` 行状态会在列表快照中泄漏未置顶的第二种表示，而没有任何消费者需要它。

## Consequences

取消置顶最后一个置顶会话时，控制帧到达的同一拍内即从「置顶」区移除并恢复到其工作区分组，无需刷新、无需重新拉取列表。条目缓存比较已覆盖 `pinned`/`pinAt`，清除的字段会使缓存行失效。

## Related

- [会话置顶通过会话日志持久化并给列表行排序](../feature/2026-08-31-session-pin-pinned-projection-and-order.zh.md)——本修复所完善的功能；其"控制流保持置顶实时"的论断现在对取消置顶方向也成立。
