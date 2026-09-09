# Agent Note：让 fork 的 codegraph source kind 通过 V2→V3 迁移

Status: implemented

[English](2026-09-09-codegraph-source-kind-v2-v3-migration.md) | 中文

## Problem

0.1.5-alpha.1 合并后，打开任何 V2 日志里含 codegraph 注入清单消息的会话都报 `failed to observe session ...: cannot safely transform unclassified message source (gateway/internal)`——整个工作区的历史在所有客户端都打不开。

upstream 的 `session-format-v2-to-v3` 迁移器用封闭词表（`payload.ts` 的 `SOURCE_KINDS`）校验每条被迁移的消息 source。fork 的 codegraph 插件（`packages/codegraph`）往 `user/message` 的 source 里写自己合并可扩展的 `MessageSourceMap` kind——`codegraph-instructions`，而 V2→V3 迁移对 `user/message`、`assistant/message`、`tool/result`、inbox splice、title LLM 请求都断言 source。fork 的 V2 日志因此带着 upstream 从未见过的 kind，合并调和漏掉了这个扩展：source 在迁移中原样透传，但准入检查在透传前就拒绝了它。

复现：把真实会话的 V2 日志喂给 `assertEvent(…, 2)`，恰好拒绝一个事件（`user/message` seq 332，`codegraph-instructions`）；修复后整个 artifact 完成 v2→v3 迁移（659 事件进、663 出，含 system head 提升）。

## Decision

**让迁移准入认识 fork 的 kind——带形状校验，不是盲目放行。** `payload.ts` 把 `codegraph-instructions` 加进 `SOURCE_KINDS`，`assertSource` 增加一个分支，镜像既有 `agent-message` 的先例：`keys(source, ['kind', 'form'])` 且 `form` 必须是 `'instructions'`，与 `packages/codegraph` 的 `CodegraphInstructionSource` 契约一致。

V3 侧无需改动：codec 的 `MessageSourceMap` 合并可扩展，Trajectory 投影按持久 kind 字符串渲染未知 kind（`trajectory-event-projection.ts` 的 default 分支）。

## Alternatives considered

- **迁移时剥离或改写 source**——否决：released 格式迁移绝不移动、覆写或重新解释已提交的历史；这个 kind 是清单消息的持久身份。
- **旧 V2 会话不迁移、只放行新会话**——否决：相邻迁移策略要求每份旧日志都到达 V3；拒绝一个 fork 写入的消息 kind 等于把整个会话锁在门外。

## Consequences

- 含 codegraph 注入消息的 fork V2 会话全部干净迁移；不含的会话不受影响。
- kind 清单保持封闭：未来 fork 插件新增 `MessageSourceMap` kind 时必须在同一次变更里扩展这份准入清单（类型层的 `MessageSourceMap` 合并到不了这个 JSON 层校验）。
- 携带 `source: { kind: 'fallback' }` 的 `session/title` 事件不受影响：`assertSource` 不对 `session/title` 运行（它审计的是 Harness 消息，不是标题来源）。

## Verification

`tests/admission.spec.ts` 新增正路径（V2 `codegraph-instructions` 迁移通过，source 原样进入 V3 artifact）与畸形形状拒绝（错误 `form`、多余字段 → `codegraph-instructions source` 报错）。session 域全套（1613 测试）与 keyless 录制会话快照回放（127 测试）通过；此前失败的真实会话经 released 的 `sessionFormatV2ToV3` stage 完成端到端迁移。
