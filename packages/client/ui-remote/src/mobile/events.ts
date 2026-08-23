/**
 * Live-event client for the mobile surface: one WebSocket downlink to the
 * platform `/api/events.mux` channel, parsing server-request envelopes and
 * fanning `session/event` frames out to subscribers. When the socket fails
 * (transport error or close — quick tunnels do not always forward WebSocket
 * upgrades), the client degrades to polling the observed session's history
 * over the ordinary HTTP channel and re-emits freshly appended events as
 * `session/event` frames, so listeners behave exactly as if the frames had
 * arrived live. Both the reconnect and the poll cadence back off on repeated
 * failure; a live frame from a fresh socket resumes streaming and drops the
 * fallback.
 */

import { history, type HistoryPage } from './api.ts'
import type { WireEvent } from './messages.ts'

/** One validated live frame this client fans out. */
export interface SessionEventFrame {
  type: 'session/event'
  sessionId: string
  event: WireEvent
}

/** The WebSocket subset this client uses (the browser WebSocket fits). */
export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
  close(): void
}

/** Injectable seams for tests. */
export interface EventsClientOptions {
  /** WebSocket factory (defaults to the browser WebSocket). */
  socketFactory?: (url: string) => WebSocketLike
  /** Fetch one history page (tail) for a session — the polling fallback's data source. */
  pollLatest?: (sessionId: string) => Promise<HistoryPage>
  /** Base poll cadence while the socket is down (default 3000 ms). */
  pollIntervalMs?: number
  /**
   * Idle watchdog: while the socket is open, if no frame arrives for this long,
   * the transport is treated as silently dead (a phone switching mobile data
   * <-> WiFi tears its TCP leg without a close frame) and the socket is recycled
   * into the polling fallback + reconnect path. The host heartbeat
   * (`stream/heartbeat` on the mux stream) resets the timer while idle, so a
   * firing watchdog means no frames at all — the exact silent-death case.
   * 0 disables the watchdog. Default 45000 ms (three 15 s heartbeat intervals).
   */
  idleTimeoutMs?: number
}

/** Browser default socket factory (the DOM WebSocket fits the narrow face). */
function browserSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike
}

/** Resolve the same-origin events.mux URL with the WS protocol scheme. */
function eventsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/events.mux`
}

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 15_000
const POLL_BACKOFF_MAX_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 3_000
/** Idle watchdog default: three 15 s host heartbeat intervals. */
const DEFAULT_IDLE_TIMEOUT_MS = 45_000
/** Poll window: enough recent events to cover a few seconds of agent output. */
const DEFAULT_POLL_PAGE_SIZE = 50

/**
 * Parse one WS frame into a session/event frame, or undefined when unrelated or malformed.
 * @param data - the raw frame payload.
 * @returns the parsed session/event frame, or undefined.
 */
export function parseFrame(data: unknown): SessionEventFrame | undefined {
  if (typeof data !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed['type'] !== 'server-request') return undefined
  const payload = parsed['payload']
  if (!isRecord(payload) || payload['type'] !== 'session/event') return undefined
  const sessionId = payload['sessionId']
  const event = payload['event']
  if (typeof sessionId !== 'string' || !isRecord(event)) return undefined
  const { type, seq, time } = event
  if (typeof type !== 'string' || typeof seq !== 'number' || typeof time !== 'number') return undefined
  return { type: 'session/event', sessionId, event: { type, seq, time, data: event['data'] } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Keep one mux subscription open, fanning validated session/event frames to
 * subscribers, with a history-polling fallback that keeps the open session
 * live when the socket cannot deliver.
 */
export class EventsClient {
  private readonly url: string
  private readonly socketFactory: (url: string) => WebSocketLike
  private readonly pollLatest: (sessionId: string) => Promise<HistoryPage>
  private readonly basePollIntervalMs: number
  private readonly idleTimeoutMs: number
  private readonly listeners = new Set<(frame: SessionEventFrame) => void>()
  private socket: WebSocketLike | undefined
  private stopped = false
  private observeSessionId: string | undefined
  private socketFailed = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private pollIntervalMs: number
  private polling = false
  /** Per-session highest event seq already emitted, for poll dedup. */
  private readonly pollWatermark = new Map<string, number>()

  /**
   * @param url - the mux endpoint (browser-relative default).
   * @param options - seams.
   */
  constructor(url = eventsUrl(), options: EventsClientOptions = {}) {
    this.url = url
    this.socketFactory = options.socketFactory ?? browserSocket
    this.pollLatest = options.pollLatest ?? (sessionId => history(sessionId, undefined, DEFAULT_POLL_PAGE_SIZE).then((result) => {
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }))
    this.basePollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.pollIntervalMs = this.basePollIntervalMs
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  }

  /** Open the stream (idempotent; the socket reconnects until {@link stop}). */
  start(): void {
    if (this.stopped) return
    if (this.socket === undefined) this.connectSocket()
  }

  /** Close for good. */
  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.clearIdleTimer()
    this.stopPolling()
    this.closeSocket()
    this.observeSessionId = undefined
  }

  /**
   * Subscribe to validated session/event frames; returns an unsubscribe function.
   * @param listener - receives each validated frame.
   * @returns an unsubscribe function.
   */
  onFrame(listener: (frame: SessionEventFrame) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Point the polling fallback at one open session (or `undefined` to stop
   * it). While the socket is down, this client polls that session's history
   * and re-emits new events as `session/event` frames.
   * @param sessionId - the session to poll, or undefined to stop polling.
   */
  observe(sessionId: string | undefined): void {
    this.observeSessionId = sessionId
    if (sessionId === undefined) {
      this.stopPolling()
      return
    }
    if (this.socketFailed && !this.polling && !this.stopped) this.startPolling()
  }

  private connectSocket(): void {
    if (this.stopped) return
    const socket = this.socketFactory(this.url)
    this.socket = socket
    // Arm the idle watchdog now, before open: a carrier that never establishes
    // the socket (a tunnel edge swallowing the upgrade) fires neither onopen
    // nor onerror, so without this the fallback would never start.
    this.touchIdle()
    socket.onopen = () => {
      this.reconnectAttempts = 0
      this.socketFailed = false
      this.touchIdle()
    }
    socket.onmessage = (event) => {
      // Any delivered frame (heartbeats included) proves the transport is
      // alive and resets the idle watchdog; a firing watchdog means no frames
      // at all — the silently-dead case onerror/onclose never report.
      this.touchIdle()
      const frame = parseFrame(event.data)
      if (frame === undefined) return
      // A delivered session/event frame proves the socket is live again — drop
      // any fallback polling so the live stream takes over without double delivery.
      if (this.polling) this.stopPolling()
      this.emit(frame)
    }
    socket.onerror = () => { this.handleSocketFailure() }
    socket.onclose = () => { this.handleSocketFailure() }
  }

  /**
   * Reset the idle watchdog: a fired watchdog recycles the socket into the
   * polling fallback + reconnect path, exactly as if the transport had closed
   * (the browser reports neither event for a silently torn TCP leg).
   */
  private touchIdle(): void {
    this.clearIdleTimer()
    if (this.stopped || this.idleTimeoutMs <= 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      this.handleSocketFailure()
    }, this.idleTimeoutMs)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private handleSocketFailure(): void {
    if (this.stopped) return
    if (this.socket === undefined) return
    this.clearIdleTimer()
    this.socketFailed = true
    this.closeSocket()
    if (this.observeSessionId !== undefined) this.startPolling()
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return
    const attempt = this.reconnectAttempts
    this.reconnectAttempts = attempt + 1
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connectSocket()
    }, delay)
  }

  private startPolling(): void {
    if (this.polling || this.stopped) return
    this.polling = true
    this.pollIntervalMs = this.basePollIntervalMs
    void this.pollTick()
    this.pollTimer = setInterval(() => { void this.pollTick() }, this.pollIntervalMs)
  }

  private stopPolling(): void {
    this.polling = false
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  /**
   * Fetch the latest history page for the observed session and re-emit any
   * event above the per-session watermark as a `session/event` frame.
   * Idempotent by seq: listeners never see a duplicate. A failure backs off
   * the cadence; a success resets it to the base interval.
   */
  private async pollTick(): Promise<void> {
    const sessionId = this.observeSessionId
    if (sessionId === undefined) {
      this.stopPolling()
      return
    }
    try {
      const page = await this.pollLatest(sessionId)
      let maxSeq = this.pollWatermark.get(sessionId) ?? -1
      for (const entry of page.events) {
        const event = entry.event
        if (event.seq <= maxSeq) continue
        maxSeq = event.seq
        this.emit({ type: 'session/event', sessionId, event })
      }
      this.pollWatermark.set(sessionId, maxSeq)
      if (this.pollIntervalMs !== this.basePollIntervalMs) {
        this.pollIntervalMs = this.basePollIntervalMs
        this.restartPollTimer()
      }
    } catch {
      // Transient (network, pairing); back off and let the next tick retry.
      if (this.pollIntervalMs < POLL_BACKOFF_MAX_MS) {
        this.pollIntervalMs = Math.min(this.pollIntervalMs * 2, POLL_BACKOFF_MAX_MS)
        this.restartPollTimer()
      }
    }
  }

  private restartPollTimer(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    if (this.polling && !this.stopped) {
      this.pollTimer = setInterval(() => { void this.pollTick() }, this.pollIntervalMs)
    }
  }

  private emit(frame: SessionEventFrame): void {
    for (const listener of this.listeners) {
      try {
        listener(frame)
      } catch {
        // A throwing subscriber must not break the emit loop.
      }
    }
  }

  private closeSocket(): void {
    this.clearIdleTimer()
    const socket = this.socket
    this.socket = undefined
    if (socket === undefined) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close()
    } catch {
      // Already closed.
    }
  }
}
