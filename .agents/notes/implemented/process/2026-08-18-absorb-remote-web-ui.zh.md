# Agent Note: 将 @linxin666/dsh-remote-web-ui 吸收进一方案件 remote 家族

Status: implemented

[English](2026-08-18-absorb-remote-web-ui.md) | 中文

## Problem

web profile 装载了第三方插件 `@linxin666/dsh-remote-web-ui` 提供移动端远程控制：界面内面板（手机入口、二维码、实时状态、设备吊销）与 `/m` 小屏表面。它作为一套平行实现复制了一方案件 remote 家族的隧道与配对，自建 `/m/api` 协议，还捆绑了 `@linxin666/dsh-web-ui` 全家桶的一键更新。两套重叠的远程控制栈并存：一套产品自持、一套外部。

## Decision

**把移动端远程控制能力吸收为一方案件 `@deepseek-ai/dsh-client-ui-remote`，复用一方案件隧道与配对闸门；不移植平行基础设施。** host 配对闸门升级为设备模型（一次性 token、可吊销注册表、仅桌面 `/remote/*` 控制面）；桌面面板与 `/m` bundle 是走平台协议的新一方案件表面（见[设备模型](../architecture/2026-08-18-remote-device-model.zh.md)与[移动表面](../architecture/2026-08-18-mobile-surface-bundle.zh.md)两篇 note）。第三方的**远程更新功能不在范围**：更新第三方 UI 家族与远程访问无关，仍归厂商。

**卸载 `@linxin666/dsh-remote-web-ui` 是独立、需用户确认的步骤，不属于功能 PR 的一部分。** 它由 `@linxin666/dsh-web-ui-all` 聚合包传递引入，因此移除意味着在 profile 用户层禁用 `remote-web-ui` 行（`~/.dsh/profiles/web/cordis.patch.yml` 中 `- disable: remote-web-ui`），不碰聚合包其他插件（skins、ssh、pet、live-stats 等）。确认门槛的存在是因为聚合包是外部的、且该 profile 归用户所有。

## Consequences

第三方在用户批准禁用前保持安装；一方案件面板与 `/m` 表面已与它共存于 profile。其 `api/gate` 监听（用于 LAN 配对栅栏）目前是 no-op——平台没有 `api/gate` 事件——因此那里无行为变化。以功能体验与第三方等价作为吸收的验收线。

## Alternatives considered

- **让第三方复用一方案件基础设施** —— 维持所有权分裂、留下两套配对存储；因远程控制是产品核心且一方案件已拥有隧道与闸门而否决。
- **在功能 PR 里立即卸载** —— 聚合包是外部且用户所有的；未经确认强制移除会破坏 profile 其他插件或让用户措手不及。
