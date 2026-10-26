/**
 * The run chip's branch reads: one request per call, keyed by the viewed
 * Session, cancelled with the plugin and dropped when the connection is
 * replaced. The chip is read-only — this store never changes a branch.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { chatBranchUrl, isChatBranch, type ChatBranch } from '../../branch.ts'

/** A branch answer, `'missing'` when the Host has none to serve, or `'loading'` while the request runs. */
export type BranchChipState = ChatBranch | 'missing' | 'loading'

/** One browser plugin's branch reads, keyed by the viewed Session. */
export class BranchChipStore {
  /** Session ids key the answer; a new run of the same Session reads again. */
  readonly state = createSnapshotStore<Record<string, BranchChipState | undefined>>({})
  private readonly lifetime = new AbortController()
  /** Connection generation: a reset abandons reads that would answer for a replaced Host. */
  private generation = new AbortController()
  private readonly pending = new Set<Promise<void>>()

  /**
   * Read one Session's current branch, replacing a standing answer.
   * @param sessionId - viewed Session.
   * @returns after the answer is published.
   */
  async load(sessionId: SessionId): Promise<void> {
    if (this.lifetime.signal.aborted) return
    const key = String(sessionId)
    const signal = AbortSignal.any([this.lifetime.signal, this.generation.signal])
    this.state.update((state) => { state[key] = 'loading' })
    const task = this.read(sessionId, key, signal)
    this.pending.add(task)
    try {
      await task
    } finally {
      this.pending.delete(task)
    }
  }

  /** Forget every answer on connection replacement. */
  reset(): void {
    this.generation.abort()
    this.generation = new AbortController()
    this.state.set({})
  }

  /** Cancel outstanding reads, drop every answer, and wait until none can publish. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.all(this.pending)
    this.state.set({})
  }

  private async read(sessionId: SessionId, key: string, signal: AbortSignal): Promise<void> {
    let next: BranchChipState = 'missing'
    try {
      const response = await fetch(chatBranchUrl(sessionId), { signal })
      if (response.ok) {
        const value: unknown = await response.json()
        if (isChatBranch(value)) next = value
      }
    } catch {
      // A transport failure leaves no chip; the next run reads again.
      next = 'missing'
    }
    if (!signal.aborted) this.state.update((state) => { state[key] = next })
  }
}
