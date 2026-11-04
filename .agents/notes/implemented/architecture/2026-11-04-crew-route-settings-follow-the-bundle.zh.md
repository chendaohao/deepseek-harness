# Agent Note：编队路由设置块跟随编队 bundle

Status: implemented

[English](2026-11-04-crew-route-settings-follow-the-bundle.md) | 中文

## Problem

模型页对每个 web 部署都绘制三个路由区块——工人、规划者、审核者。每个区块编辑一个宿主设置命名空间，而 `@deepseek-ai/dsh-web-app` 无条件插入了这三个命名空间行。但这些设置只被 `@deepseek-ai/dsh-crew` 的委派行读取：从未选择编队 bundle 的部署提供了三项无人消费的设置，用户改完也看不到任何效果。三个区块还重复了标题、说明与同一份 rejected/conflict 文案，而每个控件的无障碍名只是"每个角色八条 locale 键"的副产品。新增第四个角色需要改命名空间常量、注入字段、包装组件、八种语言各八条键，以及一处渲染点。

## Decision

三个 `subagent-*-route-settings` 行放在 `@deepseek-ai/dsh-crew`，而不是 `dsh-web-app`。可见性因此是宿主的既有事实而非客户端开关：部署只有在选择了编队 bundle 时才服务某角色的命名空间，客户端对宿主未服务的命名空间不渲染任何内容。

客户端不需要新的门控。`ConfigFormController.derive()` 早已把"命名空间不在 describe 答复里"折成 `status: 'unavailable'`，页面据此不为该表单渲染内容。真正需要改的是区块层面"不渲染"的含义：页面先把角色表与自己快照携带的命名空间取交集，区块对空列表返回 `null`——否则没有编队 bundle 的部署会留下区块标题与说明，下面挂着一组空行。

`subagent-route-settings-registry` 留在 `dsh-web-app`。它是部署自行挂载角色行时所依赖的通用服务，而 v0.2.2-alpha.2 的迁移路径就是让运维自己挂这些行；把注册表搬走会让这类 profile 全部失效。编队 bundle 本来就必须排在 `dsh-web-app` 之后，其行仍能解析到该注册表。

角色表 `CREW_ROLES`（`packages/client/ui-settings-models/src/client/crew-routes.ts`）为每个角色指明命名空间与角色名文案键。页面由它派生出注入的 `crewRoutes` 句柄与各行，因此在客户端新增第四个角色只需一条表项加一条文案键。该角色另需其宿主行与委派行的 `routeSettingsNamespace`，那属于宿主组合，不在客户端的承诺范围内。

文案收敛为一套带 `{role}` 占位符的模板，而不是每角色一套。占位符正是让三个相同的选择器可区分的关键：每个控件的无障碍名是 `{role} 提供方`，因此该行在 DOM、读屏与浏览器 e2e 中都能按角色定位。去掉占位符会在一页上留下三个同名的 "provider" 选择框。

改提供方与改模型都会让其下方的字段失效，因此每次编辑都在同一次原子 `mutate()` 里写入这些字段：新提供方若也提供已存的模型则保留它，否则取其在目录中的第一个条目；推理等级跟随所得模型的词汇表，仍提供的档位保留，否则回退到该模型的默认档位。目录未描述的提供方或模型保留已存值，因为选择器会把它作为兜底选项显示，目录也说不出更好的取值。若编辑重置了某字段，该行会在自己的状态行里说明。

## Alternatives considered

**用 `ConfigForms.whileServed` 门控这些区块。** 那样就由客户端跟随已服务的命名空间，无需改动宿主。但 `whileServed` 对其命名空间列表是 `some` 语义，且只调用一次 `register` 回调，因此只能表达"其中任一被服务"，无法表达逐角色可见性，注册时捕获的服务集也会是过期快照。它还只修了缺陷的另一半：这些行仍会被服务给用不上它们的部署。

**把路由移出模型页，放进插件页。** `ui-settings-subagent` 对自己的页面就是这么做的，而且能彻底消除 `ModelsSectionInjected` 的增长。否决理由是它把"选模型"拆到两个入口；路由本就是模型选择，模型页才是用户会去找的地方。

**把三个宿主命名空间合成一个。** `verify-cordis-config` 要求每个路由设置入口 id 等于其 `config.namespace`，而持久化的 `subagent/worker-route` 标记记录了命名空间；共用一个命名空间会让规划者子会话解析到工人路由。三行保持独立。

## Consequences

从自己挂载过这些行的 profile 升级而来的部署，现在同一命名空间有两行，组合会以 `namespace "…" is already registered by another route-settings row` 失败。[升级指南](../../../../docs/upgrade-guide/v0.2.2-alpha.3/crew-route-settings-rows/guide.zh.md) 记录了迁移步骤。

`apps/cli/tests/web-agent-presets.e2e.ts` 双向断言：随附的 web 面不服务这三个命名空间中的任何一个，而选择编队 bundle 的 profile 三个全部服务且带各自的组合基线。`apps/web/tests/crew-routes.e2e.ts` 在真实 profile 上验证浏览器半边——一个区块内三行，且改提供方会带上其模型。
