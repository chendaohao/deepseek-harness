# Agent Note: 通过变基后逐冲突解决的 PR 分支抽取 fork 的可上游化改动

Status: proposed

[English](2026-09-07-upstream-fork-extraction.md) | 中文

## 问题

`dev-workspace` 自上次上游合并基点以来累积了约 85 个 fork 提交、452 个文件，且两侧共同演化：upstream 发布了 0.1.2-rc.1 到 0.1.3-alpha.1，fork 则构建了远程栈、移动端 UI 与会话置顶。fork 与 upstream 的编辑如今在同一区域重叠，因此 fork 的改动无法靠 cherry-pick 提交上游。对 reasoning-effort 提交（`87e95da357`）的试抽取在 `packages/core/agent-loop/src/agent.ts` 三方合并冲突：upstream 的 v2 embedded-assistant-streams 重构（2026-09-01）重写了降级重试所修补的同一区域；web 传输提交（`2ccf8bd2c0`）在 web-app patch 行与文档配对上冲突。没有明确策略，fork 将永久背负约 3.1k 行的 client-UI 合并面加上接缝属主 diff。

## 提案

分五步有序抽取，每步都是基于 `upstream/master` 的分支，开 PR 前用自己的聚焦测试验证。产生下方冲突清单的配方：从 `upstream/master` 建分支，只对可上游化路径应用提交自身 diff（`git diff <commit>^ <commit> -- <paths> | git apply -3`），解决冲突，跑被触及包的测试与文档门禁。

1. **LLM effort 归一化 + 循环降级（重新实现）。** 把 `87e95da357` 的意图移植到 v2 embedded-streams 循环：将 last-resort effort 降级重试（`isEffortRejection`、`dropReasoningEffort`、每步一次重试）重新安放到 upstream 当前 `agent-loop/src/agent.ts` 的请求失败路径；`llm/llm` 的 `resolveCallConfig` 归一化、`llm-pi-ai` 的规范回退、adapter 测试与三个 feature notes 在重新锚定文档后可直接复用。范围外：fork 的 `ui-model-selection`/`ui-remote` 对降级状态的呈现。
2. **Input-modality 声明（选择性路径）。** 从 `ae6bd16f8d` 只取 `packages/llm/**` 与子系统文档；Models-editor 的改动块等待第 4 步的 client-UI 抽取，因为 `ui-settings-models` 已 fork 分叉。
3. **Web 传输优化（单一特性）。** Cherry-pick `2ccf8bd2c0`（webserver 压缩 `auto` + keep-alive、静态资源缓存、service worker、传输下行压缩）；冲突限于 web-app patch 行上下文与文档配对——用 upstream 当前文本重述该行解决。
4. **Client-UI 修复（先提前置）。** 移动端 composer/popups/scrollport 提交依赖 fork 新增的 `ui-primitives` 包；先提议该包，再把修复提交（`8540d115f1`、`3694cf98b7`、`35069a5ead`、`ee1791f205` 等）变基上去。
5. **特性级决策，被接受前保持 fork 本地。** `session-pin`（插件 + `session/pin` 格式放行 + 置顶优先排序）作为完整特性提议上游；remote 栈只提议 wire 词汇转发的可扩展性，隧道与配对门保持 fork 本地。

fork 专属债务不阻塞上述工作，但应在 UI PR 之前落地：把 `ui-remote` 拆分出 host/client tsconfig face（其 host 半区类型导入了 connection 仅 host face 拥有的类型，face 门禁处方的 client-face 引用会以 TS2878 破坏构建），并把 `/m` 移动表层 56 处硬编码字符串接入 locale 词典。

## 备选方案

- **永久保持一切 fork 本地。** 合并面随每次 upstream 发售增长，接缝 diff（effort 语义、格式放行）不可维护；否决，因为 fork 的多数价值是通用的。
- **无冲突甄别的机械 cherry-pick 流水线。** 本会话已试：产出无法构建或编码了 upstream 从未拥有的 fork 上下文的分支；否决，改为逐 PR 冲突解决。
- **以补丁绗缝方式叠在 upstream 标签上而非分支。** 能让 fork 继续工作但没有东西变得可上游评审；否决，因为评审才是目的。

## 验收标准

每步以分支交付，且在 `upstream/master` 上 `pnpm run typecheck`、被触及包的测试与 `pnpm run test:docs` 全部通过；开启的 PR 保持 CI 绿色；全部完成后 `git diff upstream/master...dev-workspace` 收敛为组合 bundle、未被接受的特性工作与 fork 专属包。

## 风险

upstream 可能重塑或拒绝部分内容（effort 归一化语义改变了已被文档化的拒绝行为）；v2 流的移植可能偏离 fork 已测行为，因此循环的 recorded-snapshot 通道必须覆盖它；抽取工作随 upstream 推进而腐化，所以每步限时并在开 PR 前立即变基。
