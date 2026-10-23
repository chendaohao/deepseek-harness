/** Client owner for the Gateway multiplexed Remote stream socket. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'

import {
  parseRemoteStreamServerMessage,
  REMOTE_STREAM_MUX_PATH,
  type RemoteStreamClientMessage,
  type RemoteStreamServerMessage,
} from '../stream-protocol.ts'
import { Deque } from '@deepseek-ai/dsh-deque'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

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
  readonly revision: number
  resolve(socket: ConnectionWebSocket): void
  reject(error: unknown): void
}

interface UplinkPump {
  /** Settles once the pump has stopped sending. */
  readonly done: Promise<void>
  /** Interrupt the pump, including a read blocked on the caller's iterator, and release the iterator. */
  stop(): void
}

/** One open logical stream: its downlink frames and, once the `open` frame is out, its uplink pump. */
interface LogicalStream {
  readonly inbox: StreamInbox
  pump: UplinkPump | undefined
}

const UPLINK_DONE: IteratorReturnResult<undefined> = { value: undefined, done: true }

/** Quiet-socket deadline and the page-lifecycle seams it reads. */
export interface MuxLivenessOptions {
  /**
   * Milliseconds of complete downlink silence after which the socket is treated
   * as dead. The Host sends a text liveness frame every heartbeat tick (2 s by
   * default), so this bounds how long a leg that died without a close event can
   * keep failing every logical stream behind one dead socket. 0 disables.
   */
  readonly timeoutMs: number
  /** Whether the page is currently hidden; a thawed frozen page must not count its own freeze as silence. */
  readonly isHidden?: () => boolean
}

/** Host-injected liveness timing, present when the serving Host sends liveness frames. */
interface MuxLivenessGlobal {
  __DSH_MUX_LIVENESS__?: { readonly timeoutMs?: unknown }
}

/**
 * Resolve the mux liveness timing for this page.
 *
 * The deadline stays disarmed unless the Host injected one, because the Host is
 * also what sends the liveness frames the deadline watches. A page served by a
 * Host that predates those frames would otherwise count healthy quiet time as
 * silence and recycle a working socket on every idle stretch — a regression
 * worse than the stale leg the deadline exists to catch. The two halves
 * therefore ship as one deployment: a Host that injects the value is a Host that
 * emits the frames.
 * @returns the deadline and the live visibility reader.
 */
export function resolveMuxLiveness(): MuxLivenessOptions {
  const injected = (globalThis as MuxLivenessGlobal).__DSH_MUX_LIVENESS__?.timeoutMs
  // Disarmed when absent: an unknown value is never treated as the default.
  const timeoutMs = typeof injected === 'number' && Number.isFinite(injected) && injected >= 0
    ? injected
    : 0
  const documentRef = (globalThis as { readonly document?: { readonly visibilityState?: string } }).document
  return {
    timeoutMs,
    ...documentRef === undefined ? {} : { isHidden: () => documentRef.visibilityState === 'hidden' },
  }
}

/**
 * Keep one physical WebSocket and share it among independently cancellable
 * Remote streams. A carrier that supplies an in-process stream opener never
 * starts one.
 */
export class RemoteStreamMuxClient {
  private socket: ConnectionWebSocket | undefined
  private cancelCandidate: ((error: Error) => void) | undefined
  private keepAlive: Promise<void> | undefined
  private livenessTimer: ReturnType<typeof setTimeout> | undefined
  private revision = 0
  private readonly streams = new Map<string, LogicalStream>()
  private readonly waiters = new Set<SocketWaiter>()
  private readonly socketClosures = new Set<Promise<void>>()
  private running = false
  private disposed = false
  private failure: RemoteStreamCarrierError | undefined

  /**
   * @param openSocket - selected authenticated carrier; omission uses the browser socket.
   * @param waitForReconnect - answering Clients wait for Connection to replace a lost socket; passive Clients fail later opens immediately.
   * @param liveness - quiet-socket deadline and the page-lifecycle seams it reads; omission resolves the served page's own timing.
   */
  constructor(
    private readonly openSocket: (path: string) => ConnectionWebSocket = () => new WebSocket(remoteStreamUrl()),
    private readonly waitForReconnect = false,
    private readonly liveness: MuxLivenessOptions = resolveMuxLiveness(),
  ) {}

  /** Ensure a physical attempt exists, following the current attempt once if needed. */
  start(): void {
    if (this.disposed) return
    this.running = true
    if (this.socket?.readyState === 1) return
    const pending = this.keepAlive
    if (pending === undefined) this.maintain()
    else void pending.then(() => { this.maintain() })
  }

  /** Cancel the current socket or retry wait and start a fresh attempt immediately. */
  reconnect(): void {
    if (!this.running || this.disposed) return
    const failure = new RemoteStreamCarrierError('api gateway: Remote stream reconnect requested')
    const pending = this.keepAlive
    this.revision++
    this.failure = undefined
    this.cancelCandidate?.(failure)
    const socket = this.socket
    if (socket !== undefined) {
      this.socket = undefined
      this.failAll(failure)
      socket.close(4000, 'reconnect requested')
    }
    if (pending === undefined) this.maintain()
    else void pending.then(() => { this.maintain() })
  }

  /**
   * Open one logical stream on the persistent physical connection.
   * After an established socket is lost, answering Clients wait for Connection
   * to reconnect or for their signal to abort; passive Clients reject immediately.
   * An initial socket failure rejects both modes.
   * @param endpoint - Typert Remote stream endpoint.
   * @param payload - endpoint request encoded on the wire.
   * @param signal - cancellation for this logical stream.
   * @param uplink - the Client's items: each is sent as an `item` frame, its end as `end`; its `return()`
   * runs when the stream finishes, and its failure cancels the stream and fails the downlink.
   * @returns Host items until completion, cancellation, or failure.
   */
  async *open(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    uplink?: AsyncIterable<unknown>,
  ): AsyncGenerator {
    signal.throwIfAborted()
    const streamId = randomUUID()
    const inbox = new StreamInbox()
    const stream: LogicalStream = { inbox, pump: undefined }
    let carrier: ConnectionWebSocket | undefined
    let opened = false
    let terminal = false
    const abort = (): void => { inbox.fail(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const socket = await this.waitForSocket(signal)
      signal.throwIfAborted()
      carrier = socket
      this.streams.set(streamId, stream)
      this.send(socket, { type: 'open', streamId, endpoint, payload })
      opened = true
      if (uplink !== undefined) stream.pump = this.pumpUplink(socket, streamId, uplink, signal, inbox)
      while (true) {
        const frame = await inbox.next()
        signal.throwIfAborted()
        if (frame.type === 'item') {
          yield frame.value
          continue
        }
        terminal = true
        if (frame.type === 'error') {
          throw new RemoteError(frame.error.code as never, frame.error.message, frame.error.details as never)
        }
        return
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.streams.delete(streamId)
      stream.pump?.stop()
      if (opened && !terminal && carrier?.readyState === 1) {
        this.send(carrier, { type: 'cancel', streamId })
      }
      // The old generation's pump has stopped before a supervisor reopens the next one.
      if (stream.pump !== undefined) await stream.pump.done
    }
  }

  /**
   * Send the caller's uplink items on this generation's socket. `stop()`
   * interrupts a pump blocked on `uplink.next()` and releases the iterator: a
   * handle's queue closes at once, so `send()` throws from then on, and any
   * other iterator's `return()` is invoked without being awaited because a
   * generator blocked in `next()` only completes it once it yields.
   */
  private pumpUplink(
    socket: ConnectionWebSocket,
    streamId: string,
    uplink: AsyncIterable<unknown>,
    signal: AbortSignal,
    inbox: StreamInbox,
  ): UplinkPump {
    let stopped: PromiseWithResolvers<IteratorReturnResult<undefined>> | undefined
    const interruption: IteratorReturnResult<undefined> = { value: undefined, done: true }
    const uplinkIterator = uplink[Symbol.asyncIterator]()
    const state = { stopping: false, exhausted: false, released: false }
    const release = (): void => {
      if (state.released || state.exhausted) return
      state.released = true
      if (uplink instanceof ClientUplinkQueue) uplink.close()
      void Promise.resolve().then(() => uplinkIterator.return?.()).catch(() => undefined)
    }
    const done = (async (): Promise<void> => {
      try {
        while (true) {
          const stoppingBeforeRead = state.stopping
          if (stoppingBeforeRead) return
          // A stop promise belongs to one read, not the whole uplink history.
          stopped = Promise.withResolvers<IteratorReturnResult<undefined>>()
          const next = await Promise.race([uplinkIterator.next(), stopped.promise])
          stopped = undefined
          if (state.stopping || next === interruption || signal.aborted || this.socket !== socket) return
          if (next.done === true) {
            state.exhausted = true
            break
          }
          this.send(socket, { type: 'item', streamId, value: next.value })
        }
        this.send(socket, { type: 'end', streamId })
      } catch (error) {
        inbox.fail(error)
      } finally {
        stopped = undefined
        release()
      }
    })()
    return {
      done,
      stop: () => {
        if (state.stopping) return
        state.stopping = true
        stopped?.resolve(interruption)
        release()
      },
    }
  }

  /**
   * Permanently stop the carrier, close the physical socket, and fail every
   * active logical stream.
   * @returns once the connection attempt and every physical socket have closed.
   */
  async close(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true
      this.running = false
      const error = new Error('api gateway: Remote stream client disposed')
      this.disarmLiveness()
      this.failAll(error)
      for (const waiter of [...this.waiters]) waiter.reject(error)
      this.cancelCandidate?.(error)
      const socket = this.socket
      this.socket = undefined
      socket?.close(1000, 'disposed')
    }
    await this.keepAlive
    await Promise.all(this.socketClosures)
  }

  /**
   * Arm the quiet-socket deadline for one live socket. The Host sends a text
   * liveness frame on every heartbeat tick precisely because a browser cannot
   * observe Ping control frames; silence past this deadline therefore means the
   * leg died without a close event — the phone switching networks or the OS
   * tearing a suspended page's socket.
   * @param socket - the socket whose silence this deadline watches.
   */
  private armLiveness(socket: ConnectionWebSocket): void {
    this.disarmLiveness()
    const timeoutMs = this.liveness.timeoutMs
    if (timeoutMs <= 0) return
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = undefined
      // A frozen page's timers do not run, so an expiry can be the thaw itself
      // rather than evidence of a dead leg: re-arm instead of recycling while
      // hidden. The foreground return owns that recycle.
      if (this.liveness.isHidden?.() === true) {
        this.armLiveness(socket)
        return
      }
      this.recycle(socket, new RemoteStreamCarrierError(
        `api gateway: Remote stream socket heard nothing for ${String(timeoutMs)} ms`,
      ))
    }, timeoutMs)
    // A pending deadline must not keep a Node test or CLI process alive; a
    // browser timer id is a number and has nothing to unref.
    const timer = this.livenessTimer as { unref?: () => void }
    timer.unref?.()
  }

  private disarmLiveness(): void {
    if (this.livenessTimer === undefined) return
    clearTimeout(this.livenessTimer)
    this.livenessTimer = undefined
  }

  /**
   * Replace the dead socket with a fresh dial, failing its logical streams with
   * a carrier error their domain supervisors reopen with fresh snapshots.
   * @param socket - the live socket whose silence or foreground return ended it.
   * @param error - carrier failure reported to every open logical stream.
   */
  private recycle(socket: ConnectionWebSocket, error: RemoteStreamCarrierError): void {
    this.socket = undefined
    this.disarmLiveness()
    this.failAll(error)
    socket.close(4001, 'socket recycled')
    this.keepAlive = undefined
    this.maintain()
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
    const error = new RemoteStreamCarrierError(
      'api gateway: Remote stream socket recycled on foreground return',
    )
    if (socket !== undefined) {
      this.socket = undefined
      this.disarmLiveness()
      this.failAll(error)
      socket.close(4001, 'foreground resync')
    } else {
      // A hung dial (never-opened candidate): cut the stale connect task so
      // the fresh attempt starts immediately instead of waiting for events a
      // swallowed upgrade never fires.
      this.cancelCandidate?.(error)
    }
    // The old connect task (if any) settled against the recycled candidate;
    // drop it so the fresh dial starts immediately.
    this.keepAlive = undefined
    this.maintain()
  }

  private async connect(): Promise<ConnectionWebSocket> {
    const socket = this.openSocket(REMOTE_STREAM_MUX_PATH)
    const closed = new Promise<void>((resolve) => { socket.addEventListener('close', () => { resolve() }, { once: true }) })
    this.socketClosures.add(closed)
    void closed.then(() => { this.socketClosures.delete(closed) })
    const connecting = new Promise<ConnectionWebSocket>((resolve, reject) => {
      let settled = false
      const rejectCandidate = (error: Error): void => {
        settled = true
        socket.removeEventListener('open', opened)
        socket.removeEventListener('message', received)
        this.cancelCandidate = undefined
        // Node ws emits error when a connecting socket is closed. Keep its
        // error listener until close even after rejecting the attempt.
        if (socket.readyState < 2) socket.close()
        reject(error)
      }
      const opened = (): void => {
        settled = true
        this.cancelCandidate = undefined
        this.socket = socket
        this.armLiveness(socket)
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
        if (socket.readyState < 2) socket.close()
      }
      const closed = (): void => {
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('message', received)
        if (!settled) {
          rejectCandidate(new RemoteStreamCarrierError(
            'api gateway: Remote stream WebSocket closed before opening',
          ))
          return
        }
        this.lost(socket)
      }
      const received = (event: { readonly data: unknown }): void => { this.receive(socket, event.data) }
      this.cancelCandidate = rejectCandidate
      socket.addEventListener('open', opened, { once: true })
      socket.addEventListener('error', failed)
      socket.addEventListener('message', received)
      socket.addEventListener('close', closed, { once: true })
    })
    return connecting
  }

  private waitForSocket(signal: AbortSignal): Promise<ConnectionWebSocket> {
    signal.throwIfAborted()
    if (this.socket?.readyState === 1) return Promise.resolve(this.socket)
    if (this.disposed) return Promise.reject(new Error('api gateway: Remote stream client disposed'))
    if (!this.running) return Promise.reject(new Error('api gateway: Remote stream client not started'))
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const aborted = (): void => { waiter.reject(signal.reason) }
      const cleanup = (): void => {
        this.waiters.delete(waiter)
        signal.removeEventListener('abort', aborted)
      }
      const waiter: SocketWaiter = {
        revision: this.revision,
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

  private receive(socket: ConnectionWebSocket, data: unknown): void {
    if (socket !== this.socket) return
    try {
      if (typeof data !== 'string') throw new Error('api gateway: Remote stream WebSocket requires text messages')
      const frame = parseRemoteStreamServerMessage(data)
      // Any frame proves the leg is alive, and the Host's liveness frame is the
      // one an idle socket receives: it re-arms the deadline, then ends here
      // because it belongs to no stream.
      this.armLiveness(socket)
      if (frame.type === 'liveness') return
      const stream = this.streams.get(frame.streamId)
      if (stream === undefined) return
      stream.inbox.push(frame)
      // A terminal frame ends the uplink now, not on the consumer's next read.
      if (frame.type !== 'item') stream.pump?.stop()
    } catch (error) {
      const failure = new RemoteStreamCarrierError('api gateway: invalid Remote stream frame', { cause: error })
      this.failAll(failure)
      this.lost(socket, failure)
      socket.close(4002, 'invalid Remote stream frame')
    }
  }

  private lost(
    socket: ConnectionWebSocket,
    error: RemoteStreamCarrierError = new RemoteStreamCarrierError(
      'api gateway: Remote stream WebSocket closed',
    ),
  ): void {
    if (this.socket !== socket) return
    this.socket = undefined
    this.disarmLiveness()
    if (!this.waitForReconnect) this.failure = error
    this.failAll(error)
    if (!this.waitForReconnect) {
      for (const waiter of [...this.waiters]) waiter.reject(error)
    }
  }

  private maintain(): void {
    if (!this.running || this.disposed) return
    if (this.socket?.readyState === 1 || this.keepAlive !== undefined) return
    const revision = this.revision
    this.failure = undefined
    const task = this.connect().then(
      () => undefined,
      (error: unknown) => {
        if (!this.running) return
        const failure = error instanceof RemoteStreamCarrierError ? error
          : new RemoteStreamCarrierError('api gateway: Remote stream WebSocket failed to open', { cause: error })
        if (this.revision === revision) this.failure = failure
        for (const waiter of [...this.waiters]) {
          if (waiter.revision <= revision) waiter.reject(failure)
        }
      },
    )
    this.keepAlive = task
    void task.then(() => {
      if (this.keepAlive === task) this.keepAlive = undefined
    })
  }

  private failAll(error: unknown): void {
    for (const stream of this.streams.values()) {
      stream.inbox.fail(error)
      stream.pump?.stop()
    }
  }

  private send(socket: ConnectionWebSocket, message: RemoteStreamClientMessage): void {
    socket.send(JSON.stringify(message))
  }
}

class StreamInbox {
  private readonly frames = new Deque<RemoteStreamServerMessage>()
  private wake: (() => void) | undefined
  private failure: Error | undefined

  push(frame: RemoteStreamServerMessage): void {
    if (this.failure !== undefined) return
    this.frames.pushBack(frame)
    this.wake?.()
    this.wake = undefined
  }

  fail(error: unknown): void {
    if (this.failure !== undefined) return
    this.failure = error instanceof Error ? error : new Error(String(error), { cause: error })
    this.frames.clear()
    this.wake?.()
    this.wake = undefined
  }

  async next(): Promise<RemoteStreamServerMessage> {
    while (this.frames.size === 0) {
      if (this.failure !== undefined) throw this.failure
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
    return this.frames.popFront() as RemoteStreamServerMessage
  }
}

/**
 * Uplink items a stream handle queues for its carrier: the mux pump or the
 * in-process Host decoder iterates it as the stream's uplink. `end()` is the
 * Client half-close; `close()` marks the stream terminated, after which
 * `push()` throws. One consumer reads it, one read at a time.
 */
export class ClientUplinkQueue implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  private readonly items = new Deque<unknown>()
  private ended = false
  private closed = false
  private wake: (() => void) | undefined

  /** @param endpoint - canonical Remote endpoint named by failures. */
  constructor(private readonly endpoint: string) {}

  /**
   * Queue one item for the carrier.
   * @param item - item the Host validates against the method's uplink codec.
   * @throws {Error} after `end()` or once the stream has terminated.
   */
  push(item: unknown): void {
    if (this.closed) throw new Error(`client api: ${this.endpoint} stream has terminated`)
    if (this.ended) throw new Error(`client api: ${this.endpoint} uplink was ended`)
    this.items.pushBack(item)
    this.signal()
  }

  /** Half-close: the carrier reads the queued items, then `end`. Idempotent; ignored after termination. */
  end(): void {
    if (this.ended || this.closed) return
    this.ended = true
    this.signal()
  }

  /** The carrier stopped reading: the logical stream terminated or was disposed. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.items.clear()
    this.signal()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this
  }

  /**
   * Take the next queued item, waiting for one; ends after `end()` or `close()`.
   * @returns the next item, or the end of the uplink.
   * @throws {Error} when a read is already pending.
   */
  async next(): Promise<IteratorResult<unknown>> {
    while (true) {
      if (this.closed) return UPLINK_DONE
      if (this.items.size > 0) return { value: this.items.popFront(), done: false }
      if (this.ended) return UPLINK_DONE
      if (this.wake !== undefined) throw new Error(`client api: ${this.endpoint} uplink has one pending read`)
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  /**
   * The carrier is done with the uplink: close it.
   * @returns the end of the uplink.
   */
  return(): Promise<IteratorResult<unknown>> {
    this.close()
    return Promise.resolve(UPLINK_DONE)
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

function remoteStreamUrl(): string {
  // The mux route is registered absolute; a page resolves its document-relative
  // form against its own document base. A shell-owned Host on another origin
  // supplies that base through the transport.
  const globals = globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }
  const url = new URL(REMOTE_STREAM_MUX_PATH.slice(1), globals.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI)
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
 * Whether this page load runs on a phone-class device: a touch-primary
 * pointer with no hover capability (phones and small tablets; a laptop
 * touchscreen has `(hover: hover)` and must not churn streams on tab
 * switches), with a mobile user-agent fallback for runtimes without
 * `matchMedia`.
 * @returns whether this page load is phone web.
 */
export function isPhoneWeb(): boolean {
  if (typeof matchMedia === 'function') {
    if (matchMedia('(hover: hover)').matches) return false
    if (matchMedia('(pointer: coarse)').matches) return true
  }
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
