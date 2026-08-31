---
description: "面向用户与维护者的日志会话置顶说明，用于选择置顶服务或排查置顶顺序。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-pin

[English](README.md) | 中文

## 概述

`dsh-session-pin` 为列表界面提供每个会话的持久置顶位：`setPin(session, pinned)` 追加一条仅记录日志的 `session/pin` 事件，并返回折叠后的 `SessionPinSnapshot`（`pinned`、`eventSeq`、`updatedAt`）。`pinned` 投影（对 `session/pin` 事件的 last-wins 折叠）向列表行提供置顶状态；冷会话与 `title`、`sessionListMetadata` 一样通过投影缓存获得。置顶状态随会话事件日志保存，重启与重放后依然存在；分叉会话继承种子前缀中的置顶状态。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="model-experience"></a>
## 模型体验

### 会话置顶状态

#### 模型看到什么

无。`session/pin` 仅记录日志，不进入会话面、模型提示词、工具 schema 或请求前缀。

#### Token 影响

`setPin` 不向主 agent 请求添加任何 token。

#### KV 缓存影响

无；置顶事件不改变重建的消息内容或缓存键。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 置顶是面向人的操作，没有模型工具暴露它。
- 服务直接追加事件；需要幂等的调用方先读折叠状态（重复追加当前值无害）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

无。

</details>
