# Agent Note：web profile 的 fork 本地行改由 dsh-workspace-ext bundle 组合

Status: implemented

[English](2026-09-07-workspace-ext-bundle.md) | 中文

## 问题

fork 把自己的 session-pin 与 remote-access 插件直接挂进了随发行版交付的 `dsh-base` 和 `dsh-web-app` patch 文件及其依赖列表。于是上游 bundle 的每次编辑都携带与上游行为无关的合并面，而且 fork 的组合意图与上游拥有的行混不可分——相对 upstream 的 `git diff` 把"fork 增加了什么"混进了"上游在哪里组合"。

## 决策

新增 patch 载体 bundle `@deepseek-ai/dsh-workspace-ext`（`packages/bundle/workspace-ext`），以一个 insert 列表拥有四个 fork 本地行——`session-pin`、`remote-tunnel`、`remote-access`、`client-ui-remote`；web profile 模板把它列在 `dsh-web-app` 之后，因此它的行组合在完整的上游树之上。该 bundle 把四个被挂载插件精确声明为依赖（verify-cordis-config 要求行名出现在声明清单中），`apps/cli` 依赖该 bundle，使双锚解析与 module fallback 镜像都能到达它。`dsh-base` 与 `dsh-web-app` 恢复为上游内容，仅保留两处随既定上游 PR 收编的 fork 编辑：webserver 行的 compression/keep-alive 重述，以及 `startup.ts` 中 web 启动旗标族——被搬移的行经 `ctx.webStartup` 读取它们的方式一字未变。

产品组合与测试组合保持锁定：keyless web e2e scaffold、schedule-catalog 名册检查、assembled-jsdom 启动层、windows-shell 的 profile 初始化都叠加同一第三 patch 层；agent-preset 组合测试保留自己的合成 bundle 列表，因为它检验的是 preset 机制而非随发行版模板。

## 后果

已初始化过自定义 `web` profile 的部署需要一次性把 `@deepseek-ai/dsh-workspace-ext` 加进该 profile 的 `dsh.profile.bundles`：`normalizeShippedProfile` 只重写仍与随发行版模板元组一致的清单，追加过树外插件的 profile 保留自己的列表，其中覆盖被搬移行的 patch 行在 bundle 列出之前会 fail loud。今后 fork 本地的新 host 行应进入本 bundle 的 insert 列表，不再回到随发行版 patch。

## 备选方案

- **自定义 `$DSH_HOME` profile 树外命名本 bundle**：否决——双锚解析无法从 home profile 触达仓库内 workspace bundle（除非 profile 本地安装），且快照清单把 profile 名封闭在随发行版集合内，另立 profile 名会让测试组合与产品分叉。
- **立即改环境变量门控（`--remote` → `DSH_REMOTE`）以删除 `startup.ts` diff**：本次否决——旗标族将与 webserver 压缩改动一起上游化；保留旗标即保留 CLI 表层，也让被搬移的行保持逐字节一致。
- **由 ext bundle 重述 webserver 行的 config**：否决——后层的按 id 覆盖会替换目标行的整个 config，从而遮蔽未来的上游字段；该修改留在 `dsh-web-app`，直至上游化。
