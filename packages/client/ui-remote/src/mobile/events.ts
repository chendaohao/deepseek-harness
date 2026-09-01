/**
 * Live-event client for the mobile surface: one WebSocket to the Gateway
 * remote-stream multiplexer (`/api/remote.mux`) running a `session/follow`
 * stream for the observed session. The opening snapshot feeds the chat tail
 * ({@link onSnapshot}); every appended event fans out as a `session/event`
 * frame ({@link onFrame}), so listeners behave identically to the pre-mux
 * broadcast. The stream is re-opened on every reconnect with a fresh snapshot;
 * there is no HTTP fallback — in the current host API the follow stream is the
 * only source of live events and the only grantor of the page cursor, so a
 * failed transport degrades to visible reconnect attempts, surfaced through
 * {@link onStatus}. Reconnect and the idle watchdog (a phone switching mobile
 * data <-> WiFi tears its TCP leg without a close frame) back off on repeated
 * failure.
 */

import { recordsToWireEvents } from './messages.ts'
import { muxCancel, muxOpen, parseMuxFrame, type WebSocketLike } from './mux.ts'
import type { WireEvent } from './messages.ts'

/** One validated live frame this client fans out. */
export interface SessionEventFrame {
  type: 'session/event'
  sessionId: string
  event: WireEvent
}

/** One follow opening snapshot, records already expanded to fold events. */
export interface SessionSnapshotFrame {
  type: 'session/snapshot'
  sessionId: string
  /** Inclusive log cut the snapshot was taken at (the session/page cursor). */
  cursor: number
  /** Whether older history exists beyond the snapshot records. */
  hasMore: boolean
  /** Projection baseline at the cursor (title, modelSelection, ...). */
  projections: { asOfSeq: number; values: Record<string, unknown> }
  /** The snapshot's message-aligned records, expanded to wire events. */
  records: WireEvent[]
}

/** Transport health of the multiplexer socket. */
export type EventsStatus = 'connecting' | 'open' | 'down'

/** Injectable seams for tests. */
export interface EventsClientOptions {
  /** WebSocket factory (defaults to the browser WebSocket). */
  socketFactory?: (url: string) => WebSocketLike
  /** Tail page size requested from the follow snapshot (default 30). */
  snapshotMaxMessages?: number
  /**
   * Idle watchdog: while the socket is open, if no frame arrives for this long,
   * the transport is treated as silently dead (a phone switching mobile data
   * <-> WiFi tears its TCP leg without a close frame) and the socket is
   * recycled into the reconnect path. The multiplexer sends WebSocket ping
   * control frames, which a browser cannot observe, so a firing watchdog means
   * no application frames at all. 0 disables the watchdog. Default 45000 ms.
   */
  idleTimeoutMs?: number
}

/** Browser default socket factory (the DOM WebSocket fits the narrow face). */
function browserSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike
}

/**
 * Resolve the same-origin remote-mux URL with the WS protocol scheme.
 * @returns the mux endpoint URL with the ws(s) scheme.
 */
export function muxUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/remote.mux`
}

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 15_000
/**
 * Idle watchdog default. The multiplexer pings every 30 s
 * (`websocketHeartbeatIntervalMs`), but as WebSocket control frames — a
 * browser cannot observe them, and the access proxy does not relay them as
 * application frames either — so they never reset this watchdog; 45 s of
 * application-frame silence is the dead-leg signal.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 45_000
const DEFAULT_SNAPSHOT_MAX_MESSAGES = 30

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Keep one `session/follow` stream open for the observed session, fanning the
 * opening snapshot and validated session/event frames to subscribers, and
 * reconnecting with backoff when the transport fails. The browser's foreground
 * return drives {@link resume} — the deterministic re-sync after a mobile OS
 * suspended the page.
 */
export class EventsClient {
  private readonly url: string
  private readonly socketFactory: (url: string) => WebSocketLike
  private readonly snapshotMaxMessages: number
  private readonly idleTimeoutMs: number
  private readonly listeners = new Set<(frame: SessionEventFrame) => void>()
  private readonly snapshotListeners = new Set<(snapshot: SessionSnapshotFrame) => void>()
  private readonly statusListeners = new Set<(status: EventsStatus) => void>()
  private socket: WebSocketLike | undefined
  private socketOpen = false
  private stopped = false
  private observedSessionId: string | undefined
  /** Session whose follow stream the current socket has open (a sent `open` counts). */
  private streamSessionId: string | undefined
  /** Stream id sent with the current logical stream; frames must match it. */
  private streamId: string | undefined
  private generation = 0
  private streamCounter = 0
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private lastSnapshot: SessionSnapshotFrame | undefined

  /**
   * @param url - the mux endpoint (browser-relative default).
   * @param options - seams.
   */
  constructor(url = muxUrl(), options: EventsClientOptions = {}) {
    this.url = url
    this.socketFactory = options.socketFactory ?? browserSocket
    this.snapshotMaxMessages = options.snapshotMaxMessages ?? DEFAULT_SNAPSHOT_MAX_MESSAGES
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  }

  /** Open the socket (idempotent; it reconnects until {@link stop}). */
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
    this.closeSocket()
    this.observedSessionId = undefined
    this.lastSnapshot = undefined
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
   * Subscribe to follow opening snapshots. The latest held snapshot (any
   * session) re-emits immediately on subscribe so a view mounting mid-generation
   * still receives its tail; a view filters by sessionId.
   * @param listener - receives each snapshot frame.
   * @returns an unsubscribe function.
   */
  onSnapshot(listener: (snapshot: SessionSnapshotFrame) => void): () => void {
    this.snapshotListeners.add(listener)
    if (this.lastSnapshot !== undefined) listener(this.lastSnapshot)
    return () => { this.snapshotListeners.delete(listener) }
  }

  /**
   * Subscribe to transport health changes: `connecting` on every dial, `open`
   * once established, `down` on each failure.
   * @param listener - receives each status change.
   * @returns an unsubscribe function.
   */
  onStatus(listener: (status: EventsStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  /**
   * Point the follow stream at one open session (or `undefined` to run no
   * stream). Switching cancels the previous stream and opens the next one on
   * the live socket; the socket itself stays connected across switches.
   * @param sessionId - the session to follow, or undefined to stop following.
   */
  observe(sessionId: string | undefined): void {
    if (sessionId === this.observedSessionId) return
    this.observedSessionId = sessionId
    if (this.socketOpen) this.syncStream()
  }

  /**
   * Force one fresh dial and follow re-open: the browser's foreground return
   * after the OS suspended the page. A suspended leg can drop frames or die
   * without a close event while still looking healthy, so any existing socket
   * is recycled, a pending backed-off dial is replaced by an immediate one,
   * and the fresh snapshot refolds idempotently over the fold watermark.
   */
  resume(): void {
    if (this.stopped) return
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.socket !== undefined) this.teardownSocket()
    this.connectSocket()
  }

  private connectSocket(): void {
    if (this.stopped) return
    const generation = ++this.generation
    const socket = this.socketFactory(this.url)
    this.socket = socket
    this.socketOpen = false
    this.emitStatus('connecting')
    // Arm the idle watchdog now, before open: a carrier that never establishes
    // the socket (a tunnel edge swallowing the upgrade) fires neither onopen
    // nor onerror, so without this the reconnect would never restart.
    this.touchIdle()
    socket.onopen = () => {
      if (generation !== this.generation) return
      this.reconnectAttempts = 0
      this.socketOpen = true
      this.emitStatus('open')
      this.touchIdle()
      this.syncStream()
    }
    socket.onmessage = (event) => {
      if (generation !== this.generation) return
      // Any delivered frame proves the transport is alive and resets the idle
      // watchdog; a firing watchdog means no frames at all — the
      // silently-dead case onerror/onclose never report.
      this.touchIdle()
      const frame = parseMuxFrame(event.data)
      if (frame === undefined || frame.streamId !== this.streamId) return
      if (frame.type === 'item') {
        this.handleItem(frame.value)
        return
      }
      // `end` (the host iterator completed) and `error` (the stream failed)
      // both end the logical stream; recycle the socket and dial again.
      this.handleSocketFailure()
    }
    socket.onerror = () => { if (generation === this.generation) this.handleSocketFailure() }
    socket.onclose = () => { if (generation === this.generation) this.handleSocketFailure() }
  }

  /** Cancel any open follow stream and open one for the observed session. */
  private syncStream(): void {
    if (this.socket === undefined || !this.socketOpen) return
    if (this.streamSessionId !== undefined) {
      muxCancel(this.socket, this.streamId as string)
    }
    this.streamSessionId = undefined
    this.streamId = undefined
    if (this.observedSessionId === undefined) return
    // A fresh id per logical stream: the host rejects a duplicate id while the
    // cancelled predecessor is still winding down.
    const streamId = `follow-${String(this.streamCounter += 1)}`
    this.streamId = streamId
    this.streamSessionId = this.observedSessionId
    muxOpen(this.socket, streamId, 'session/follow', {
      args: { request: { address: { kind: 'session', sessionId: this.observedSessionId }, maxMessages: this.snapshotMaxMessages } },
    })
  }

  /** Route one `item` frame value: a follow snapshot or an appended event entry. */
  private handleItem(value: unknown): void {
    const sessionId = this.streamSessionId
    if (sessionId === undefined) return
    if (!isRecord(value)) return
    if (value['type'] === 'snapshot') {
      const cursor = value['cursor']
      const projections = isRecord(value['projections']) && isRecord(value['projections']['values'])
        ? { asOfSeq: typeof value['projections']['asOfSeq'] === 'number' ? value['projections']['asOfSeq'] : 0, values: value['projections']['values'] }
        : { asOfSeq: 0, values: {} }
      const snapshot: SessionSnapshotFrame = {
        type: 'session/snapshot',
        sessionId,
        cursor: typeof cursor === 'number' ? cursor : -1,
        hasMore: value['hasMore'] === true,
        projections,
        records: recordsToWireEvents(value['records']),
      }
      this.lastSnapshot = snapshot
      for (const listener of this.snapshotListeners) this.safeCall(() => { listener(snapshot) })
      return
    }
    if (value['type'] !== 'event' || !isRecord(value['event'])) return
    const event = value['event']
    if (typeof event['type'] !== 'string' || typeof event['seq'] !== 'number' || typeof event['time'] !== 'number') return
    this.emit({ type: 'session/event', sessionId, event: { type: event['type'], seq: event['seq'], time: event['time'], data: event['data'] } })
  }

  /**
   * Reset the idle watchdog: a fired watchdog recycles the socket into the
   * reconnect path, exactly as if the transport had closed (the browser
   * reports neither event for a silently torn TCP leg).
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
    this.teardownSocket()
    this.scheduleReconnect()
  }

  /** Drop the current leg and stream bookkeeping, reporting the failure. */
  private teardownSocket(): void {
    this.clearIdleTimer()
    this.socketOpen = false
    this.streamSessionId = undefined
    this.streamId = undefined
    this.emitStatus('down')
    this.closeSocket()
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

  private emit(frame: SessionEventFrame): void {
    for (const listener of this.listeners) this.safeCall(() => { listener(frame) })
  }

  private emitStatus(status: EventsStatus): void {
    for (const listener of this.statusListeners) this.safeCall(() => { listener(status) })
  }

  /** Run one subscriber callback; a throwing subscriber must not break the emit loop. */
  private safeCall(run: () => void): void {
    try {
      run()
    } catch {
      // Subscriber faults stay local to the subscriber.
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
