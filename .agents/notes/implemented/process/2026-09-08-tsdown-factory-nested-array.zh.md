# Agent Note：workspace tsdown 工厂不得再包一层共享预设的数组

Status: implemented

[English](2026-09-08-tsdown-factory-nested-array.md) | 中文

## Problem

`ui-remote` 的 `tsdown.config.ts` 工厂返回了 `[clientBundle(...)({ env })]`。`clientBundle(...)` 是 `BuildFaceConfig`——它自身调用后已返回 `UserConfig[]`；再把该数组包进另一层数组字面量，产出嵌套的 `UserConfig[][]`。tsdown workspace runner 接受该配置文件、打印其路径，然后对整个包什么也不产出：无错误、无构建输出、无产物。`pnpm run build:lib:client` "成功"而 `lib/client.js` 停在旧版，浏览器每次刷新远程面板拿到的都是旧 bundle。缺陷在单包日志里不可见，只能从 workspace 输出中缺失 `[@deepseek-ai/dsh-client-ui-remote/client]` 行来发现。

## Decision

**workspace tsdown 工厂返回扁平的 `UserConfig[]`；委托共享预设工厂时直接返回或展开其结果，绝不再包一层 `[]`。**

```ts ignore-check
// wrong: nested UserConfig[][]
export default (({ env }) => [clientBundle('id', ['lib/types/index.js'])({ env })])

// right: the preset factory's array is the config list
export default (({ env }) => clientBundle('id', ['lib/types/index.js'])({ env }))
```

朴素 `export default clientBundle(...)` 形式（多数 client 包，如 `ui-chat`）结构上免疫；工厂形式只在包需要按 face 分支时才用（如 host face 返回 `SKIP_WORKSPACE_BUILD`）。检测只需一行 Node 调用包配置：`factory({ env: { DSH_BUILD_FACE: 'client' } })` 必须产出元素全为配置对象而非数组的数组。

## Alternatives considered

- **让 workspace runner 自动展平一层嵌套**——否决：掩盖书写错误，且有展平合法配置值属性的风险；形状的闭集应保持严格。
- **加一个扫描所有包 tsdown 配置形状的门**——暂缓：八个包用工厂形式只有一个写错；只有工厂形式扩散后 lint 级结构检查才值得。

## Consequences

- 任何 client 包都可能因这一处 token 之差静默停止发布浏览器 bundle；症状是"构建绿色但 UI 改动永远不出现"。
- 恢复路径：改配置 → 重建 client 面 → 重启 `dsh web`（模块表在激活时读 `lib/client.js` 并缓存字节直到重启）。
- 审查 tsdown 配置工厂变更时：单独调用工厂确认返回数组扁平，或在构建日志中确认该包自己的 `[name]/client]` 输出行存在。

## Verification

`pnpm run build:lib:client` 同时输出 `[@deepseek-ai/dsh-client-ui-remote]`（node 半）与 `[@deepseek-ai/dsh-client-ui-remote/client]`（浏览器半）两行，且 `grep 有效期 packages/client/ui-remote/lib/client.js` 命中。浏览器面类型检查（`tsc -b tsconfig.client.json`）不受影响——缺陷是输出形状问题，不是类型问题。
