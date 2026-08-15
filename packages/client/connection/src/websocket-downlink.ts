/** Host-side WebSocket carrier for the two server-to-browser event streams. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type {
  ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'

type Frame = MuxFrame | HostFrame

function serverRequest(frame: RpcRequest<Frame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
}

function send(socket: WebSocket, frame: RpcRequest<Frame>): Promise<void> {
  return new Promise((resolve, reject) => {
    /* v8 ignore next -- the pump checks the abort flag before every send, and a
     * closed socket always fired its close event (and therefore the abort)
     * first, so a not-OPEN socket cannot reach this call. */
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('websocket downlink closed before frame delivery'))
      return
    }
    socket.send(JSON.stringify(serverRequest(frame)), (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function failureFrame(error: unknown): RpcRequest<Frame> {
  return {
    rpcId: RpcId(randomUUID()),
    payload: {
      type: 'stream/error',
      error: { code: 'internal', message: String(error), details: {} },
    },
  }
}

function heartbeatFrame(): RpcRequest<Frame> {
  return {
    rpcId: RpcId(randomUUID()),
    payload: { type: 'stream/heartbeat' },
  }
}

/**
 * Call the iterator's return() and swallow its rejection (parity with the
 * for-await loop's IteratorClose: the generator's finally must run, and a
 * throwing finally must not mask the pump's own outcome).
 * @param iterator - the frame source.
 */
async function unwind<F extends Frame>(iterator: AsyncIterator<RpcRequest<F>>): Promise<void> {
  try {
    await iterator.return?.(undefined)
  } catch {
    // A generator whose finally throws has already unwound itself.
  }
}

/**
 * Resolve after `ms`, or as soon as the signal aborts (never reject: the pump
 * re-checks the abort flag after the race either way). A zero or negative
 * interval means "disabled" — the promise then parks until abort, so the race
 * can only ever end through the frame side or the abort.
 * @param ms - quiet-span in milliseconds; <= 0 disables.
 * @param signal - aborts the wait.
 */
function quiet(ms: number, signal: AbortSignal): Promise<void> {
  /* v8 ignore next -- the pump creates quiet only while !abort.signal.aborted */
  if (signal.aborted) return Promise.resolve()
  if (ms <= 0) {
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    /* v8 ignore next -- same synchronous-creation argument as above */
    if (signal.aborted) { done(); return }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Downlink construction options. */
export interface WebSocketDownlinkOptions {
  /**
   * Quiet-stream heartbeat interval in ms: while the event stream delivers no
   * frame, the downlink sends a `stream/heartbeat` probe every interval so
   * clients can tell a healthy idle connection from a silently dead one and so
   * tunnel edges do not reap the idle socket. 0 disables heartbeats.
   */
  heartbeatIntervalMs?: number
}

/**
 * Owns WebSocket negotiation and frame pumping for the connection plugin's
 * two downlinks. Client messages are a protocol violation: upstream traffic
 * remains on HTTP.
 */
export class WebSocketDownlinks {
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly pumps = new Set<Promise<void>>()
  private readonly heartbeatIntervalMs: number

  /**
   * @param api - host API supplying the typed event streams.
   * @param options - downlink tunables (heartbeat interval).
   */
  constructor(private readonly api: ApiProxy, options: WebSocketDownlinkOptions = {}) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 0
  }

  /**
   * Upgrade one socket and pump the mux stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   */
  handleMux(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.upgrade(req, socket, head, signal => this.api.events.mux({
      rpcId: RpcId(randomUUID()),
      payload: {},
    }, signal))
  }

  /**
   * Upgrade one socket and pump the host stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   */
  handleHost(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.upgrade(req, socket, head, signal => this.api.events.host({
      rpcId: RpcId(randomUUID()),
      payload: {},
    }, signal))
  }

  /**
   * Terminate owned sockets and await the no-server acceptor plus frame pumps.
   * @returns A promise resolving after every socket and source iterator stops.
   */
  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    await Promise.all(this.pumps)
  }

  private upgrade<F extends Frame>(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    open: (signal: AbortSignal) => AsyncIterable<RpcRequest<F>>,
  ): void {
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      const abort = new AbortController()
      websocket.once('close', () => { abort.abort() })
      websocket.once('error', () => { abort.abort() })
      websocket.once('message', () => {
        websocket.close(1008, 'downlink only')
      })
      const pump = this.pump(websocket, open(abort.signal), abort)
      this.pumps.add(pump)
      void pump.then(() => { this.pumps.delete(pump) })
    })
  }

  private async pump<F extends Frame>(
    socket: WebSocket,
    frames: AsyncIterable<RpcRequest<F>>,
    abort: AbortController,
  ): Promise<void> {
    // Manual iteration: each quiet span races the next frame against a
    // heartbeat timer, so an eventless stream still proves its liveness. The
    // pending next() is re-raced verbatim after each heartbeat — exactly one
    // iterator request is in flight at any time.
    // Read the abort flag through a function: the signal aborts asynchronously
    // during the race, so the while-condition's narrowing must not stick.
    const signalAborted = (): boolean => abort.signal.aborted
    const iterator = frames[Symbol.asyncIterator]()
    let pending = iterator.next()
    try {
      while (!abort.signal.aborted) {
        const outcome = await Promise.race([
          pending.then(result => ({ kind: 'frame', result }) as const),
          quiet(this.heartbeatIntervalMs, abort.signal).then(() => ({ kind: 'quiet' }) as const),
        ])
        if (signalAborted()) break
        if (outcome.kind === 'quiet') {
          await send(socket, heartbeatFrame())
          continue
        }
        const result = outcome.result
        if (result.done) break
        await send(socket, result.value)
        pending = iterator.next()
      }
    } catch (error) {
      /* v8 ignore next -- unreachable guard arm: an abort settles the quiet side
       * one microtask before a source rejection reaches the race (the rejection
       * detours through the async-generator resume), so the pump breaks out of
       * the race instead — this catch only ever runs with the signal unaborted. */
      if (!abort.signal.aborted) {
        try {
          await send(socket, failureFrame(error))
        } catch {
          // Socket loss won the race; no downstream remains to receive the failure frame.
        }
      }
    } finally {
      // Abort before unwinding: a generator suspended on a signal-driven await
      // (the production streams) only settles through the abort, and unwind
      // (IteratorClose parity with for-await) resumes it so its finally runs
      // before teardown reports quiescence. A completed iterator is a no-op.
      abort.abort()
      await unwind(iterator)
      if (socket.readyState === WebSocket.OPEN) socket.close()
    }
  }
}

/**
 * Reject an untrusted upgrade before protocol negotiation.
 * @param socket - Raw HTTP socket that remains owned by the caller.
 */
export function rejectWebSocketUpgrade(socket: Duplex): void {
  socket.end([
    'HTTP/1.1 403 Forbidden',
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Length: 9',
    '',
    'forbidden',
  ].join('\r\n'))
}
