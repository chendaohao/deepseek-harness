# Adding a Typert Remote

English | [中文](adding-a-typert-remote.zh.md)

Reference for exposing a business Service's methods to the Web Client (or any isomorphic consumer) as a named Remote namespace on `ctx.remote.<ns>`. The architecture lives in the [Typert remote method calls note](../../.agents/notes/implemented/architecture/2026-08-02-typert-remote-method-calls.md), the generator's contract in its [README](../../packages/typert/generator/README.md), and the repository's worked example in `packages/remote/remote-access` (the `remoteAccessDevices` namespace).

## What a contribution is

A business Service marks the methods a consumer may call; Typert generates a Host-local reflection artifact and a platform-independent Remote consumer projection from the Host Program. The consumer mounts the projection through `@deepseek-ai/dsh-api-remotes` and calls the namespace as a service.

## The minimal contract

1. **Wire types live in `src/types.ts`** as plain interfaces — no Zod, no runtime imports. The generator emits the schema and the consumer contract from these public symbols.

2. **The Service extends `TypertRemoteService`** and names its namespace in `super(ctx, 'namespace')`. Each callable method is marked with `@Remote('wireName')` (or `@RemoteScope('scope', 'wireName')` for a receiver resolved in an isolated Context kind). Every parameter crossing the wire is declared in a top-level position.

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

3. **Declare `zod@^4.4.3` in `dependencies`.** The generated remote client imports `{ z }`; pnpm's strict layout links only declared packages, so an undeclared `zod` makes the generated artifact unresolvable at build and boot time.

4. **Publish the generated artifacts** in `package.json`:

```json
"./typert": { "types": "./lib/typert.host.d.ts", "default": "./lib/typert.host.js" },
"./remote": { "types": "./lib/typert.remote-client.d.ts", "default": "./lib/typert.remote-client.js" }
```

List both pairs in `files` as well. The generator validates exactly these shapes; a mismatch fails generation.

5. **Wire the client assembly.** In `packages/api/remotes/src/client/index.ts`, import the generated `/remote` projection and mount it alongside the other contributions, and add the package to `packages/api/remotes` dependencies. The Web Client's `ctx.remote.<ns>` then resolves the namespace.

6. **Rebuild with `pnpm run build:lib`.** The repository's Host tsdown seeds the generator with `tsconfig.host.json`, so the contribution must sit in the Host program's compiler face.

## Failure modes

- **Missing `zod` dependency.** The generated `typert.remote-client.js` imports Zod that pnpm never linked; the build breaks immediately. Add the dependency in the same change as the Remote.
- **Stale client bundle with an external `require("zod")`.** The browser module table (`packages/client/web/src/seed.ts`) resolves only platform packages; every other dependency must be inlined into the bundle (`packages/client/tsdown.client.ts` `noExternal`). A `lib/client.js` that predates the contribution leaves the external require and the page fails to load; rebuild with `pnpm run build:lib`.

## Tests

Each contribution ships a package-owned `./invariant` and a load/composition test that mounts the Remote through the Loader and asserts the generated projection resolves — see `packages/remote/remote-access/tests/access.spec.ts`.
