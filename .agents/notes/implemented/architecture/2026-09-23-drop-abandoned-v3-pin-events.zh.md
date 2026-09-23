# Agent Note: 被放弃的 V3 事件在 V3→V4 边丢弃

Status: implemented

[English](2026-09-23-drop-abandoned-v3-pin-events.md) | 中文

## 问题

携带 `session/pin` 事件的 V3 存量会话无法打开。V3→V4 边拒绝 `RELEASED_V3_EVENT_TYPES` 之外的每一个类型，而 `session/pin` 不在该清单中，因此恢复失败并报 `format v3 contains unknown event type "session/pin"`。

[已发布格式清单的增长规则](../bug-fix/2026-09-06-released-format-inventory-event-growth.zh.md) 管辖这一类故障，给出的处方是扩展该时代的清单。那条处方的前提是该类型仍属于产品：它收录一个类型，是为了让写入端产出的行保持可读。pin 功能已被放弃，其行不携带迁移后会话所需的任何状态，收录它们只会保留无人读取的数据。

两种既有的扩展机制也覆盖不到这种情况。外部插件事件靠携带 `ignorable: true` 在同版本读取中存活，但[历史拒绝决策](../architecture/2026-08-31-alpha-historical-unknown-event-refusal.zh.md) 已确立该标记不会让事件跨越格式边迁移。第一方事件只能通过在边的清单中被点名才可迁移，而这正是本次要拒绝的机制。

## 决策

V3→V4 边拥有 `DROPPED_V3_EVENT_TYPES`：它从 V4 产物中省略、而非携带的 V3 事件类型。`session/pin` 是其唯一成员。

`transformEvent` 在密度检查之后立即丢弃成员。被丢弃的事件不消耗目标序列，也不发出任何事件。映射仍前进一项，因此下一个事件的密度检查成立，后续坐标不移动。被丢弃事件自身的映射项永远不会被读取，因为没有事件引用 log-only 类型。

`RELEASED_V3_EVENT_TYPES` 保持不变，因此 `verify-v3-event-vocabulary` 仍将该清单与其 pin 定的 V3 写入端精确比对。

本决定仅就 `session/pin` 一个类型取代清单增长规则。该规则覆盖的其他类型维持原处理，且 v0 清单保留其所需的 `session/pin` disposition，以便在该类型离开日志之前校验存量 v0 载荷。

## 已考虑的替代方案

**在 `RELEASED_V3_EVENT_TYPES` 中扩展 `session/pin`。** v0→v1 的工作对同一类型走的就是这条路，且它保留 pin 状态。它同时声明一个仅属 fork 的类型属于已发布的 V3 词汇，这仅在 pin 定的写入端是产出过它的 fork 提交时成立；清单及其校验于是取决于 pin 的是哪个提交。已拒绝：pin 功能已被放弃，保留这些行带来的收益不足以支撑该依赖。

**把存量行标为 `ignorable: true`。** 该标记只管同版本读取；历史边仍会拒绝未知类型。存量行也不带标记，因此这需要改动写侧，且修复不了任何存量会话。

**从挂载的插件解析该类型。** 迁移可用性将取决于单个部署的组合，并会在产出方缺席时先行失败——这正是[已发布格式迁移决策](../architecture/2026-08-31-released-session-format-migrations.zh.md) 所拒绝的。

**离线改写存量 V3 日志。** 剥除这些行意味着重编号其后每一个事件，并重映射每一个引用到它的事件。边已经执行该重映射，另起一套改写只是在不可变的已提交世代上重复它，而[会话格式版本机制](../architecture/2026-08-10-session-log-version-mechanism.zh.md) 要求这些世代保持不可变。

**把 `session/pin` 变成外部事件。** 删掉 `SessionEventMap` 声明会让该类型离开生成的词汇表，而这正是本边已经预期的形态。它的代价超出放弃 pin 所能支撑的范围：`ProjectionDefinition.apply` 把事件类型标为 `SessionEvent`，一个只对已声明类型做映射的联合，因此插件自有的投影在声明消失后就无法点名自己的类型。加宽这条缝同样不行——外部事件的 `type: string` 与每一个字面量都重叠，会破坏全部投影实现里的判别收窄。于是外部事件的投影需要一次本地加宽断言，且此后每一个都要重复。

## 后果

受影响的会话得以打开，此后任何携带 `session/pin` 的会话也以同样方式迁移。

凡经此边迁移的会话，pin 状态都会消失，v0 来源的日志也不例外：v0→v1 边仍校验载荷，而本边是行离开日志的位置。迁移后的产物无法恢复该状态。

该边点名了一个它丢弃的类型，因此 `RELEASED_V3_EVENT_TYPES` 并未描述该边对 V3 事件所做的一切。该集合不是通用的省略机制：新增第二个成员需要各自的理由，而未列入的未知类型仍一律拒绝。

## 测试

- `session-format-v3-to-v4`：携带 `session/pin` 的 V3 日志迁移后其余坐标保持密集、相邻事件不变、源行未被触碰；末尾的 pin 行留下的产物可重新打开。
- `session-format-catalog`：带 pin 的 V3 日志在完整链路上丢弃这些行；带 pin 的 v0 日志到达 V4 时不含任何 pin 行。
- catalog spec 用 `KNOWN_SESSION_EVENT_TYPES` 检查最新已发布清单，并点名两个豁免：`developer/message`（当前格式引入）与 `session/pin`（本边丢弃的已放弃类型）。任何新增都必须扩展该清单，或有意识地加入该列表。
