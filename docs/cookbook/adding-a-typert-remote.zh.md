# 新增 Typert Remote

[English](adding-a-typert-remote.md) | 中文

面向把业务 Service 的方法暴露给 Web 客户端（或任何同构消费者）作为 `ctx.remote.<ns>` 命名空间的手册。架构见 [Typert 远端方法调用笔记](../../.agents/notes/implemented/architecture/2026-08-02-typert-remote-method-calls.md)，生成器契约见其 [README](../../packages/typert/generator/README.md)，仓库的完整示例在 `packages/remote/remote-access`（`remoteAccessDevices` 命名空间）。

## 一份贡献是什么

业务 Service 标出消费者可调用的方法；Typert 从 Host 程序生成一份宿主侧反射工件和一份平台无关的 Remote 消费者投影。消费者通过 `@deepseek-ai/dsh-api-remotes` 挂载投影，并按 Service 方式调用命名空间。

## 最小契约

1. **线缆类型放在 `src/types.ts`**，使用纯接口——无 Zod、无运行时导入。生成器从这些公开符号生成 schema 与消费者契约。

2. **Service 继承 `TypertRemoteService`**，并在 `super(ctx, 'namespace')` 中命名自己的命名空间。每个可调用方法用 `@Remote('wireName')`（或在独立 Context 中解析接收者时用 `@RemoteScope('scope', 'wireName')`）标记。任何要跨线缆传递的参数都必须声明在顶层参数位置。

```ts
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'

interface RemoteDeviceList {
  devices: { deviceId: string; label: string }[]
}
declare const registry: { list(): RemoteDeviceList['devices'] }

export class AccessGateway extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'remoteAccessDevices')
  }

  @Remote('list')
  list(): RemoteDeviceList {
    return { devices: registry.list() }
  }
}
```

3. **在 `dependencies` 中声明 `zod@^4.4.3`。** 生成的远端客户端会导入 `{ z }`；pnpm 的严格布局只链接已声明的包，未声明的 `zod` 会让生成工件在构建和启动时都无法解析。

4. **在 `package.json` 中发布生成工件**：

```json
"./typert": { "types": "./lib/typert.host.d.ts", "default": "./lib/typert.host.js" },
"./remote": { "types": "./lib/typert.remote-client.d.ts", "default": "./lib/typert.remote-client.js" }
```

同样把这两对列出在 `files` 中。生成器只校验这些确切的形状；不匹配会导致生成失败。

5. **接线客户端装配。** 在 `packages/api/remotes/src/client/index.ts` 中导入生成的 `/remote` 投影并与其他贡献一起挂载，同时把该包加入 `packages/api/remotes` 的依赖。Web 客户端的 `ctx.remote.<ns>` 随即解析该命名空间。

6. **执行 `pnpm run build:lib` 重建。** 仓库的 Host tsdown 用 `tsconfig.host.json` 作为生成器种子，因此贡献必须位于 Host 程序的编译面内。

## 失败模式

- **缺少 `zod` 依赖。** 生成的 `typert.remote-client.js` 会导入 pnpm 从未链接的 Zod，构建立即失败。请在添加 Remote 的同一个改动中加上该依赖。
- **带外部 `require("zod")` 的过期客户端 bundle。** 浏览器模块表（`packages/client/web/src/seed.ts`）只解析平台包；其余依赖必须内联进 bundle（`packages/client/tsdown.client.ts` 的 `noExternal`）。早于该贡献生成的 `lib/client.js` 会留下外部 require 并导致页面加载失败；执行 `pnpm run build:lib` 重建。

## 测试

每份贡献都带包自有的 `./invariant` 与一个加载/组合测试，通过 Loader 挂载 Remote 并断言生成的投影可解析——参见 `packages/remote/remote-access/tests/access.spec.ts`。
