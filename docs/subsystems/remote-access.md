# Remote Access

English | [中文](remote-access.zh.md)

The remote-access capability: a public HTTPS tunnel into the local Web GUI with phone pairing. [`dsh-remote-tunnel`](../../packages/remote/remote-tunnel) provides `ctx.remoteTunnel`, a Service that spawns a pinned, SHA-256-verified cloudflared release and resolves one `RemoteTunnelSession` per open call — the session's public URL plus idempotent teardown — while sessions report `remote-tunnel/state` facts. [`dsh-remote-access`](../../packages/remote/remote-access) consumes the tunnel and the host webserver port: the pairing secret, the loopback-only reverse proxy with its pairing gate and cookie, and the terminal URL + QR surface. It is not part of the agent loop; local and LAN behavior is unchanged while the capability stays disabled.

Source: [`packages/remote/remote-tunnel/src/index.ts`](../../packages/remote/remote-tunnel/src/index.ts) and [`packages/remote/remote-access/src/index.ts`](../../packages/remote/remote-access/src/index.ts)

## Session state

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

A session reports `open` once its URL is ready, `ended` when the child exits (the URL stays readable but dead), and `failed` when the spawn-attempt budget is spent; `open()` rejects with the same message a final `failed` carries. The binary resolution policy, the verified download, and the pairing/cookie vocabulary live in the two package READMEs.

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

