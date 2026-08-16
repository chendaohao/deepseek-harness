import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import qrcode from 'qrcode-terminal'
import RemoteAccess, { internals } from '../src/index.ts'
import { pairingTicket } from '../src/secret.ts'

vi.mock('qrcode-terminal', () => ({
  default: { generate: vi.fn((text: string, _options: unknown, done: (qr: string) => void) => { done('QR:' + text) }) },
}))

interface FakeSession { url: string; close: ReturnType<typeof vi.fn> }

/** Controllable remoteTunnel stand-in recording opens and returned sessions. */
function fakeTunnel() {
  const opens: number[] = []
  const sessions: FakeSession[] = []
  let url = 'https://fake-slug.trycloudflare.com'
  return {
    open: vi.fn(async (port: number) => {
      opens.push(port)
      const session: FakeSession = { url, close: vi.fn(async () => {}) }
      sessions.push(session)
      return session
    }),
    setUrl(value: string): void { url = value },
    get sessionList(): FakeSession[] { return sessions },
    get openPorts(): number[] { return opens },
  }
}

let root: string | undefined
let context: Context | undefined
let target: Server | undefined
let targetPort = 0
let tunnel: ReturnType<typeof fakeTunnel>
let saved: typeof internals
let logSpy: ReturnType<typeof vi.spyOn>
let shellEnvRegister: ReturnType<typeof vi.fn<(contributor: unknown) => () => void>>
let unprovideWebServer: () => void

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-remote-access-'))
  process.env.DSH_HOME = root
  saved = { ...internals }
  tunnel = fakeTunnel()
  target = createServer((req, res) => { res.writeHead(200); res.end('target:' + (req.url ?? '')) })
  await new Promise<void>((resolve) => { target!.listen(0, '127.0.0.1', resolve) })
  targetPort = (target.address() as AddressInfo).port
  context = new Context()
  unprovideWebServer = context.provide('webServer', { port: targetPort, host: '127.0.0.1' })
  context.provide('remoteTunnel', tunnel)
  shellEnvRegister = vi.fn<(contributor: unknown) => () => void>(() => () => {})
  context.provide('shellEnv', { register: shellEnvRegister })
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  internals.restartMax = saved.restartMax
  internals.restartBackoffBaseMs = saved.restartBackoffBaseMs
  delete process.env.DSH_HOME
  vi.restoreAllMocks()
  await context?.fiber.dispose()
  context = undefined
  await new Promise<void>((resolve) => { target?.close(() => { resolve() }) })
  target = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(config: { enabled?: boolean; resetSecret?: boolean; wsCompression?: boolean } = {}): Promise<void> {
  await context!.plugin(RemoteAccess, { enabled: true, resetSecret: false, wsCompression: true, ...config })
}

interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function rawRequest(port: number, path: string, headers: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => { chunks.push(chunk as Buffer) })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }) })
    })
    req.on('error', reject)
    req.end()
  })
}

async function readSecret(): Promise<Buffer> {
  return readFile(join(root!, 'secrets', 'remote-pair'))
}

describe('disabled', () => {
  it('registers nothing and starts nothing', async () => {
    await boot({ enabled: false })
    expect(tunnel.open).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()
    expect(shellEnvRegister).not.toHaveBeenCalled()
  })
})

describe('enabled', () => {
  it('opens a tunnel over the proxy port, prints the pair URL and QR, and relays loopback requests', async () => {
    await boot()
    const proxyPort = tunnel.openPorts[0]!
    expect(proxyPort).toBeGreaterThan(0)
    const secret = await readSecret()
    const ticket = pairingTicket(secret, Date.now())
    const pairUrl = 'https://fake-slug.trycloudflare.com/pair/' + ticket
    expect(logSpy).toHaveBeenCalledWith('dsh web remote: ' + pairUrl)
    expect((qrcode.generate as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(pairUrl, { small: true }, expect.any(Function))
    expect(logSpy).toHaveBeenCalledWith('QR:' + pairUrl)
    // Every request needs the pairing cookie — loopback-shaped Hosts included,
    // because behind the tunnel all connections arrive from the loopback
    // address and the Host header is client-controlled.
    const loopbackUnpaired = await rawRequest(proxyPort, '/echo', { host: '127.0.0.1' })
    expect(loopbackUnpaired.status).toBe(401)
    const spoofedUnpaired = await rawRequest(proxyPort, '/echo', { host: '127.0.0.1.evil.com' })
    expect(spoofedUnpaired.status).toBe(401)
    const unpaired = await rawRequest(proxyPort, '/echo', { host: 'fake.tunnel.example' })
    expect(unpaired.status).toBe(401)
    const paired = await rawRequest(proxyPort, '/pair/' + ticket, { host: 'fake.tunnel.example' })
    expect(paired.status).toBe(302)
    const cookie = String(paired.headers['set-cookie']).split(';')[0]!
    const withCookie = await rawRequest(proxyPort, '/echo', { host: 'fake.tunnel.example', cookie })
    expect(withCookie.status).toBe(200)
    const loopbackWithCookie = await rawRequest(proxyPort, '/echo', { host: '127.0.0.1', cookie })
    expect(loopbackWithCookie.status).toBe(200)
    // DSH_REMOTE_URL resolves to the live session URL.
    const contributor = shellEnvRegister.mock.calls[0]?.[0] as { resolve: (execution: unknown) => Record<string, string> }
    expect(contributor.resolve({})).toEqual({ DSH_REMOTE_URL: 'https://fake-slug.trycloudflare.com' })
  })

  it('restarts the tunnel after an unexpected exit and reprints the URL', async () => {
    internals.restartBackoffBaseMs = 1
    await boot()
    expect(tunnel.openPorts).toHaveLength(1)
    tunnel.setUrl('https://replacement-slug.trycloudflare.com')
    context!.emit('remote-tunnel/state', { status: 'ended' })
    await expect.poll(() => tunnel.openPorts.length, { timeout: 2_000 }).toBe(2)
    const secret = await readSecret()
    const ticket = pairingTicket(secret, Date.now())
    expect(logSpy).toHaveBeenCalledWith('dsh web remote: https://replacement-slug.trycloudflare.com/pair/' + ticket)
    const contributor = shellEnvRegister.mock.calls[0]?.[0] as { resolve: (execution: unknown) => Record<string, string> }
    expect(contributor.resolve({})).toEqual({ DSH_REMOTE_URL: 'https://replacement-slug.trycloudflare.com' })
  })

  it('skips a restart scheduled after disposal', async () => {
    internals.restartBackoffBaseMs = 20
    await boot()
    context!.emit('remote-tunnel/state', { status: 'ended' })
    await context!.fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(tunnel.openPorts).toHaveLength(1)
  })

  it('gives up restarting when the restart budget is zero', async () => {
    internals.restartBackoffBaseMs = 1
    internals.restartMax = 0
    await boot()
    expect(tunnel.openPorts).toHaveLength(1)
    context!.emit('remote-tunnel/state', { status: 'ended' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(tunnel.openPorts).toHaveLength(1)
  })

  it('maps the wildcard webserver bind to the loopback relay target', async () => {
    unprovideWebServer()
    context!.provide('webServer', { port: targetPort, host: '0.0.0.0' })
    await boot()
    const proxyPort = tunnel.openPorts[0]!
    const secret = await readSecret()
    const ticket = pairingTicket(secret, Date.now())
    const paired = await rawRequest(proxyPort, '/pair/' + ticket, { host: 'fake.tunnel.example' })
    expect(paired.status).toBe(302)
    const cookie = String(paired.headers['set-cookie']).split(';')[0]!
    const relayed = await rawRequest(proxyPort, '/echo', { host: 'fake.tunnel.example', cookie })
    expect(relayed.status).toBe(200)
    expect(relayed.body).toBe('target:/echo')
  })

  it('rotates the pairing secret when resetSecret is set', async () => {
    await mkdir(join(root!, 'secrets'), { recursive: true })
    await writeFile(join(root!, 'secrets', 'remote-pair'), Buffer.alloc(32, 7))
    await boot({ resetSecret: true })
    expect(await readSecret()).not.toEqual(Buffer.alloc(32, 7))
  })

  it('dispose closes the session and the proxy', async () => {
    await boot()
    const proxyPort = tunnel.openPorts[0]!
    await context!.fiber.dispose()
    expect(tunnel.sessionList[0]!.close).toHaveBeenCalled()
    await expect(rawRequest(proxyPort, '/', { host: '127.0.0.1' })).rejects.toThrow()
  })

  it('keeps boot alive when the tunnel cannot start', async () => {
    tunnel.open.mockRejectedValue(new Error('no binary'))
    await boot()
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error tunnel failure into the log', async () => {
    tunnel.open.mockRejectedValue('string failure')
    await boot()
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('closes a session that opens after disposal', async () => {
    let resolveOpen!: (session: FakeSession) => void
    tunnel.open.mockImplementationOnce(async () => new Promise<FakeSession>((resolve) => { resolveOpen = resolve }))
    await boot()
    await context!.fiber.dispose()
    const session: FakeSession = { url: 'https://late.trycloudflare.com', close: vi.fn(async () => {}) }
    resolveOpen(session)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(session.close).toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()
  })
})

describe('loader settlement', () => {
  it('defers the tunnel open until the loader settles', async () => {
    let settle!: () => void
    const pending = new Promise<void>((resolve) => { settle = resolve })
    context!.provide('loader', { await: () => pending } as never)
    await boot()
    expect(tunnel.openPorts).toHaveLength(0)
    const contributor = shellEnvRegister.mock.calls[0]?.[0] as { resolve: (execution: unknown) => Record<string, string> }
    expect(contributor.resolve({})).toEqual({})
    settle()
    await expect.poll(() => tunnel.openPorts.length, { timeout: 2_000 }).toBe(1)
  })

  it('stays quiet when the webserver row tears down during settlement', async () => {
    let settle!: () => void
    const pending = new Promise<void>((resolve) => { settle = resolve })
    context!.provide('loader', { await: () => pending } as never)
    await boot()
    unprovideWebServer()
    settle()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(tunnel.openPorts).toHaveLength(0)
  })

  it('stays quiet when the loader reports a failed boot', async () => {
    context!.provide('loader', { await: () => Promise.reject(new Error('boot failed')) } as never)
    await boot()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(tunnel.openPorts).toHaveLength(0)
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('stays quiet when the tree tears down during settlement', async () => {
    let settle!: () => void
    const pending = new Promise<void>((resolve) => { settle = resolve })
    context!.provide('loader', { await: () => pending } as never)
    await boot()
    await context!.fiber.dispose()
    settle()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(tunnel.openPorts).toHaveLength(0)
  })

  it('binds one device per pairing and lists it through the Remote service', async () => {
    await boot()
    const proxyPort = tunnel.openPorts[0]!
    const secret = await readSecret()
    const ticket = pairingTicket(secret, Date.now())
    // Two pairings: an explicit phone name and a browser User-Agent.
    await rawRequest(proxyPort, '/pair/' + ticket + '?name=' + encodeURIComponent('Pixel 8'), {
      host: 'fake.tunnel.example', 'user-agent': 'Expo/57 android',
    })
    const browserPair = await rawRequest(proxyPort, '/pair/' + ticket, {
      host: 'fake.tunnel.example', 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/126',
    })
    expect(browserPair.status).toBe(302)
    const gateway = context!.get('remoteAccessDevices') as {
      list(): { devices: { deviceId: string; label: string; expiresAt: number }[] }
      unbind(deviceId: string): { removed: boolean }
    }
    const listed = gateway.list()
    // Same-millisecond pairings tie on lastUsedAt: assert membership, not order.
    expect(listed.devices.map(device => device.label).sort()).toEqual(['Mozilla/5.0 (Macintosh) Chrome/126', 'Pixel 8'])
    expect(listed.devices[0]!.expiresAt).toBeGreaterThan(Date.now())
    // The browser cookie relays; the phone cookie relays.
    const browserCookie = String(browserPair.headers['set-cookie']).split(';')[0]!
    expect((await rawRequest(proxyPort, '/echo', { host: 'x', cookie: browserCookie })).status).toBe(200)
    // Unbinding the browser device drops it from the list and gates its cookie.
    const browserId = listed.devices.find(device => device.label === 'Mozilla/5.0 (Macintosh) Chrome/126')!.deviceId
    expect(gateway.unbind(browserId)).toEqual({ removed: true })
    expect(gateway.list().devices.map(device => device.deviceId)).not.toContain(browserId)
    expect((await rawRequest(proxyPort, '/echo', { host: 'x', cookie: browserCookie })).status).toBe(401)
    // The registry file persists under the harness home beside the secret.
    const file = JSON.parse(await readFile(join(root!, 'secrets', 'remote-devices.json'), 'utf8')) as { devices: unknown[] }
    expect(file.devices).toHaveLength(1)
  })

  it('resetSecret clears every binding with the rotated secret', async () => {
    await boot()
    const proxyPort = tunnel.openPorts[0]!
    const secret = await readSecret()
    const ticket = pairingTicket(secret, Date.now())
    const paired = await rawRequest(proxyPort, '/pair/' + ticket + '?name=Phone', { host: 'fake.tunnel.example' })
    const cookie = String(paired.headers['set-cookie']).split(';')[0]!
    await context!.fiber.dispose()
    // Re-boot with reset: the rotated secret invalidates the cookie and the
    // registry starts empty.
    context = new Context()
    unprovideWebServer = context.provide('webServer', { port: targetPort, host: '127.0.0.1' })
    context.provide('remoteTunnel', tunnel)
    context.provide('shellEnv', { register: shellEnvRegister })
    await boot({ resetSecret: true })
    const rotatedPort = tunnel.openPorts[tunnel.openPorts.length - 1]!
    expect((await rawRequest(rotatedPort, '/echo', { host: 'x', cookie })).status).toBe(401)
    const gateway = context.get('remoteAccessDevices') as { list(): { devices: unknown[] } }
    expect(gateway.list().devices).toEqual([])
  })
})

