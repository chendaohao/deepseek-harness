// Keyless remote-access lane: the pairing gate, the 401 pairing page, and the
// full browser pairing flow through the fake tunnel fixture — no network, no
// real cloudflared, no model calls.
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

// Mirrored from packages/remote/remote-access/src/secret.ts (pairingTicket):
// the lane cannot import package internals across project roots, and a drift
// between the two derivations fails this scenario loudly at pairing time.
function pairingTicket(secret: Buffer, now: number): string {
  const dayIndex = Math.floor(now / 86_400_000)
  return createHmac('sha256', secret).update('dsh-remote-ticket:v1:').update(String(dayIndex))
    .digest().subarray(0, 16).toString('base64url')
}

const MODE = webSnapshotMode()
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const FIXTURE_BIN = join(REPO_ROOT, 'apps/web/tests/support/fake-cloudflared.sh')
const FORWARDER = join(REPO_ROOT, 'apps/web/tests/support/fake-cloudflared-forwarder.mjs')
const FAKE_HOST = 'fake-slug.trycloudflare.com'
const FAKE_PORT = 39990
const FAKE_ORIGIN = 'https://' + FAKE_HOST + ':' + String(FAKE_PORT)

/** One raw HTTPS request through the fake tunnel with full header control. */
function tunnelRequest(
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: '127.0.0.1',
      port: FAKE_PORT,
      path,
      method: body === undefined ? 'GET' : 'POST',
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => { chunks.push(chunk as Buffer) })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }) })
    })
    req.on('error', reject)
    if (body === undefined) req.end()
    else req.end(body)
  })
}

describe.skipIf(MODE === 'record')('web e2e: remote access pairing', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let logSpy: MockInstance<(message?: unknown, ...args: unknown[]) => void>
  let ticket: string

  beforeAll(async () => {
    process.env.DSH_REMOTE_FIXTURE_BIN = FIXTURE_BIN
    process.env.REMOTE_FIXTURE_FORWARDER = FORWARDER
    logSpy = vi.spyOn(console, 'log')
    scaffold = await launchWebScaffold({
      extraOverlayPath: join(REPO_ROOT, 'apps/web/tests/remote-access.overlay.yml'),
    })
    const secret = await readFile(join(scaffold.harnessHome, 'secrets', 'remote-pair'))
    ticket = pairingTicket(secret, Date.now())
  }, 120_000)

  afterAll(async () => {
    delete process.env.DSH_REMOTE_FIXTURE_BIN
    delete process.env.REMOTE_FIXTURE_FORWARDER
    vi.restoreAllMocks()
    await browser?.close()
    await scaffold?.close()
  })

  it('prints the pairing URL line and a QR block on the terminal', async () => {
    const logged = (): string[] => logSpy.mock.calls.map(call => String(call[0]))
    const printedLine = 'dsh web remote: https://' + FAKE_HOST + '/pair/' + ticket
    await expect.poll(() => logged().includes(printedLine), { timeout: 15_000 }).toBe(true)
    expect(logged().some(line => /[█▀▄]{8,}/.test(line))).toBe(true)
  })

  it('answers 401 to unpaired visitors and pairs the browser into the app', async () => {
    browser = await chromium.launch({
      args: [
        '--host-resolver-rules=MAP ' + FAKE_HOST + ' 127.0.0.1',
        // The fixture terminates TLS with a self-signed test certificate; the
        // real tunnel's TLS is what the Secure cookie attribute protects.
        '--ignore-certificate-errors',
      ],
    })
    page = await browser.newPage()
    const pairHeading = (): ReturnType<Page['getByRole']> => page.getByRole('heading', { name: '需要配对' })
    const tripwire = watchConsole(page)
    await page.goto(FAKE_ORIGIN + '/', { waitUntil: 'load' })
    try {
      await pairHeading().waitFor({ state: 'visible', timeout: 15_000 })
    } catch (error) {
      await saveFailureShot(page, 'remote-access-step1')
      throw new Error('pair page did not appear; url: ' + page.url() + '; content: ' + (await page.content()).slice(0, 1200), { cause: error })
    }
    // A wrong ticket stays on the pairing page.
    await page.goto(FAKE_ORIGIN + '/pair/AAAA', { waitUntil: 'load' })
    await pairHeading().waitFor({ state: 'visible', timeout: 15_000 })
    // The correct day-scoped ticket pairs: 302 to /, then the app boots.
    await page.goto(FAKE_ORIGIN + '/pair/' + ticket, { waitUntil: 'load' })
    try {
      await page.waitForSelector('#root', { timeout: 30_000 })
    } catch (error) {
      await saveFailureShot(page, 'remote-access-pairing')
      throw new Error('app did not boot after pairing; console: ' + JSON.stringify(tripwire) + '; page: ' + (await page.content()).slice(0, 2000), { cause: error })
    }
    expect(await pairHeading().count()).toBe(0)
    const cookies = await browser.contexts()[0]!.cookies(FAKE_ORIGIN)
    const session = cookies.find(cookie => cookie.name === 'dsh_remote')
    expect(session).toBeDefined()
    expect(session!.httpOnly).toBe(true)
    expect(session!.secure).toBe(true)
    // A real RPC round trip through the normalized proxy: the /api fence and
    // the RPC bridge must serve the paired cookie exactly like a local caller.
    const rpc = await tunnelRequest('/api/session.list', {
      host: FAKE_HOST,
      cookie: 'dsh_remote=' + session!.value,
      'content-type': 'application/json',
    }, JSON.stringify({ type: 'client-request', rpcId: 'e2e-rpc-1', method: 'session.list', payload: {} }))
    expect(rpc.status).toBe(200)
    const envelope = JSON.parse(rpc.text) as { type: string; rpcId: string; result: { ok: boolean } }
    expect(envelope.type).toBe('server-response')
    expect(envelope.rpcId).toBe('e2e-rpc-1')
    expect(envelope.result.ok).toBe(true)
  }, 120_000)

  it('refuses spoofed loopback-shaped Hosts without a cookie', async () => {
    // The pairing cookie is the only credential: loopback-shaped Hosts are
    // indistinguishable from remote clients behind the tunnel, so both the
    // literal loopback address and a hostname merely starting with the prefix
    // must answer the pairing page.
    for (const host of ['127.0.0.1', '127.0.0.1.evil.com', '127.evil.com']) {
      const res = await tunnelRequest('/', { host })
      expect(res.status).toBe(401)
      expect(res.text).toContain('需要配对')
    }
  })

  it('reconnects the browser streams automatically after the tunnel drops the sockets', async () => {
    const stats = async (): Promise<{ upgrades: number }> => {
      const response = await fetch('http://127.0.0.1:39991/stats')
      return response.json() as Promise<{ upgrades: number }>
    }
    const before = await stats()
    const tripwire = watchConsole(page)
    // Tunnel-side drop: every live WebSocket pair dies without a close frame
    // reaching the browser — the remote-access failure mode for a phone
    // network switch. The client detects the loss and reopens both downlinks
    // through the still-healthy tunnel.
    await fetch('http://127.0.0.1:39991/kill', { method: 'POST' })
    await expect.poll(
      () => tripwire.warnings.some(warning => warning.includes('connection lost')),
      { timeout: 20_000 },
    ).toBe(true)
    await expect.poll(async () => (await stats()).upgrades, { timeout: 20_000 }).toBeGreaterThanOrEqual(before.upgrades + 2)
    expect(tripwire.pageErrors).toEqual([])
  })
})
