# 远程接入

[English](remote-access.md) | 中文

远程接入能力：通过公网 HTTPS 隧道与手机配对进入本地 Web GUI。[`dsh-remote-tunnel`](../../packages/remote/remote-tunnel) 提供 `ctx.remoteTunnel` Service，启动固定版本且校验 SHA-256 的 cloudflared，每次 open 解析出一个 `RemoteTunnelSession` ——会话的公网 URL 与幂等清理——会话通过 `remote-tunnel/state` 报告状态。[`dsh-remote-access`](../../packages/remote/remote-access) 消费隧道与宿主 Web 服务器端口：配对密钥、仅监听 loopback 的反向代理及其配对闸门与 cookie，以及终端 URL + 二维码呈现。它不属于 agent loop；能力未启用时本机与局域网行为保持不变。

源码：[`packages/remote/remote-tunnel/src/index.ts`](../../packages/remote/remote-tunnel/src/index.ts) 与 [`packages/remote/remote-access/src/index.ts`](../../packages/remote/remote-access/src/index.ts)

## 会话状态

```ts type-equiv
/** Terminal or reporting facts about one tunnel session, discriminated by status. */
type RemoteTunnelState =
  | { status: 'open'; url: string }
  | { status: 'ended' }
  | { status: 'failed'; message: string }
```

```ts type-equiv
/** One live tunnel session: its public URL and its teardown. */
interface RemoteTunnelSession {
  /** Public HTTPS URL of the tunnel; stable from `open()` resolution to child exit. */
  readonly url: string
  /** Stop the tunnel child and await its exit; idempotent, safe after child exit. */
  close(): Promise<void>
}
```

会话在 URL 就绪时报告 `open`，子进程退出时报告 `ended`（URL 仍可读但已失效），启动尝试预算耗尽时报告 `failed`；`open()` 以最终 `failed` 相同的消息拒绝。二进制解析策略、校验过的下载以及配对/cookie 词汇详见两个包的 README。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxremotetunnel--remotetunnel"></a>

### `ctx.remoteTunnel` — `RemoteTunnel`

The remote-tunnel Service (`ctx.remoteTunnel`): resolves the cloudflared binary and opens tunnel sessions over the loopback port it is handed.

```ts cordis-catalog
/**
 * Open one tunnel session exposing the given loopback port.
 * @param port - loopback port the tunnel targets (the proxy or webserver port).
 * @returns the live session with its public URL; rejects after the attempt budget.
 */
async open(port: number): Promise<RemoteTunnelSession>
```

Source: [`packages/remote/remote-tunnel/src/index.ts:326`](../../packages/remote/remote-tunnel/src/index.ts)

<a id="remote-tunnel-events"></a>

### `remote-tunnel/*` events

<a id="remote-tunnelstate--emit"></a>

#### `remote-tunnel/state` — emit

One tunnel session reported a durable fact: its public URL became ready, its child exited, or a final spawn attempt failed. `open()` rejects with the same message a final `failed` state carries.

```ts cordis-catalog
/**
 * One tunnel session reported a durable fact: its public URL became ready,
 * its child exited, or a final spawn attempt failed. `open()` rejects with
 * the same message a final `failed` state carries.
 * @mode emit
 * @param state - the discriminated session fact.
 */
'remote-tunnel/state'(state: RemoteTunnelState): void
```

Source: [`packages/remote/remote-tunnel/src/index.ts:74`](../../packages/remote/remote-tunnel/src/index.ts)
<!-- END GENERATED cordis-surface -->

