# 2026-08-29 — Remote-access pair bridge over the browser-auth fence, and the client-runtime shim row

- **Status**: Implemented (local deployment extension, not proposed upstream)
- **Area**: `packages/remote/remote-access`, `~/.dsh/profiles/web` composition

## Context

Upstream dsh 0.1.2-alpha.1 added Connection browser authentication (`client/connection/browser-auth.ts`): the webserver index and every `/api` route require a launch-token exchange or an authority-bound cookie (`dsh-auth-<hash(Host)>`). The remote-access pairing gate is an independent layer: it mints its own device cookie (`dsh_remote`) and rewrites forwarded requests' Host to the loopback bind. No bridge existed, so a paired tunnel visitor passed the gate and then stopped at the fence's 401 `dsh web authentication required` — only the desktop's printed `?token=` URL could mint the fence cookie.

The same release removed `@deepseek-ai/dsh-client-runtime` (Store refactor, `packages/client/store`). Four third-party profile plugins (`dsh-live-stats`, `dsh-pet`, `dsh-client-ui-web-ui-settings`, `dsh-client-ui-aionui-panel`) still `require("@deepseek-ai/dsh-client-runtime/client")` in their browser bundles, so the loader refused their entries.

## Decision

1. **Pair bridge** — `createAccessPolicy` accepts `indexLoginUrl?: () => string | undefined`; the pair exchange's 302 answers it instead of bare `/`. `RemoteAccess` injects `connection` and answers with `ctx.connection.authenticatedUrl(session.url)`, so the just-paired device's redirect carries the launch token through the tunnel and mints the fence cookie automatically. The connection face is typed structurally (`IndexLoginConnection`) to keep remote-access free of a package dependency.
2. **Runtime shim row** — `~/.dsh/fixes/dsh-client-runtime-shim/` is a plugin package named `@deepseek-ai/dsh-client-runtime` whose client bundle (tsdown closure-factory protocol, zustand + immer inlined) re-exports `createSnapshotStore` and `defineStore` from `packages/client/store/src/index.ts` — the module the removed runtime's `contract/store.ts` was moved into — plus a no-op `apply`, because the client kernel applies every graph entry's exports as a browser plugin through the cordis registry. Both factories are instance-per-call, so an inlined duplicate engine creates no shared-state divergence. The web profile patch inserts the row; the scanner publishes it under the removed package's name and the loader answers the plugins' `/client` subpath require.
3. **Upgrade cookie relay** — the proxy's WebSocket upgrade path dials the upstream webserver with the visitor's `Cookie` header attached (`proxy.ts`). The fence authenticates upgrades by the same authority cookie the relayed HTTP requests carry; an anonymous dial is rejected and tears the pair down right after the 101, which silently killed every tunneled stream (`/api/remote.mux`) and with it the browser's workspace roster and live events while unary requests kept working.

`web-ui-task-board` stays disabled in the profile patch: its host half injects the removed `apiProxy` service and the boot audit fails loud on it.

## Consequences

- A device pairs once through the tunnel URL and lands in the GUI; the fence cookie lasts `cookieMaxAgeDays` (default 30) and survives restarts because the signing secret persists in the credential store.
- Tunneled WebSockets now behave like tunneled HTTP requests: pairing gates the upgrade, the fence authenticates it, and the relay lives and dies with the device (the reauthorize interval still cuts revoked devices mid-stream).
- Both changes are local divergences from upstream: the next upstream merge conflicts on `remote-access/src/{index,policy}.ts`, and the shim plus the two profile patch rows should be dropped once the plugin authors ship builds against the new client API.
- The launch token travels in the pair redirect's URL; exposure stays behind the pairing gate, which every tunnel request must pass first.
