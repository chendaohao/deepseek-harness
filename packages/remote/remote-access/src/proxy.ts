/**
 * The remote-access reverse proxy: a loopback-only node:http server that
 * gates every request through the access policy, normalizes the Host and
 * browser-trust headers to loopback, and relays HTTP and WebSocket traffic
 * to the real Web server. The proxy is the only public trust boundary: the
 * tunnel hostname never enters the main server's trust fence.
 * @module @deepseek-ai/dsh-remote-access/proxy
 */

import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { PROXIED_HEADER } from '@deepseek-ai/dsh-host-webserver'
import { PAIR_REQUIRED_PAGE, type AccessPolicy, type AuthorizeResult } from './policy.ts'

export { PROXIED_HEADER }

/** Header names never relayed across a proxy hop. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'proxy-authorization', 'proxy-authenticate',
])

/** Browser-trust markers normalized away: the main server must see a loopback-shaped request. */
const BROWSER_TRUST_HEADERS = new Set(['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'])

/** WebSocket handshake headers, relayed only by the upgrade path. */
const WEBSOCKET_HEADERS = new Set(['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'])

/** Largest single WebSocket frame the relay accepts (bytes). */
const WS_MAX_PAYLOAD = 64 * 1024 * 1024
/** Largest downstream payload buffered before the upstream handshake completes (bytes). */
const UPSTREAM_PENDING_MAX_BYTES = 8 * 1024 * 1024
/** Send-queue backlog that marks a relayed pair as flooding and closes it (bytes). */
const WS_BACKLOG_MAX_BYTES = 128 * 1024 * 1024
/** Re-run the access policy on established WebSocket relays every this many ms. */
const REAUTHORIZE_INTERVAL_MS = 30_000
/** Consecutive relayed pings a downstream leg may leave unanswered before the pair is closed. */
const PONG_MISS_MAX = 3

/** Test hook: WebSocket relay bounds, overridable so fixture tests need no huge frames. */
export const internals = {
  /** Per-frame inbound bound applied to the downstream socket (bytes). */
  maxPayload: WS_MAX_PAYLOAD,
  /** Pre-handshake downstream buffer bound (bytes). */
  pendingMaxBytes: UPSTREAM_PENDING_MAX_BYTES,
  /** Send-queue backlog bound per direction (bytes). */
  backlogMaxBytes: WS_BACKLOG_MAX_BYTES,
  /** Re-authorization cadence for established relays (ms). */
  reauthorizeIntervalMs: REAUTHORIZE_INTERVAL_MS,
  /** Missed-pong threshold that closes a relayed pair. */
  pongMissMax: PONG_MISS_MAX,
}

/** Byte length of one ws message payload. */
function payloadBytes(data: RawData): number {
  /* v8 ignore next -- node ws delivers single Buffers, never fragmented arrays */
  if (Array.isArray(data)) return data.reduce((sum, part) => sum + part.length, 0)
  /* v8 ignore next -- node ws delivers Buffers, never ArrayBuffers */
  if (data instanceof ArrayBuffer) return data.byteLength
  return data.length
}

/** Merge the gate's daily cookie refresh onto the relayed response headers. */
function withCookieRefresh(headers: OutgoingHttpHeaders, verdict: AuthorizeResult): OutgoingHttpHeaders {
  if (verdict.cookieRefresh === undefined) return headers
  // Client-side response headers always carry set-cookie as an array (node
  // guarantees it), so the refresh appends after the target's own cookies.
  const existing = headers['set-cookie']
  const prior = Array.isArray(existing) ? existing : existing === undefined ? [] : [existing]
  return { ...headers, 'set-cookie': [...prior, verdict.cookieRefresh] }
}

/** A running proxy: its loopback port and its teardown. */
export interface RemoteProxyHandle {
  /** The loopback port the tunnel targets. */
  readonly port: number
  /** Close the server and every owned socket, awaiting quiescence. */
  close(): Promise<void>
}

/** Proxy construction options. */
export interface RemoteProxyOptions {
  /** Port of the real Web server. */
  targetPort: number
  /** Bind host of the real Web server; the relay connects to it. Defaults to 127.0.0.1. */
  targetHost?: string
  /** The access policy every request and upgrade passes through. */
  policy: AccessPolicy
}

/**
 * Start the reverse proxy on an OS-assigned loopback port.
 * @param options - target port and access policy.
 * @returns the live handle once the socket is bound.
 */
export async function createRemoteProxy(options: RemoteProxyOptions): Promise<RemoteProxyHandle> {
  const { targetPort, targetHost = '127.0.0.1', policy } = options
  const upstreamSockets = new Set<Duplex>()
  const upstreamClients = new Set<WebSocket>()
  const wss = new WebSocketServer({ noServer: true, maxPayload: internals.maxPayload })

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    /* v8 ignore next -- node:http always sets url on server requests */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    if (policy.handlePairing(req, res, rawPath)) return
    const verdict = policy.authorize(req)
    if (!verdict.admitted) {
      res.writeHead(401, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(Buffer.byteLength(PAIR_REQUIRED_PAGE)),
      })
      res.end(PAIR_REQUIRED_PAGE)
      return
    }
    relay(req, res, verdict)
  }

  const relay = (req: IncomingMessage, res: ServerResponse, verdict: AuthorizeResult): void => {
    const headers: OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      /* v8 ignore next -- parsed header values are strings or arrays, never undefined */
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (lower === 'host' || HOP_BY_HOP.has(lower) || BROWSER_TRUST_HEADERS.has(lower) || WEBSOCKET_HEADERS.has(lower) || lower === PROXIED_HEADER) continue
      headers[name] = value
    }
    headers.host = targetHost + ':' + String(targetPort)
    headers[PROXIED_HEADER] = '1'
    headers.connection = 'close'
    const proxyReq = httpRequest({
      host: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers,
    }, (proxyRes) => {
      /* v8 ignore next -- a parsed response always carries a status code */
      res.writeHead(proxyRes.statusCode ?? 502, withCookieRefresh(proxyRes.headers, verdict))
      proxyRes.pipe(res)
    })
    proxyReq.on('error', (error) => {
      // Target down or the client aborted mid-body; the response side owns both cases.
      void error
      /* v8 ignore next 3 -- the mid-response target-failure arm needs a torn socket mid-stream */
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(502)
      res.end('bad gateway')
    })
    req.pipe(proxyReq)
    res.on('close', () => {
      if (!res.writableEnded) proxyReq.destroy()
    })
  }

  const server = createServer((req, res) => {
    try {
      handle(req, res)
    } catch (error) {
      // Per-request failures answer 400, never a process exit (webserver parity).
      const message = error instanceof Error ? error : new Error(String(error))
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(400)
      res.end('bad request: ' + message.message)
    }
  })

  server.on('upgrade', (req, socket, head) => {
    upstreamSockets.add(socket)
    socket.on('close', () => { upstreamSockets.delete(socket) })
    // No response headers exist on the upgrade path, so a day-rolled request
    // slides the registry window here and the refresh rides the next plain
    // request (documented semantics).
    if (!policy.authorize(req).admitted) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (downstream) => {
      /* v8 ignore next -- node:http always sets url on server upgrade requests */
      const upstream = new WebSocket('ws://' + targetHost + ':' + String(targetPort) + (req.url ?? ''), {
        // The webserver's browser-auth fence authenticates the upstream
        // upgrade by cookie. Relay the visitor's Cookie header so a tunneled
        // upgrade passes it exactly like the relayed HTTP requests do; an
        // anonymous dial is rejected and tears the pair down mid-handshake.
        ...(req.headers.cookie === undefined ? {} : { headers: { cookie: req.headers.cookie } }),
      })
      upstreamClients.add(upstream)
      upstream.on('close', () => { upstreamClients.delete(upstream) })
      const pending: { data: RawData; isBinary: boolean }[] = []
      let pendingBytes = 0
      const stopReauthorize = (): void => { clearInterval(reauthorize) }
      const closePair = (): void => {
        stopReauthorize()
        /* v8 ignore next 2 -- closePair only runs while the pair is live; the CLOSED arms defend double teardown */
        if (downstream.readyState !== WebSocket.CLOSED) downstream.close()
        if (upstream.readyState !== WebSocket.CLOSED) upstream.close()
      }
      // Authorization ran at upgrade time; a live relay must not outlive its
      // device. Re-run the policy on an interval so a revocation cuts an
      // established socket too, not just the next HTTP request.
      const reauthorize = setInterval(() => {
        if (!policy.authorize(req).admitted) closePair()
      }, internals.reauthorizeIntervalMs)
      // Relay the upstream's WebSocket pings to the visitor and watch the
      // pongs. A phone that left the network — or whose OS tore the suspended
      // page's leg — never sends a close frame, so unanswered pings are the
      // only signal, and an unwatched relay keeps fanning frames into the
      // dead leg until a kernel timeout. Browsers answer pings at the
      // protocol level without page JavaScript, so any live leg resets the
      // watch; the carrier-facing keepalive is the relayed ping itself.
      let unansweredPings = 0
      upstream.on('ping', () => {
        if (downstream.readyState !== WebSocket.OPEN) return
        unansweredPings += 1
        if (unansweredPings > internals.pongMissMax) {
          closePair()
          return
        }
        downstream.ping()
      })
      downstream.on('pong', () => { unansweredPings = 0 })
      upstream.on('open', () => {
        for (const frame of pending) upstream.send(frame.data, { binary: frame.isBinary })
        pending.length = 0
        pendingBytes = 0
      })
      upstream.on('message', (data, isBinary) => {
        /* v8 ignore next -- the not-OPEN arm races the client's close handshake */
        if (downstream.readyState !== WebSocket.OPEN) return
        // A congested downstream leaves the send queue full: refuse the pair
        // instead of buffering attacker-paced frames without a bound. The
        // upstream-direction arm below exercises the same guard; a browser
        // client always drains its receive side, so this side cannot be
        // congested deterministically from a fixture.
        /* v8 ignore next 3 -- see above: only the upstream direction is fixture-drivable */
        if (downstream.bufferedAmount > internals.backlogMaxBytes) {
          closePair()
          return
        }
        downstream.send(data, { binary: isBinary })
      })
      downstream.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) {
          // Symmetric backlog bound on the upstream send queue.
          if (upstream.bufferedAmount > internals.backlogMaxBytes) {
            closePair()
            return
          }
          upstream.send(data, { binary: isBinary })
        } else if (pendingBytes + payloadBytes(data) <= internals.pendingMaxBytes) {
          pending.push({ data, isBinary })
          pendingBytes += payloadBytes(data)
        } else {
          // A flooding client exceeds the pre-open buffer: refuse the socket pair.
          closePair()
        }
      })
      upstream.on('close', () => { stopReauthorize(); if (downstream.readyState === WebSocket.OPEN) downstream.close() })
      downstream.on('close', () => { stopReauthorize(); if (upstream.readyState !== WebSocket.CLOSED) upstream.close() })
      upstream.on('error', () => { upstream.close() })
      /* v8 ignore next -- ws always follows a downstream error with close, which already closes the upstream */
      downstream.on('error', () => { upstream.close() })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      /* v8 ignore next -- post-listen server errors are environmental, not request paths */
      server.on('error', (error) => { void error })
      resolve()
    })
  })

  const close = async (): Promise<void> => {
    for (const client of wss.clients) client.terminate()
    for (const client of upstreamClients) client.terminate()
    const serverClosed = new Promise<void>(resolve => server.close(() => { resolve() }))
    server.closeAllConnections()
    for (const socket of [...upstreamSockets]) socket.destroy()
    await serverClosed
  }

  return { port: (server.address() as AddressInfo).port, close }
}

