/**
 * MobileConnection: owns the mux WebSocket downlink lifecycle — open, frame
 * delivery, and the reconnect policy. Linear backoff over a bounded attempt
 * budget (reset on success) mirrors the host-side remote-access tunnel reopen
 * policy; an exhausted budget lands on failed (the app then offers retry or
 * re-scan). needsPairing is owned by the controller: it surfaces when a unary
 * RPC answers 401, never from this stream loop.
 * @module @deepseek-ai/dsh-client-mobile
 */

import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { MobileApiClient } from './client.ts'
import type { ConnectionStatus } from './types.ts'

/** Stream consumer callbacks. */
export interface MobileConnectionCallbacks {
  /** One parsed mux frame, in arrival order. */
  onFrame(envelope: RpcRequest<MuxFrame>): void
  /** Transport state transitions. */
  onStatus(status: ConnectionStatus): void
}

/** Reconnect policy knobs. */
export interface MobileConnectionOptions {
  /** One frame delivered for the selected session. */
  client: MobileApiClient
  callbacks: MobileConnectionCallbacks
  /** Linear backoff step between attempts. */
  backoffStepMs?: number
  /** Attempt budget per stream lifetime; reset on a successful open. */
  maxAttempts?: number
}

const DEFAULT_BACKOFF_STEP_MS = 500
const DEFAULT_MAX_ATTEMPTS = 5

/** The mux stream opener plus its reconnect loop. */
export class MobileConnection {
  private readonly client: MobileApiClient
  private readonly callbacks: MobileConnectionCallbacks
  private readonly backoffStepMs: number
  private readonly maxAttempts: number
  private stopped = false
  private pumpActive = false
  private generation = 0
  private aborter: AbortController | null = null
  private attempts = 0
  private status: ConnectionStatus = 'connecting'

  /**
   * @param options - client, callbacks, and reconnect policy knobs.
   */
  constructor(options: MobileConnectionOptions) {
    this.client = options.client
    this.callbacks = options.callbacks
    this.backoffStepMs = options.backoffStepMs ?? DEFAULT_BACKOFF_STEP_MS
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  }

  /** Begin pumping the stream (no-op while a pump is already running). */
  start(): void {
    if (this.pumpActive) return
    this.stopped = false
    this.attempts = 0
    this.generation += 1
    this.publish('connecting')
    void this.pump()
  }

  /**
   * Stop the stream and the retry loop; a later start() begins a fresh budget.
   * Revoking the pump-active flag lets stop() -> start() restart immediately
   * while the dying pump is still suspended: its generation guard keeps it
   * from touching the fresh pump when it wakes.
   */
  stop(): void {
    this.stopped = true
    this.pumpActive = false
    this.aborter?.abort()
    this.aborter = null
  }

  /** Whether stop() has ended this pump (method read defeats narrowing across awaits). */
  private isStopped(): boolean {
    return this.stopped
  }

  private publish(status: ConnectionStatus): void {
    if (this.status === status) return
    this.status = status
    this.callbacks.onStatus(status)
  }

  private async pump(): Promise<void> {
    const generation = this.generation
    this.pumpActive = true
    try {
      await this.pumpLoop()
    } finally {
      // Only a pump of the current generation owns the flag: stop() then
      // start() may have spawned a newer pump whose liveness this exit must
      // not clear.
      if (generation === this.generation) this.pumpActive = false
    }
  }

  private async pumpLoop(): Promise<void> {
    while (!this.stopped) {
      const controller = new AbortController()
      this.aborter = controller
      try {
        for await (const envelope of this.client.events.mux({}, controller.signal, () => {
          // A readable stream resets the budget: the host reopens its tunnel
          // with the same policy, so a success on either side restarts both.
          this.attempts = 0
          this.publish('online')
        })) {
          this.callbacks.onFrame(envelope)
        }
        if (this.isStopped()) return
        if (!await this.scheduleRetry(new Error('the mux stream ended'))) return
      } catch (error) {
        // The downlink swallows malformed frames; this catch only sees
        // transport-level throws (e.g. a missing WebSocket implementation).
        /* v8 ignore next -- the throw happens synchronously on the pull, so stop() can never land between it and this guard */
        if (this.isStopped()) return
        if (!await this.scheduleRetry(error)) return
      }
    }
  }

  /** Whether the pump should try again (false = budget spent, stopped, or superseded). */
  private async scheduleRetry(cause: unknown): Promise<boolean> {
    this.attempts += 1
    if (this.attempts > this.maxAttempts) {
      console.error('[client-mobile] mux stream retries exhausted:', cause)
      this.publish('failed')
      return false
    }
    this.publish('reconnecting')
    const delay = this.backoffStepMs * this.attempts
    const generation = this.generation
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delay)
    })
    return !this.stopped && generation === this.generation
  }
}
