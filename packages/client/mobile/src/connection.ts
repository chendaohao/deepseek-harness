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
  /**
   * Idle watchdog: when a generation delivers no frame for this long, its
   * stream is aborted and the loop reconnects. The host heartbeat resets the
   * timer while the stream is quiet, so a firing watchdog means a silently
   * dead transport (a phone switching mobile data <-> WiFi can tear its socket
   * without any close event). 0 disables the watchdog.
   */
  idleTimeoutMs?: number
}

const DEFAULT_BACKOFF_STEP_MS = 500
const DEFAULT_MAX_ATTEMPTS = 5
/** Matches the web ConnectionController default; the host heartbeat (15s) keeps live streams from ever reaching it. */
const DEFAULT_IDLE_TIMEOUT_MS = 45_000

/** The mux stream opener plus its reconnect loop. */
export class MobileConnection {
  private readonly client: MobileApiClient
  private readonly callbacks: MobileConnectionCallbacks
  private readonly backoffStepMs: number
  private readonly maxAttempts: number
  private readonly idleTimeoutMs: number
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
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
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
      await this.pumpLoop(generation)
    } finally {
      // Only a pump of the current generation owns the flag: stop() then
      // start() may have spawned a newer pump whose liveness this exit must
      // not clear.
      if (generation === this.generation) this.pumpActive = false
    }
  }

  private async pumpLoop(generation: number): Promise<void> {
    while (!this.stopped) {
      const controller = new AbortController()
      this.aborter = controller
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const clearIdle = (): void => {
        if (idleTimer === undefined) return
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
      // Every frame (host heartbeats included) re-arms the watchdog; its
      // firing aborts this generation's stream, which the downlink surfaces
      // as a normal stream end and the shared retry path picks up.
      const touchIdle = (): void => {
        if (this.idleTimeoutMs <= 0) return
        clearIdle()
        idleTimer = setTimeout(() => { controller.abort() }, this.idleTimeoutMs)
      }
      try {
        for await (const envelope of this.client.events.mux({}, controller.signal, () => {
          // A readable stream resets the budget: the host reopens its tunnel
          // with the same policy, so a success on either side restarts both.
          this.attempts = 0
          this.publish('online')
          touchIdle()
        })) {
          touchIdle()
          this.callbacks.onFrame(envelope)
        }
        clearIdle()
        if (this.isStopped() || generation !== this.generation) return
        if (!await this.scheduleRetry(new Error('the mux stream ended'), generation)) return
      } catch (error) {
        // The downlink swallows malformed frames; this catch only sees
        // transport-level throws (e.g. a missing WebSocket implementation).
        clearIdle()
        // v8 ignore next -- the throw lands synchronously on the pull; stop()
        // and superseding start() both abort before the generator can resume
        if (this.isStopped() || generation !== this.generation) return
        if (!await this.scheduleRetry(error, generation)) return
      } finally {
        clearIdle()
      }
    }
  }

  /**
   * Whether the pump should try again (false = budget spent, stopped, or
   * superseded by a newer pump). The generation passed in is the pump's own
   * snapshot: a dying pump that resumes after stop() -> start() must not
   * adopt the fresh pump's generation and keep competing with it. Callers
   * re-check the generation before the backoff; the post-await check covers
   * a supersession that lands while the pump sleeps.
   */
  private async scheduleRetry(cause: unknown, generation: number): Promise<boolean> {
    this.attempts += 1
    if (this.attempts > this.maxAttempts) {
      console.error('[client-mobile] mux stream retries exhausted:', cause)
      this.publish('failed')
      return false
    }
    this.publish('reconnecting')
    const delay = this.backoffStepMs * this.attempts
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delay)
    })
    return !this.stopped && generation === this.generation
  }
}
