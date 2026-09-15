# Fork 待做清单

> 2026-09-07 由 workspace-ext bundle 重构会话生成。fork 本地维护文件，不随上游 PR 提交。
> 配套决策文档：[upstream-fork-extraction 提案](.agents/notes/proposed/process/2026-09-07-upstream-fork-extraction.md)、
> [workspace-ext bundle 决定](.agents/notes/implemented/architecture/2026-09-07-workspace-ext-bundle.md)。

## 立即（本周）

- [ ] 分组提交当前工作区改动（约 77 个文件）：① bundle 重构（`packages/bundle/workspace-ext` + `profile.ts` + `apps/cli` 依赖 + scaffold/测试镜像）② 债务修复（版本对齐、空 invariant 摘除、remotes deps、README 不变量句子）③ 两份 Agent Note（implemented architecture + proposed process）
- [ ] 推送前按 `dsh-pre-push-checks` 技能选最小检查集（typecheck、verify-cordis-config、test:docs、聚焦测试已全绿）
- [ ] 清理本地 `backup/*` 分支（7 个 pre-merge 备份）与 origin 上陈旧的 master
- [ ] 其他部署若初始化过自定义 web profile：手动把 `@deepseek-ai/dsh-workspace-ext` 加进其 `dsh.profile.bundles`（本机已完成；见 workspace-ext 决定的 Consequences）

## 短期（上游抽取启动前）

- [ ] 向上游开 issue/discussion 确认两个设计意向：effort 归一化语义（"拒绝 → 降级" 变更了上游文档化的 no-clamping 决定）与 session-pin 的格式放行（上游当前 0 个 open issue，无撞车）
- [ ] 从冲突最小的 PR 3（web transport 优化，2026-08-21 的 web 传输改动）开始练手建立上游信任；冲突限于 web-app patch 行上下文与文档配对
- [ ] 修 `remote-access.e2e` 假失败：`fake-slug.trycloudflare.com` 依赖本机 DNS，改为 Playwright 路由拦截或环回别名（基线已证实与本机改动无关）
- [ ] 诊断 `session.client.spec` worker 终止超时（干净 HEAD 复现；用 `dsh-ci-test-reliability` 技能）

## 中期（UI 上游 PR 之前）

- [ ] `ui-remote` 拆分 host/client tsconfig face：其 host 半区（现为 inert `apply`）类型导入 connection 仅 host face 拥有的文件，face 门禁处方的 client-face 引用以 TS2878 破坏构建（本会话已验证）；这是 constraints/client-packages 门禁转绿的唯一路径
- [ ] 写 `scripts/fork-footprint.ts`：按类别统计 `git diff upstream/master...dev-workspace` 对上游既有文件的行数（新包目录排除），每次合并 upstream 后记录，防回涨

## 流程（持续执行）

- [ ] 接缝属主改动一律 upstream-first：先在基于 `upstream/master` 的分支写并开 PR，进了上游再合回 dev-workspace。适用面：`llm/llm`、`core/agent-loop`、`session` 格式清单、`api/remotes` 词汇、`client/*` 公共组件。fork-local 只写新包与纯新增行
- [ ] 每个 upstream release tag 合并一次，不攒（配合既有 `merge-upstream.sh` + generator 产物机械解决）
- [ ] 五步抽取按提案文档执行，每步限时并在开 PR 前立即变基；顺序：PR 3（web 传输）→ PR 2（input-modality，只取 llm 路径）→ PR 1（effort 降级，需按 v2 重实现，等 discussion 回音）→ PR 4（UI 修复，需先上游化 ui-primitives 前置包）
- [ ] session-pin 上游化按完整特性提案（插件 + 格式放行 + 置顶优先排序）；remote 栈只提议 wire 词汇转发的可扩展性，隧道与配对门保持 fork 本地

## 测试盲区（低优先级）

- [ ] 补置顶按钮的 apps/web e2e（当前 session-pin 的 UI 路径只有 fake 测试覆盖；等 ui-primitives 前置包立住后进既有场景）
- [ ] `apps/web/src/main.ts` 的 service worker 注册零覆盖（scaffold 层断言注册调用即可）
