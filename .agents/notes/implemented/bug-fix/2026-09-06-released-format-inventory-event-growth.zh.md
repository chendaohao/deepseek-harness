# Agent Note: 已发布格式的冻结清单必须收录该时代写入端可产出的一切事件类型

Status: implemented

[English](2026-09-06-released-format-inventory-event-growth.md) | 中文

## 问题

`session/pin` 于 2026-08-31 落地时，released v0 仍是当前写入格式，但 v0→v1 迁移边的冻结清单 `RELEASED_V0_EVENT_DISPOSITIONS` 没有同步扩展。该边对源日志的校验拒绝清单之外的每一个类型——刻意无视 `ignorable` 标记，也无视当前构建自身认识的词汇——因此任何携带 pin 事件的 v0 存量日志在所有构建上都无法恢复，包括完整认识该类型的构建。故障表现为 Web 客户端里一条长会话无法加载（`format v0 contains unknown historical event type "session/pin" at seq 22278`）：重启后的网关第一次对该日志执行 ensure-current 时触发拒绝。`assistant/attempt` 标出了时代边界：它与 v2 写入端一同诞生，因此它缺席 v0 清单是正确的——只有 v0 仍为当前格式期间可写入的类型才必须出现在清单里。

## 决策

已发布格式时代的冻结清单，是该时代写入端可产出事件词汇的唯一登记处，并在该时代仍为当前格式期间持续增长：

1. `'session/pin': disposition(['pinned'])` 进入 v0 清单。v1→v2 清单继续从它派生（`...retained`），因此一条记录即可贯通源校验、v1 目标校验与 v2 目标。payload 语义在迁移期间强制 `pinned` 为布尔值，与 `dsh-session-pin` 的不变量一致。
2. 只要某个已发布格式时代仍是当前写入端，每个新的 `SessionEventMap` 成员就在同一次变更中进入该时代的清单。时代一旦关闭——再无写入端产出它——其清单即告封闭，之后的类型正确地留在清单之外。
3. 执行态门禁放在 catalog 测试里：`KNOWN_SESSION_EVENT_TYPES ⊆ RELEASED_V2_EVENT_TYPES`（当前时代）。它守住此前无人看守的方向；v0 侧的测试早已断言过反方向（清单内每个类型都是已知类型）。未来某条相邻迁移边冻结新清单时，该断言在同一次变更中改指新清单。

拒绝策略本身不变：[released format migrations](../architecture/2026-08-31-released-session-format-migrations.zh.md) 依旧拒绝未知历史事件（即使可忽略），外部插件事件在恢复时依旧依赖 `ignorable` 标记。

## 已考虑的替代方案

- **在 v0 源校验中放行“未知但可忽略”的事件**：拒绝。对真正的外部类型，拒绝是刻意设计——迁移不得把任何构建都无法解读的事件悄悄带进一个已提交的世代。缺陷是缺失了一条第一方清单记录，而非拒绝策略本身。
- **用安装侧的 `KNOWN_SESSION_EVENT_TYPES` 校验 v0 源**：模糊了迁移边冻结的时代边界（词汇继续增长的后续构建会放行 v0 时代写入端不可能产出的类型），并把冻结边重新耦合到移动的当前包。词汇接纳仍留在恢复阶段，遵循迁移 note。
- **从事件映射生成清单**：dispositions 携带按类型手工确定的 payload 成员语义（required、optional、opaque），无法机械推导；它们在执行态覆盖测试之下继续人工维护。

## 后果

- 携带 pin 的 v0 存量会话可以迁移：源世代保持字节与 inode 不变，v2 后继世代在其旁发布。格式版本内的事件增长只要落入清单，就不再卡死迁移。
- 新增 `SessionEventMap` 成员而不扩展当前时代清单，现在会让 `pnpm test` 失败，而不是让生产加载失败。门禁随时代移动，冻结新边时必须同步改指。
- pin 状态不会到达 V4：[丢弃决策](../architecture/2026-09-23-drop-abandoned-v3-pin-events.zh.md) 在 V3→V4 边上就 `session/pin` 取代了本规则。
- 迁移路径现在对历史日志也强制布尔 `pinned` payload，而不只对新增追加生效。

## 测试

- `session-format-v0-to-v1`：清单规模钉在 52，每个冻结类型一份有效样例，携带 pin 的 v0 日志迁移后事件原样保留，非布尔 `pinned` 被拒绝。
- `session-format-v1-to-v2`：pin 事件穿越流嵌入后保持不变。
- `session-format-catalog`：安装词汇 ⊆ 最新清单的不变量，外加一条携带 pin 日志的完整 v0→v2 catalog 迁移。
- 把最初报错的会话复制到临时目录后，JSONL provider 能打开它并迁移到 v2、pin 事件完好、v0 字节未动。
