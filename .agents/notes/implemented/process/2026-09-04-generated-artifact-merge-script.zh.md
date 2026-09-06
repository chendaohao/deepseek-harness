# Agent Note: dev-workspace fork 的生成物合并脚本

Status: implemented

[English](2026-09-04-generated-artifact-merge-script.md) | 中文

## Problem

`dev-workspace` 分支每 1–3 天合并一次 `upstream/master`。upstream 变更最频繁的文件是生成器拥有的产物——各文档目录、模块图、`tsconfig.base.json` 的生成别名区域、生成的 `api-catalog.ts` 源码、`pnpm-lock.yaml` 和 `THIRD_PARTY_NOTICES.md`——而 fork 最有价值的工作在自己的包里。每次合并的大量时间都花在手工解决那些本就没有任何人手工编写的文件的冲突上，而且一次错误的单边选择（丢掉一个别名或 lockfile 条目）会在之后的构建或安装时才暴露。

## Decision

`scripts/merge-upstream.sh` 机械地解决生成器拥有的产物集合，从不自动处理手工编写的内容：

- 启动阶段：执行 `git merge --no-ff --no-commit <ref>`（默认 `upstream/master`），然后对每个生成物上的冲突（各目录与图文档、`cordis-api` 页、`apps/cli/composition.md`、生成的 TS 目录、`known-event-types.ts`、`pnpm-lock.yaml`、`THIRD_PARTY_NOTICES.md`），检出合并 ref 的一侧。`pnpm install` 和各 `gen-*` 生成器会为 fork 重建 ref 一侧缺失的内容。
- `tsconfig.base.json` 取 ref 一侧后，脚本在 `BEGIN generated package aliases` 标记上方重新注入 fork 的手写别名块。生成器不产出 `src/*` 通配符，且跳过声明名与目录名不一致的包，因此 `@deepseek-ai/dsh-mcp-client/src/*` 和 `dsh-client-ui-remote` 各条目无法再生。`--finish` 以幂等方式重注入（以注释行作哨兵），因为无冲突的合并会原样采用 ref 的文件。
- 配对记录冲突（`*.i18n.yaml`）走 `pnpm run resolve-translation-pairing-conflicts`；`dsh-translation-pairing` merge driver（[自动组合翻译配对记录](2026-08-08-automatic-translation-pairing-merges.zh.md)）已经在 `git merge` 内部解决其中的大多数。
- 其余未合并路径即手写冲突。脚本逐条打印并附各区域的提示（subsystem 区域、session-controller/gateway 漂移、web 测试、编译面、包清单）后以非零退出；操作者解决后用 `--finish` 重跑，执行 `pnpm install`、全部 `gen-*` 生成器、验证 fork 别名仍在、staging，并报告需要重新配对的翻译对。脚本从不提交，也从不放弃合并。

## Verification

脚本在一次性分支上对真实 upstream ref 完整演练：已同步的短路路径、未知 ref、无冲突的落后合并（生成物自动解决、别名块重注入、全部生成器执行、untracked 对比在 locale 下保持稳定），以及手写文档为唯一冲突的合并上的 `--finish` 重跑（手动队列带提示打印，生成与配对报告在重跑间一致）。

## Alternatives considered

**继续手工解决生成物冲突。** 保留完全的人工判断，但把合并时间花在没有任何人手工编写其内容的文件上，并且重新引入脚本已消除的"单边选择后陈旧"失败。

**为每个生成文件配置自定义 git merge driver。** driver 命令和配对 driver 一样保存在 worktree 本地配置中，且覆盖不了再生成这一半（在 `pnpm install` + `gen-*` 执行前，ref 一侧对 fork 包是陈旧的），包装脚本仍然必要；driver 只会增加一套机制而不会移除脚本。

**仅依赖 `git rerere`。** rerere 重放记录过的冲突解法，但每次合并的生成物都是整块更新（再生成内容、新目录条目），记录的 hunk 很少能匹配；rerere 保持开启，作为对手写冲突这一部分的补充。

## Consequences

合并的人力时间只花在真正的手写漂移上——目前是 session-controller/gateway 的 Session API 适配、subsystem 正文、web 测试和包清单——机械文件由一条命令解决。代价是多一套需要维护的清单：新增生成器、输出路径或手写别名时，必须同步扩展脚本中的生成物清单和 fork 别名块；清单过期时安全失败（文件落入手动队列，或别名检查大声报错），不会静默出错。
