/**
 * Behavior suite for the reverse proxy: policy gating (401 page and the
 * pair-owned path), header normalization toward the target, HTTP and
 * WebSocket relaying, bad-gateway containment, and teardown quiescence —
 * against real local HTTP/WS servers.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { join } from 'node:path'
import { connect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net'
import { setTimeout as sleepMs } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { PAIR_REQUIRED_PAGE, createAccessPolicy, type AccessPolicy } from '../src/policy.ts'
import { pairingTicket } from '../src/secret.ts'
import { DeviceRegistry } from '../src/devices.ts'
import { createRemoteProxy, internals as proxyInternals, type RemoteProxyHandle } from '../src/proxy.ts'

let target: Server | undefined
let targetPort = 0
let proxy: RemoteProxyHandle | undefined
let policy: AccessPolicy
let receivedBodies: string[]
let registryRoot: string | undefined
const savedInternals = { ...proxyInternals }

beforeEach(async () => {
  receivedBodies = []
  registryRoot = await mkdtemp(join(tmpdir(), 'dsh-remote-proxy-'))
  target = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => { chunks.push(chunk as Buffer) })
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-proxied': 'yes' })
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        origin: req.headers.origin ?? null,
        secFetchSite: req.headers['sec-fetch-site'] ?? null,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
      receivedBodies.push(Buffer.concat(chunks).toString('utf8'))
    })
  })
  await new Promise<void>((resolve) => { target!.listen(0, '127.0.0.1', resolve) })
  targetPort = (target.address() as AddressInfo).port
  policy = { authorize: () => ({ admitted: true }), handlePairing: () => false }
})

afterEach(async () => {
  if (registryRoot !== undefined) {
    await rm(registryRoot, { recursive: true, force: true })
    registryRoot = undefined
  }
  proxyInternals.maxPayload = savedInternals.maxPayload
  proxyInternals.pendingMaxBytes = savedInternals.pendingMaxBytes
  proxyInternals.backlogMaxBytes = savedInternals.backlogMaxBytes
  await proxy?.close()
  proxy = undefined
  if (target !== undefined) {
    await new Promise<void>((resolve) => { target!.close(() => { resolve() }) })
    target = undefined
  }
})

async function startProxy(overrides: Partial<AccessPolicy> = {}): Promise<RemoteProxyHandle> {
  proxy = await createRemoteProxy({ targetPort, policy: { ...policy, ...overrides } })
  return proxy
}

/** One raw HTTP request with full header control. */
function rawRequest(port: number, path: string, headers: Record<string, string>, body = ''): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: body === '' ? 'GET' : 'POST', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => { chunks.push(chunk as Buffer) })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }) })
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('HTTP relaying', () => {
  it('relays method, path, and body, normalizing host and browser-trust headers', async () => {
    const proxy = await startProxy()
    const response = await rawRequest(proxy.port, '/api/echo?q=1', {
      host: 'fake.tunnel.example',
      origin: 'https://fake.tunnel.example',
      'sec-fetch-site': 'cross-site',
      'x-extra': 'kept',
    }, 'hello')
    expect(response.status).toBe(201)
    expect(response.headers['x-proxied']).toBe('yes')
    const echoed = JSON.parse(response.body) as Record<string, unknown>
    expect(echoed.method).toBe('POST')
    expect(echoed.url).toBe('/api/echo?q=1')
    expect(echoed.host).toBe('127.0.0.1:' + String(targetPort))
    expect(echoed.origin).toBeNull()
    expect(echoed.secFetchSite).toBeNull()
    expect(echoed.body).toBe('hello')
  })

  it('answers 401 with the pairing page when the policy refuses', async () => {
    const proxy = await startProxy({ authorize: () => ({ admitted: false }) })
    const response = await rawRequest(proxy.port, '/', { host: 'fake.tunnel.example' })
    expect(response.status).toBe(401)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toBe(PAIR_REQUIRED_PAGE)
  })

  it('owns pair paths through the policy without forwarding', async () => {
    const proxy = await startProxy({
      authorize: () => ({ admitted: true }),
      handlePairing: (_req, res, pathname) => {
        if (pathname === '/pair/AAAA') {
          res.writeHead(302, { location: '/' })
          res.end()
          return true
        }
        return false
      },
    })
    const response = await rawRequest(proxy.port, '/pair/AAAA', { host: 'fake.tunnel.example' })
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('/')
  })

  it('answers 502 when the target is down, without crashing', async () => {
    const proxy = await startProxy()
    await new Promise<void>((resolve) => { target!.close(() => { resolve() }) })
    target = undefined
    const response = await rawRequest(proxy.port, '/', { host: 'fake.tunnel.example' })
    expect(response.status).toBe(502)
    expect(response.body).toBe('bad gateway')
  })

  it('destroys the upstream request when the client aborts mid-body', async () => {
    const proxy = await startProxy()
    const socket = connect(proxy.port, '127.0.0.1')
    await once(socket, 'connect')
    socket.write('POST /api HTTP/1.1\r\nHost: fake.tunnel.example\r\nContent-Length: 100\r\n\r\npartial')
    await sleepMs(50)
    socket.destroy()
    await sleepMs(50)
    expect(receivedBodies).toEqual([])
  })

  it('answers 400 when the policy throws a non-Error', async () => {
    const proxy = await startProxy({ handlePairing: () => { throw 'boom' } })
    const response = await rawRequest(proxy.port, '/pair/x', { host: 'fake.tunnel.example' })
    expect(response.status).toBe(400)
    expect(response.body).toContain('boom')
  })

  it('relays to the configured target host', async () => {
    // A second target on 127.0.0.2 proves the relay honors targetHost instead
    // of always connecting to 127.0.0.1.
    const second = createServer((_req, res) => { res.writeHead(200); res.end('second-target') })
    await new Promise<void>((resolve) => { second.listen(0, '127.0.0.2', resolve) })
    try {
      const secondPort = (second.address() as AddressInfo).port
      await proxy?.close()
      proxy = await createRemoteProxy({ targetPort: secondPort, targetHost: '127.0.0.2', policy })
      const response = await rawRequest(proxy.port, '/', { host: 'fake.tunnel.example' })
      expect(response.status).toBe(200)
      expect(response.body).toBe('second-target')
    } finally {
      await new Promise<void>((resolve) => { second.close(() => { resolve() }) })
    }
  })

  it('destroys the response when the policy throws after writing headers', async () => {
    const proxy = await startProxy({
      handlePairing: (_req, res, pathname) => {
        if (pathname === '/pair/x') {
          res.writeHead(200)
          throw new Error('late boom')
        }
        return false
      },
    })
    await expect(rawRequest(proxy.port, '/pair/x', { host: 'fake.tunnel.example' })).rejects.toThrow()
  })

  it('answers 400 for an unparsable request target instead of exiting', async () => {
    const proxy = await startProxy()
    // The node client refuses to send a target that cannot parse, so speak raw HTTP.
    const socket = connect(proxy.port, '127.0.0.1')
    await once(socket, 'connect')
    const response = once(socket, 'data') as Promise<Buffer[]>
    socket.write('GET //[bad HTTP/1.1\r\nHost: fake.tunnel.example\r\n\r\n')
    const [chunk] = await response
    expect(String(chunk)).toContain('400')
    socket.destroy()
  })
})

describe('WebSocket relaying', () => {
  let echoPort = 0
  let wss: WebSocketServer | undefined

  beforeEach(async () => {
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => { wss!.once('listening', resolve) })
    echoPort = (wss.address() as AddressInfo).port
    wss.on('connection', (socket) => {
      socket.on('message', (data, isBinary) => { socket.send(data, { binary: isBinary }) })
    })
  })

  afterEach(async () => {
    for (const client of wss?.clients ?? []) client.terminate()
    await new Promise<void>((resolve) => { wss?.close(() => { resolve() }) })
    wss = undefined
  })

  it('relays messages when authorized and rejects the rest with 401', async () => {
    // Point the proxy at the echo server; reuse the policy gate with a cookie-like header.
    await proxy?.close()
    proxy = await createRemoteProxy({
      targetPort: echoPort,
      policy: {
        authorize: req => (req.headers['x-authorized'] === 'yes' ? { admitted: true } : { admitted: false }),
        handlePairing: () => false,
      },
    })
    const received = new Promise<string>((resolve) => {
      const client = new WebSocket('ws://127.0.0.1:' + String(proxy!.port), { headers: { 'x-authorized': 'yes' } })
      // Delay the frame until the upstream handshake completes, so the relay's open path is deterministic.
      client.on('open', () => { void sleepMs(150).then(() => { client.send('ping') }) })
      client.on('message', (data) => { resolve(textOf(data)); client.close() })
    })
    await expect(received).resolves.toBe('ping')
    const rejected = new Promise<{ code: number }>((resolve) => {
      const client = new WebSocket('ws://127.0.0.1:' + String(proxy!.port))
      client.on('unexpected-response', (_req, res) => { resolve({ code: res.statusCode ?? 0 }) })
      client.on('open', () => { resolve({ code: 101 }) })
    })
    await expect(rejected).resolves.toEqual({ code: 401 })
  })

  it('teardown terminates live relayed clients and upstream pairs', async () => {
    await proxy?.close()
    proxy = await createRemoteProxy({
      targetPort: echoPort,
      policy: { authorize: () => ({ admitted: true }), handlePairing: () => false },
    })
    const opened = new Promise<void>((resolve) => {
      const client = new WebSocket('ws://127.0.0.1:' + String(proxy!.port))
      client.on('open', () => { resolve() })
    })
    await opened
    await new Promise(resolve => setTimeout(resolve, 150))
    // Closing with a live downstream client and upstream pair exercises the
    // terminate loops in close().
    await proxy.close()
  })

  it('buffers frames that precede the upstream handshake and flushes them on open', async () => {
    const upstream = await delayedUpgradeServer()
    await proxy?.close()
    proxy = await createRemoteProxy({
      targetPort: upstream.port,
      policy: { authorize: req => (req.headers['x-authorized'] === 'yes' ? { admitted: true } : { admitted: false }), handlePairing: () => false },
    })
    const client = new WebSocket('ws://127.0.0.1:' + String(proxy.port), { headers: { 'x-authorized': 'yes' } })
    await new Promise<void>((resolve) => { client.on('open', () => { resolve() }) })
    client.send('buffered-1')
    client.send('buffered-2')
    // The delayed 101 keeps the upstream CONNECTING, so both frames queue; the flush delivers them.
    const frames = await upstream.received
    expect(frames.length).toBeGreaterThan(0)
    client.close()
    await upstream.close()
  })

  it('closes the pair when the upstream cannot connect', async () => {
    const portProbe = createServer()
    await new Promise<void>((resolve) => { portProbe.listen(0, '127.0.0.1', resolve) })
    const deadPort = (portProbe.address() as AddressInfo).port
    await new Promise<void>((resolve) => { portProbe.close(() => { resolve() }) })
    await proxy?.close()
    proxy = await createRemoteProxy({
      targetPort: deadPort,
      policy: { authorize: req => (req.headers['x-authorized'] === 'yes' ? { admitted: true } : { admitted: false }), handlePairing: () => false },
    })
    const client = new WebSocket('ws://127.0.0.1:' + String(proxy.port), { headers: { 'x-authorized': 'yes' } })
    const closed = new Promise<void>((resolve) => { client.on('close', () => { resolve() }) })
    await new Promise<void>((resolve) => { client.on('open', () => { resolve() }) })
    await closed
  })

  it('closes the upstream when the client terminates abnormally', async () => {
    await proxy?.close()
    proxy = await createRemoteProxy({
      targetPort: echoPort,
      policy: { authorize: req => (req.headers['x-authorized'] === 'yes' ? { admitted: true } : { admitted: false }), handlePairing: () => false },
    })
    const echoClosed = new Promise<void>((resolve) => {
      wss!.once('connection', (socket) => { socket.on('close', () => { resolve() }) })
    })
    const client = new WebSocket('ws://127.0.0.1:' + String(proxy.port), { headers: { 'x-authorized': 'yes' } })
    await new Promise<void>((resolve) => { client.on('open', () => { resolve() }) })
    client.terminate()
    await echoClosed
  })

  it('buffers pre-open frames and refuses a flooding client', async () => {
    // A blackhole upstream accepts TCP but never completes the WebSocket handshake,
    // keeping the relay's upstream CONNECTING so the pending path is deterministic.
    const sockets = new Set<ReturnType<typeof connect>>()
    const blackhole: NetServer = createNetServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => { sockets.delete(socket) })
    })
    await new Promise<void>((resolve) => { blackhole.listen(0, '127.0.0.1', resolve) })
    const blackholePort = (blackhole.address() as AddressInfo).port
    proxyInternals.pendingMaxBytes = 32
    await proxy?.close()
    proxy = await createRemoteProxy({
      targetPort: blackholePort,
      policy: {
        authorize: req => (req.headers['x-authorized'] === 'yes' ? { admitted: true } : { admitted: false }),
        handlePairing: () => false,
      },
    })
    const client = new WebSocket('ws://127.0.0.1:' + String(proxy.port), { headers: { 'x-authorized': 'yes' } })
    const closed = new Promise<void>((resolve) => { client.on('close', () => { resolve() }) })
    await new Promise<void>((resolve) => { client.on('open', () => { resolve() }) })
    for (let index = 0; index < 65; index++) {
      if (client.readyState === WebSocket.OPEN) client.send('frame-' + String(index))
    }
    await closed
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => { blackhole.close(() => { resolve() }) })
  })

  it('refuses a frame over the payload bound', async () => {
    proxyInternals.maxPayload = 1024
    await proxy?.close()
    proxy = await createRemoteProxy({
      targetPort: echoPort,
      policy: { authorize: req => (req.headers['x-authorized'] === 'yes' ? { admitted: true } : { admitted: false }), handlePairing: () => false },
    })
    const client = new WebSocket('ws://127.0.0.1:' + String(proxy.port), { headers: { 'x-authorized': 'yes' } })
    const closed = new Promise<number>((resolve) => { client.on('close', (code) => { resolve(code) }) })
    await new Promise<void>((resolve) => { client.on('open', () => { resolve() }) })
    client.send(Buffer.alloc(2 * 1024))
    await expect(closed).resolves.toBe(1009)
  })

  it('closes the pair when the upstream send queue exceeds the backlog bound', async () => {
    // The upstream completes the handshake but never reads again, so the
    // relay's send queue to it stays congested: the second downstream frame
    // trips the backlog bound deterministically.
    const upstream = await silentUpgradeServer()
    proxyInternals.backlogMaxBytes = 1024
    await proxy?.close()
    proxy = await createRemoteProxy({
      targetPort: upstream.port,
      policy: { authorize: () => ({ admitted: true }), handlePairing: () => false },
    })
    const client = new WebSocket('ws://127.0.0.1:' + String(proxy.port))
    const closed = new Promise<void>((resolve) => { client.on('close', () => { resolve() }) })
    await new Promise<void>((resolve) => { client.on('open', () => { resolve() }) })
    client.send(Buffer.alloc(8 * 1024 * 1024))
    client.send('after')
    await closed
    await upstream.close()
  })

  it('negotiates permessage-deflate on the downstream leg when wsCompression is enabled', async () => {
    await proxy?.close()
    proxy = await createRemoteProxy({
      targetPort: echoPort,
      policy: { authorize: () => ({ admitted: true }), handlePairing: () => false },
      wsCompression: true,
    })
    const client = new WebSocket('ws://127.0.0.1:' + String(proxy.port))
    const opened = new Promise<string>((resolve, reject) => {
      client.on('open', () => { resolve(client.extensions) })
      client.on('error', reject)
    })
    await expect(opened).resolves.toContain('permessage-deflate')
    client.close()
  })

  it('leaves the downstream leg uncompressed by default and when disabled', async () => {
    for (const wsCompression of [undefined, false]) {
      await proxy?.close()
      proxy = await createRemoteProxy({
        targetPort: echoPort,
        policy: { authorize: () => ({ admitted: true }), handlePairing: () => false },
        ...(wsCompression === undefined ? {} : { wsCompression }),
      })
      const client = new WebSocket('ws://127.0.0.1:' + String(proxy.port))
      const opened = new Promise<string>((resolve, reject) => {
        client.on('open', () => { resolve(client.extensions) })
        client.on('error', reject)
      })
      await expect(opened).resolves.not.toContain('permessage-deflate')
      client.close()
    }
  })

  it('shrinks downstream wire bytes for compressible payloads and preserves them', async () => {
    await proxy?.close()
    proxy = await createRemoteProxy({
      targetPort: echoPort,
      policy: { authorize: () => ({ admitted: true }), handlePairing: () => false },
      wsCompression: true,
    })
    // A transparent byte counter between the client and the proxy stands in
    // for the tunnel: every byte of the downstream leg passes through it.
    const counted = { bytes: 0 }
    const counter = await byteCountingRelay(proxy.port, counted)
    try {
      const payload = ('{"type":"stream/heartbeat","value":"' + 'x'.repeat(1024) + '"}\n').repeat(64)
      const plain = await roundTripBytes(counter.port, payload, { perMessageDeflate: false }, counted)
      const compressed = await roundTripBytes(counter.port, payload, { perMessageDeflate: true }, counted)
      expect(compressed.echoed).toBe(payload)
      expect(plain.echoed).toBe(payload)
      expect(compressed.bytes).toBeLessThan(plain.bytes / 4)
    } finally {
      await counter.close()
    }
  })
})

describe('teardown', () => {
  it('close stops the listener and survives a second call', async () => {
    const proxy = await startProxy()
    const port = proxy.port
    await proxy.close()
    await proxy.close()
    await expect(rawRequest(port, '/', { host: 'fake.tunnel.example' })).rejects.toThrow()
  })
})

describe('createAccessPolicy integration', () => {
  it('lets a paired cookie through the real proxy to the target', async () => {
    const secret = randomBytes(32)
    const devices = await DeviceRegistry.load(join(registryRoot!, 'devices.json'))
    const realPolicy = createAccessPolicy(secret, { devices, now: () => Date.now() })
    await proxy?.close()
    proxy = await createRemoteProxy({ targetPort, policy: realPolicy })
    const ticket = pairingTicket(secret, Date.now())
    const pair = await rawRequest(proxy.port, '/pair/' + ticket, { host: 'fake.tunnel.example' })
    expect(pair.status).toBe(302)
    const cookieHeader = pair.headers['set-cookie']
    const cookie = (Array.isArray(cookieHeader) ? (cookieHeader[0] ?? '') : cookieHeader ?? '').split(';')[0]!
    const unpaired = await rawRequest(proxy.port, '/', { host: 'fake.tunnel.example' })
    expect(unpaired.status).toBe(401)
    const paired = await rawRequest(proxy.port, '/', { host: 'fake.tunnel.example', cookie })
    expect(paired.status).toBe(201)
    await devices.flush()
  })

  it('echoes the gate cookie refresh beside the target set-cookie on a day rollover', async () => {
    const secret = randomBytes(32)
    let now = Date.UTC(2026, 7, 14, 23, 59, 0)
    const devices = await DeviceRegistry.load(join(registryRoot!, 'devices.json'))
    const realPolicy = createAccessPolicy(secret, { devices, now: () => now })
    await proxy?.close()
    let cookies: string[] = ['target=1; Path=/']
    const upstream = createServer((req, res) => {
      // /bare answers with no set-cookie: the refresh rides alone.
      // /multi answers with an array-shaped set-cookie beside the refresh.
      if (req.url === '/bare') {
        res.writeHead(200)
        res.end()
        return
      }
      if (req.url === '/multi') cookies = ['target=1; Path=/', 'target=2; Path=/']
      res.writeHead(200, { 'set-cookie': cookies.length === 1 ? cookies[0] : cookies })
      res.end()
    })
    await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve) })
    proxy = await createRemoteProxy({ targetPort: (upstream.address() as AddressInfo).port, policy: realPolicy })
    const ticket = pairingTicket(secret, now)
    const pair = await rawRequest(proxy.port, '/pair/' + ticket + '?name=Test%20Phone', { host: 'fake.tunnel.example' })
    const cookieHeader = pair.headers['set-cookie']
    const cookie = (Array.isArray(cookieHeader) ? (cookieHeader[0] ?? '') : cookieHeader ?? '').split(';')[0]!
    // Same UTC day: no refresh echo.
    const sameDay = await rawRequest(proxy.port, '/', { host: 'fake.tunnel.example', cookie })
    expect(sameDay.headers['set-cookie']).toEqual(['target=1; Path=/'])
    // Next UTC day: the refresh rides along, keeping the browser cookie alive.
    now = Date.UTC(2026, 7, 15, 0, 0, 30)
    const nextDay = await rawRequest(proxy.port, '/', { host: 'fake.tunnel.example', cookie })
    expect(nextDay.headers['set-cookie']).toEqual(['target=1; Path=/', cookie + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000'])
    // A response with no target set-cookie carries the refresh alone.
    const bare = await rawRequest(proxy.port, '/bare', { host: 'fake.tunnel.example', cookie })
    expect(bare.headers['set-cookie']).toBeUndefined()
    // An array-shaped target set-cookie merges with the refresh after it
    // (one more day rollover re-arms the refresh).
    now = Date.UTC(2026, 7, 16, 0, 0, 30)
    const multi = await rawRequest(proxy.port, '/multi', { host: 'fake.tunnel.example', cookie })
    expect(multi.headers['set-cookie']).toEqual(['target=1; Path=/', 'target=2; Path=/', cookie + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000'])
    // The bare path with a due refresh emits only the refresh cookie.
    now = Date.UTC(2026, 7, 17, 0, 0, 30)
    const bareRefresh = await rawRequest(proxy.port, '/bare', { host: 'fake.tunnel.example', cookie })
    expect(bareRefresh.headers['set-cookie']).toEqual([cookie + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000'])
    await devices.flush()
    await new Promise<void>((resolve) => { upstream.close(() => { resolve() }) })
  })
})

/**
 * A raw upstream that completes the WebSocket handshake and never reads again,
 * so a relayed send queue to it congests deterministically.
 * @returns its port and teardown.
 */
async function silentUpgradeServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>()
  const server = createNetServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
    socket.once('data', (chunk: Buffer) => {
      const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(chunk.toString('utf8'))?.[1]
      if (key === undefined) return
      const accept = createHash('sha1').update(key.trim() + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

/**
 * A raw upstream that accepts TCP, delays the WebSocket 101 by 200ms, and
 * reports the first frames it receives after the handshake — the deterministic
 * stand-in for an upstream whose handshake completes slowly.
 * @returns its port, a promise of post-handshake frame bytes, and teardown.
 */
async function delayedUpgradeServer(): Promise<{ port: number; received: Promise<Buffer[]>; close: () => Promise<void> }> {
  const sockets = new Set<Socket>()
  const frames: Buffer[] = []
  let notify!: (frames: Buffer[]) => void
  const received = new Promise<Buffer[]>((resolve) => { notify = resolve })
  const server = createNetServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
    let request: Buffer | undefined
    socket.on('data', (chunk: Buffer) => {
      if (request === undefined) {
        request = chunk
        const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(chunk.toString('utf8'))?.[1]
        if (key === undefined) return
        const accept = createHash('sha1').update(key.trim() + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        setTimeout(() => {
          socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
        }, 200)
        return
      }
      frames.push(chunk)
      notify(frames)
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    received,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

/** UTF-8 text of one ws message payload. */
function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8')
  return data.toString('utf8')
}

/**
 * A transparent TCP relay that counts every byte in both directions — the
 * stand-in for the tunnel on the downstream leg.
 * @param targetPort - the proxy port to relay into.
 * @param counted - the running byte counter.
 * @returns its own port, the count sink, and teardown.
 */
async function byteCountingRelay(targetPort: number, counted: { bytes: number }): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>()
  const server = createNetServer((downstream) => {
    sockets.add(downstream)
    downstream.on('close', () => { sockets.delete(downstream) })
    const upstream = connect(targetPort, '127.0.0.1')
    sockets.add(upstream)
    upstream.on('close', () => { sockets.delete(upstream) })
    downstream.on('data', (chunk) => { counted.bytes += chunk.length })
    upstream.on('data', (chunk) => { counted.bytes += chunk.length })
    downstream.pipe(upstream)
    upstream.pipe(downstream)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

/**
 * One WebSocket round trip through the byte counter: send the payload, wait
 * for the echo, close, and report the bytes the downstream leg carried.
 * @param port - the byte-counting relay port.
 * @param payload - the text frame to send.
 * @param options - client compression setting.
 * @param counted - the running byte counter.
 * @returns the echoed payload and the delta of counted bytes for this trip.
 */
async function roundTripBytes(
  port: number,
  payload: string,
  options: { perMessageDeflate: boolean },
  counted: { bytes: number },
): Promise<{ bytes: number; echoed: string }> {
  const before = counted.bytes
  const client = new WebSocket('ws://127.0.0.1:' + String(port), options)
  const echoed = new Promise<string>((resolve, reject) => {
    client.on('open', () => { client.send(payload) })
    client.on('message', (data) => { resolve(textOf(data)) })
    client.on('error', reject)
  })
  const text = await echoed
  client.close()
  // Let the close handshake pass the counter before reading the delta.
  await sleepMs(50)
  return { bytes: counted.bytes - before, echoed: text }
}
