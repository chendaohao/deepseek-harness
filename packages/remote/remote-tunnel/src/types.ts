/**
 * Client-safe type vocabulary of the remote-tunnel capability: the tunnel
 * state union and the cordis event it emits. Client-safe: nothing here reaches
 * a Host-only symbol, so a Client compilation face reads the same
 * `remote-tunnel/state` signature the Host emits.
 * @module @deepseek-ai/dsh-remote-tunnel/types
 */

/** Terminal or reporting facts about one tunnel session, discriminated by status. */
export type RemoteTunnelState =
  | { status: 'open'; url: string }
  | { status: 'ended' }
  | { status: 'failed'; message: string }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One tunnel session reported a durable fact: its public URL became ready,
     * its child exited, or a final spawn attempt failed. `open()` rejects with
     * the same message a final `failed` state carries.
     * @mode emit
     * @param state - the discriminated session fact.
     */
    'remote-tunnel/state'(state: RemoteTunnelState): void
  }
}
