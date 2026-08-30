/** Browser owner for the Gateway multiplexed Remote stream socket. */

import {
  parseRemoteStreamServerMessage,
  REMOTE_STREAM_MUX_PATH,
  type RemoteStreamClientMessage,
  type RemoteStreamServerMessage,
} from '../stream-protocol.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

const INTERNAL_BASE = 'http://dsh.internal'
const RECONNECT_BASE_MS = 500
const RECONNECT_FACTOR = 2
const RECONNECT_MAX_MS = 10_000

/** One Host-reported Remote stream failure. */
export class RemoteStreamError extends Error {
  /** Stable carrier or Gateway error category. */
  readonly code: string
  /** Host-provided structured failure context. */
  readonly details: object

  /**
   * @param code - stable Gateway or business error category.
   * @param message - Host-provided failure description.
   * @param details - Host-provided structured failure context.
   */
  constructor(code: string, message: string, details: object) {
    super(message)
    this.name = 'RemoteStreamError'
    this.code = code
    this.details = details
  }
}

/** Physical Remote stream socket failure that may be retried by a domain transport. */
export class RemoteStreamCarrierError extends Error {
  /**
   * @param message - physical carrier failure description.
   * @param options - optional causal error.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteStreamCarrierError'
  }
}

interface SocketWaiter {
  resolve(socket: WebSocket): void
  reject(error: unknown): void
}

/** Keep one physical WebSocket and share it among independently cancellable Remote streams. */
export class RemoteStreamMuxClient {
  private socket: WebSocket | undefined
  private cancelCandidate: ((error: Error) => void) | undefined
  private keepAlive: Promise<void> | undefined
  private keepAliveAbort: AbortController | undefined
  private readonly streams = new Map<string, StreamInbox>()
  private readonly waiters = new Set<SocketWaiter>()
  private running = false
  private disposed = false

  /** Start the persistent physical connection; repeated calls are inert. */
  start(): void {
    if (this.running || this.disposed) return
    this.running = true
    this.maintain()
  }

  /**
   * Open one logical stream on the persistent physical connection.
   * @param endpoint - Typert Remote stream endpoint.
   * @param payload - endpoint request encoded on the wire.
   * @param signal - cancellation for this logical stream.
   * @returns Host items until completion, cancellation, or failure.
   */
  async *open(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ): AsyncGenerator {
    this.start()
    signal.throwIfAborted()
    const streamId = randomUUID()
    const inbox = new StreamInbox()
    let carrier: WebSocket | undefined
    let opened = false
    let terminal = false
    const abort = (): void => { inbox.fail(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const socket = await this.waitForSocket(signal)
      signal.throwIfAborted()
      carrier = socket
      this.streams.set(streamId, inbox)
      this.send(socket, { type: 'open', streamId, endpoint, payload })
      opened = true
      while (true) {
        const frame = await inbox.next()
        signal.throwIfAborted()
        if (frame.type === 'item') {
          yield frame.value
          continue
        }
        terminal = true
        if (frame.type === 'error') {
          throw new RemoteStreamError(frame.error.code, frame.error.message, frame.error.details)
        }
        return
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.streams.delete(streamId)
      if (opened && !terminal && carrier?.readyState === WebSocket.OPEN) {
        this.send(carrier, { type: 'cancel', streamId })
      }
    }
  }

  /**
   * Permanently stop reconnecting, close the physical socket, and fail every active logical stream.
   * @returns once the background connection loop has stopped.
   */
  async close(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true
      this.running = false
      const error = new Error('api gateway: Remote stream client disposed')
      this.keepAliveAbort?.abort(error)
      this.keepAliveAbort = undefined
      this.failAll(error)
      for (const waiter of [...this.waiters]) waiter.reject(error)
      this.cancelCandidate?.(error)
      const socket = this.socket
      this.socket = undefined
      socket?.close(1000, 'disposed')
    }
    await this.keepAlive
  }

  /**
   * Force one fresh physical socket: the browser's foreground return on a
   * phone web. A suspended page's TCP leg can drop frames or die without a
   * close event while still looking healthy, so any live socket is recycled —
   * its logical streams fail with a carrier error and their domain
   * supervisors reopen with fresh snapshots — and a hung dial is cut so the
   * reconnect loop redials instead of waiting for events a swallowed upgrade
   * never fires.
   */
  resume(): void {
    if (this.disposed) return
    const socket = this.socket
    if (socket === undefined) {
      this.cancelCandidate?.(new RemoteStreamCarrierError(
        'api gateway: Remote stream dial superseded by foreground resync',
      ))
      return
    }
    const error = new RemoteStreamCarrierError(
      'api gateway: Remote stream socket recycled on foreground return',
    )
    this.socket = undefined
    this.failAll(error)
    socket.close(4001, 'foreground resync')
    this.maintain()
  }

  private connect(): Promise<WebSocket> {
    const socket = new WebSocket(remoteStreamUrl())
    const connecting = new Promise<WebSocket>((resolve, reject) => {
      let settled = false
      const rejectCandidate = (error: Error): void => {
        settled = true
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('message', received)
        socket.removeEventListener('close', closed)
        this.cancelCandidate = undefined
        socket.close()
        reject(error)
      }
      const opened = (): void => {
        settled = true
        this.cancelCandidate = undefined
        this.socket = socket
        for (const waiter of [...this.waiters]) waiter.resolve(socket)
        resolve(socket)
      }
      const failed = (): void => {
        if (!settled) {
          rejectCandidate(new RemoteStreamCarrierError(
            'api gateway: Remote stream WebSocket failed to open',
          ))
          return
        }
        const error = new RemoteStreamCarrierError('api gateway: Remote stream WebSocket failed')
        this.lost(socket, error)
        socket.close()
      }
      const closed = (): void => {
        if (!settled) {
          rejectCandidate(new RemoteStreamCarrierError(
            'api gateway: Remote stream WebSocket closed before opening',
          ))
          return
        }
        this.lost(socket)
      }
      const received = (event: MessageEvent): void => { this.receive(socket, event.data) }
      this.cancelCandidate = rejectCandidate
      socket.addEventListener('open', opened, { once: true })
      socket.addEventListener('error', failed, { once: true })
      socket.addEventListener('message', received)
      socket.addEventListener('close', closed, { once: true })
    })
    return connecting
  }

  private waitForSocket(signal: AbortSignal): Promise<WebSocket> {
    signal.throwIfAborted()
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket)
    if (this.disposed) return Promise.reject(new Error('api gateway: Remote stream client disposed'))
    this.start()
    return new Promise((resolve, reject) => {
      const aborted = (): void => { waiter.reject(signal.reason) }
      const cleanup = (): void => {
        this.waiters.delete(waiter)
        signal.removeEventListener('abort', aborted)
      }
      const waiter: SocketWaiter = {
        resolve: (socket) => {
          cleanup()
          resolve(socket)
        },
        reject: (error) => {
          cleanup()
          // AbortSignal.reason belongs to the caller and may intentionally be a non-Error sentinel.
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          reject(error)
        },
      }
      this.waiters.add(waiter)
      signal.addEventListener('abort', aborted, { once: true })
    })
  }

  private receive(socket: WebSocket, data: unknown): void {
    if (socket !== this.socket) return
    try {
      if (typeof data !== 'string') throw new Error('api gateway: Remote stream WebSocket requires text messages')
      const frame = parseRemoteStreamServerMessage(data)
      this.streams.get(frame.streamId)?.push(frame)
    } catch (error) {
      const failure = new RemoteStreamCarrierError('api gateway: invalid Remote stream frame', { cause: error })
      this.failAll(failure)
      this.lost(socket, failure)
      socket.close(4002, 'invalid Remote stream frame')
    }
  }

  private lost(
    socket: WebSocket,
    error: RemoteStreamCarrierError = new RemoteStreamCarrierError(
      'api gateway: Remote stream WebSocket closed',
    ),
  ): void {
    if (this.socket !== socket) return
    this.socket = undefined
    this.failAll(error)
    this.maintain(error)
  }

  private maintain(previousFailure?: Error): void {
    if (!this.running) return
    if (this.keepAlive !== undefined) {
      void this.keepAlive.then(() => { this.maintain(previousFailure) })
      return
    }
    const abort = new AbortController()
    this.keepAliveAbort = abort
    const task = this.reconnect(abort.signal, previousFailure)
    this.keepAlive = task
    void task.then(() => {
      this.keepAlive = undefined
      this.keepAliveAbort = undefined
    })
  }

  private async reconnect(signal: AbortSignal, previousFailure?: Error): Promise<void> {
    let attempt = 0
    let failure = previousFailure
    while (this.isRunning(signal) && this.socket?.readyState !== WebSocket.OPEN) {
      if (failure !== undefined) {
        attempt += 1
        console.warn(`[api-gateway] Remote stream connection unavailable, retry #${String(attempt)}`, failure)
        await sleep(backoffDelay(attempt), signal)
        if (!this.isRunning(signal)) return
      }
      try {
        await this.connect()
        return
      } catch (error) {
        if (!this.isRunning(signal)) return
        failure = error as Error
      }
    }
  }

  private isRunning(signal: AbortSignal): boolean {
    return this.running && !signal.aborted
  }

  private failAll(error: unknown): void {
    for (const stream of this.streams.values()) stream.fail(error)
  }

  private send(socket: WebSocket, message: RemoteStreamClientMessage): void {
    socket.send(JSON.stringify(message))
  }
}

function backoffDelay(attempt: number): number {
  const cap = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * RECONNECT_FACTOR ** Math.max(0, attempt - 1))
  return cap / 2 + Math.random() * (cap / 2)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

class StreamInbox {
  private readonly frames: RemoteStreamServerMessage[] = []
  private wake: (() => void) | undefined
  private failure: Error | undefined

  push(frame: RemoteStreamServerMessage): void {
    if (this.failure !== undefined) return
    this.frames.push(frame)
    this.wake?.()
    this.wake = undefined
  }

  fail(error: unknown): void {
    if (this.failure !== undefined) return
    this.failure = error instanceof Error ? error : new Error(String(error), { cause: error })
    this.frames.length = 0
    this.wake?.()
    this.wake = undefined
  }

  async next(): Promise<RemoteStreamServerMessage> {
    while (this.frames.length === 0) {
      if (this.failure !== undefined) throw this.failure
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
    return this.frames.shift() as RemoteStreamServerMessage
  }
}

function remoteStreamUrl(): string {
  const location = (globalThis as { location?: { origin?: string } }).location
  const base = location?.origin !== undefined && location.origin !== 'null' ? location.origin : INTERNAL_BASE
  const url = new URL(REMOTE_STREAM_MUX_PATH, base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

/** Injection seams for {@link installForegroundResync}. */
export interface ForegroundResyncOptions {
  /** Phone-web gate; defaults to {@link isPhoneWeb}. */
  readonly isPhone?: () => boolean
  /** Page-lifecycle targets; defaults to the browser `document` and `window`. */
  readonly targets?: { readonly visibility: EventTarget; readonly page: EventTarget }
  /** Visibility reader; defaults to `document.visibilityState`. */
  readonly visibilityState?: () => string
}

/**
 * Whether this page load runs on a phone-class device: the primary pointer is
 * coarse (touch-primary), with a mobile user-agent fallback for runtimes
 * without `matchMedia`.
 * @returns whether this page load is phone web.
 */
export function isPhoneWeb(): boolean {
  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return true
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

/**
 * Wire the browser's foreground return to one forced socket recycle, and
 * return the uninstaller. Phone web only by design: a suspended mobile page
 * loses frames and can lose its TCP leg without a close event, while a
 * desktop tab switch keeps the socket healthy and must not churn every open
 * stream. Outside a browser or off a phone this installs nothing.
 * @param client - the mux client whose socket the foreground return recycles.
 * @param options - phone gate and page-lifecycle seams for tests.
 * @returns an uninstaller.
 */
export function installForegroundResync(
  client: RemoteStreamMuxClient,
  options: ForegroundResyncOptions = {},
): () => void {
  if (!(options.isPhone ?? isPhoneWeb)()) return noop
  const globals = globalThis as {
    document?: Document
    window?: EventTarget
  }
  const visibilityTarget = options.targets?.visibility ?? globals.document
  const pageTarget = options.targets?.page ?? globals.window
  if (visibilityTarget === undefined || pageTarget === undefined) return noop
  const documentRef = globals.document
  const readVisibility = options.visibilityState ?? (documentRef === undefined
    ? (): string => 'visible'
    : (): string => documentRef.visibilityState)
  const onVisibility = (): void => {
    if (readVisibility() === 'visible') client.resume()
  }
  const onPageShow = (event: Event): void => {
    if ((event as PageTransitionEvent).persisted) client.resume()
  }
  visibilityTarget.addEventListener('visibilitychange', onVisibility)
  pageTarget.addEventListener('pageshow', onPageShow)
  return () => {
    visibilityTarget.removeEventListener('visibilitychange', onVisibility)
    pageTarget.removeEventListener('pageshow', onPageShow)
  }
}

function noop(): void {}
