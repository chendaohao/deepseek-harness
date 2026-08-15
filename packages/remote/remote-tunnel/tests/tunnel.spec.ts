import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import RemoteTunnel, { internals, type Config, type RemoteTunnelState } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined
let saved: typeof internals

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-remote-tunnel-'))
  process.env.DSH_HOME = root
  context = new Context()
  saved = { ...internals, assets: internals.assets, backoffMs: internals.backoffMs }
})

afterEach(async () => {
  internals.urlTimeoutMs = saved.urlTimeoutMs
  internals.maxAttempts = saved.maxAttempts
  internals.backoffMs = [...saved.backoffMs]
  internals.termGraceMs = saved.termGraceMs
  internals.scanBytes = saved.scanBytes
  internals.stderrTailBytes = saved.stderrTailBytes
  internals.maxDownloadBytes = saved.maxDownloadBytes
  internals.downloadTimeoutMs = saved.downloadTimeoutMs
  internals.assets = saved.assets
  delete process.env.DSH_HOME
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write one executable shell fixture into the test root. */
async function script(name: string, body: string): Promise<string> {
  const path = join(root!, name)
  await writeFile(path, body)
  await chmod(path, 0o755)
  return path
}

/** Collect every remote-tunnel/state payload emitted after this call. */
function stateEvents(): RemoteTunnelState[] {
  const events: RemoteTunnelState[] = []
  context!.on('remote-tunnel/state', (state) => { events.push(state) })
  return events
}

async function withService(config: Config): Promise<RemoteTunnel> {
  await context!.plugin(RemoteTunnel, config)
  return context!.remoteTunnel
}

describe('config validation', () => {
  it('fails the load on download "deny" without a binaryPath', async () => {
    await expect(context!.plugin(RemoteTunnel, { enabled: true, download: 'deny' }))
      .rejects.toThrow(/download "deny" requires an explicit binaryPath/)
  })

  it('fails the load on a binaryPath that does not exist', async () => {
    await expect(context!.plugin(RemoteTunnel, { enabled: true, binaryPath: join(root!, 'missing') }))
      .rejects.toThrow(/does not exist/)
  })

  it('refuses open while disabled', async () => {
    const service = await withService({ enabled: false, download: 'system' })
    await expect(service.open(12_345)).rejects.toThrow(/disabled/)
  })

  it('rejects non-integral or out-of-range ports', async () => {
    const binary = await script('idle.sh', '#!/bin/sh\nsleep 60\n')
    const service = await withService({ enabled: true, binaryPath: binary })
    await expect(service.open(0)).rejects.toThrow(/invalid tunnel port/)
    await expect(service.open(65_536)).rejects.toThrow(/invalid tunnel port/)
    await expect(service.open(1.5)).rejects.toThrow(/invalid tunnel port/)
  })
})

describe('spawn and URL discovery', () => {
  it('parses the URL out of a banner line and closes the child', async () => {
    const binary = await script('print-url.sh', [
      '#!/bin/sh',
      "echo '2026-08-14T00:00:00Z INF Your quick Tunnel has been created! Visit it at:'",
      "echo 'https://fake-slug.trycloudflare.com'",
      'sleep 60',
      '',
    ].join('\n'))
    internals.urlTimeoutMs = 2_000
    const events = stateEvents()
    const service = await withService({ enabled: true, download: 'deny', binaryPath: binary })
    const session = await service.open(12_345)
    expect(session.url).toBe('https://fake-slug.trycloudflare.com')
    expect(events).toEqual([{ status: 'open', url: 'https://fake-slug.trycloudflare.com' }])
    await session.close()
    await session.close()
  })

  it('parses the URL out of an stderr banner line (real cloudflared logs to stderr)', async () => {
    const binary = await script('stderr-url.sh', [
      '#!/bin/sh',
      "echo '2026-08-14T00:00:00Z INF Your quick Tunnel has been created! Visit it at:' >&2",
      "echo 'https://stderr-slug.trycloudflare.com' >&2",
      'sleep 60',
      '',
    ].join('\n'))
    internals.urlTimeoutMs = 2_000
    const service = await withService({ enabled: true, binaryPath: binary })
    const session = await service.open(12_345)
    expect(session.url).toBe('https://stderr-slug.trycloudflare.com')
    await session.close()
  })

  it('reports ended after the child exits on its own', async () => {
    const binary = await script('print-url-exit.sh', [
      '#!/bin/sh',
      "echo 'https://exit-slug.trycloudflare.com'",
      'exit 0',
      '',
    ].join('\n'))
    internals.urlTimeoutMs = 2_000
    const ended = new Promise<RemoteTunnelState>((resolve) => {
      context!.on('remote-tunnel/state', (state) => { if (state.status === 'ended') resolve(state) })
    })
    const service = await withService({ enabled: true, binaryPath: binary })
    const session = await service.open(12_345)
    await expect(ended).resolves.toEqual({ status: 'ended' })
    expect(session.url).toBe('https://exit-slug.trycloudflare.com')
  })

  it('retries without sleeping when the backoff table is exhausted', async () => {
    const binary = await script('exit-error.sh', [
      '#!/bin/sh',
      "echo 'boom: no tunnel for you' >&2",
      'exit 1',
      '',
    ].join('\n'))
    internals.maxAttempts = 3
    internals.backoffMs = []
    internals.urlTimeoutMs = 2_000
    const service = await withService({ enabled: true, binaryPath: binary })
    await expect(service.open(12_345)).rejects.toThrow(/no tunnel URL after 3 attempts/)
  })

  it('includes the stderr tail in the final failure message', async () => {
    const binary = await script('exit-silent.sh', '#!/bin/sh\nexit 3\n')
    internals.maxAttempts = 1
    internals.urlTimeoutMs = 2_000
    const service = await withService({ enabled: true, binaryPath: binary })
    await expect(service.open(12_345)).rejects.toThrow(/\(no stderr\)/)
  })

  it('stops scanning at the bounded window and times out', async () => {
    const binary = await script('noisy.sh', '#!/bin/sh\necho aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsleep 0.2\necho bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nsleep 60\n')
    internals.maxAttempts = 1
    internals.scanBytes = 8
    internals.urlTimeoutMs = 1_000
    const service = await withService({ enabled: true, binaryPath: binary })
    await expect(service.open(12_345)).rejects.toThrow(/timed out waiting for the tunnel URL/)
  })

  it('retries after early exit and fails with the stderr tail', async () => {
    const binary = await script('exit-error.sh', [
      '#!/bin/sh',
      "echo 'boom: no tunnel for you' >&2",
      'exit 1',
      '',
    ].join('\n'))
    internals.maxAttempts = 2
    internals.backoffMs = [1, 1]
    internals.urlTimeoutMs = 2_000
    const events = stateEvents()
    const service = await withService({ enabled: true, binaryPath: binary })
    await expect(service.open(12_345)).rejects.toThrow(/no tunnel URL after 2 attempts/)
    await expect(service.open(12_345)).rejects.toThrow(/boom: no tunnel for you/)
    expect(events.filter(event => event.status === 'failed')).toHaveLength(2)
  })

  it('kills a silent child on the per-attempt timeout', async () => {
    const binary = await script('hang.sh', '#!/bin/sh\necho noise-ignored-by-the-url-scan\nsleep 60\n')
    internals.maxAttempts = 1
    internals.urlTimeoutMs = 100
    const service = await withService({ enabled: true, binaryPath: binary })
    await expect(service.open(12_345)).rejects.toThrow(/timed out waiting for the tunnel URL/)
  })

  it('stops spawning attempts when close lands during start', async () => {
    const marker = join(root!, 'starts')
    process.env.TUNNEL_START_MARKER = marker
    const binary = await script('slow-url.sh', [
      '#!/bin/sh',
      'echo started >> "$TUNNEL_START_MARKER"',
      'sleep 0.4',
      "echo 'https://slow-slug.trycloudflare.com'",
      'sleep 60',
      '',
    ].join('\n'))
    internals.urlTimeoutMs = 5_000
    internals.maxAttempts = 3
    internals.backoffMs = [1, 1]
    const events = stateEvents()
    const service = await withService({ enabled: true, binaryPath: binary })
    const opening = service.open(12_345)
    // The first attempt is mid-flight when disposal closes the session.
    await new Promise(resolve => setTimeout(resolve, 120))
    await context!.fiber.dispose()
    await opening
    await new Promise(resolve => setTimeout(resolve, 100))
    const starts = (await readFile(marker, 'utf8')).trim().split('\n').filter(Boolean)
    expect(starts).toHaveLength(1)
    expect(events).toEqual([])
    delete process.env.TUNNEL_START_MARKER
  })

  it('ends the attempt loop quietly when close lands inside the last attempt', async () => {
    // A silent child keeps the attempt pending until the timeout; disposal
    // lands during that wait, so the loop ends on the settled guard instead
    // of reporting a failed session.
    const binary = await script('hang-silent.sh', '#!/bin/sh\nsleep 60\n')
    internals.maxAttempts = 1
    internals.urlTimeoutMs = 1_000
    const events = stateEvents()
    const service = await withService({ enabled: true, binaryPath: binary })
    const opening = service.open(12_345)
    await new Promise(resolve => setTimeout(resolve, 80))
    await context!.fiber.dispose()
    await opening
    expect(events).toEqual([])
  })
})

describe('teardown and dispose', () => {
  it('escalates to SIGKILL when the child traps SIGTERM, without an ended event', async () => {
    const binary = await script('trap-term.sh', [
      '#!/bin/sh',
      "echo 'https://trap-slug.trycloudflare.com'",
      "trap '' TERM",
      'sleep 60',
      '',
    ].join('\n'))
    internals.urlTimeoutMs = 2_000
    internals.termGraceMs = 100
    const events = stateEvents()
    const service = await withService({ enabled: true, binaryPath: binary })
    const session = await service.open(12_345)
    await session.close()
    expect(events).toEqual([{ status: 'open', url: 'https://trap-slug.trycloudflare.com' }])
  })

  it('dispose awaits live children and reaches quiescence', async () => {
    const marker = join(root!, 'dead')
    process.env.TUNNEL_TEST_MARKER = marker
    const binary = await script('dispose.sh', [
      '#!/bin/sh',
      "echo 'https://dispose-slug.trycloudflare.com'",
      "trap 'echo dead > \"$TUNNEL_TEST_MARKER\"; exit 0' TERM",
      'while :; do sleep 1; done',
      '',
    ].join('\n'))
    internals.urlTimeoutMs = 2_000
    const service = await withService({ enabled: true, binaryPath: binary })
    const session = await service.open(12_345)
    expect(session.url).toContain('dispose-slug')
    await context!.fiber.dispose()
    await expect.poll(() => existsSync(marker), { timeout: 2_000 }).toBe(true)
    delete process.env.TUNNEL_TEST_MARKER
  })
})

describe('binary sourcing', () => {
  const PRINT_URL_SCRIPT = [
    '#!/bin/sh',
    "echo 'https://installed-slug.trycloudflare.com'",
    'sleep 60',
    '',
  ].join('\n')

  it('fails the attempt when the PATH binary cannot spawn', async () => {
    const service = await withService({ enabled: true, download: 'system' })
    internals.maxAttempts = 1
    internals.urlTimeoutMs = 100
    await expect(service.open(12_345)).rejects.toThrow(/ENOENT/)
  })

  it('fails the open when no asset covers the host platform', async () => {
    internals.assets = {}
    const service = await withService({ enabled: true })
    await expect(service.open(12_345)).rejects.toThrow(/no cloudflared asset for platform/)
  })

  it('rejects a download whose bytes do not match the pinned hash', async () => {
    const key = process.platform + '-' + process.arch
    internals.assets = {
      [key]: { asset: 'cloudflared-fake', sha256: 'a'.repeat(64) },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamingResponse('wrong bytes')))
    const service = await withService({ enabled: true })
    await expect(service.open(12_345)).rejects.toThrow(/failed its SHA-256 check/)
  })

  it('rejects an HTTP failure while downloading', async () => {
    const key = process.platform + '-' + process.arch
    internals.assets = {
      [key]: { asset: 'cloudflared-fake', sha256: 'a'.repeat(64) },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    const service = await withService({ enabled: true })
    await expect(service.open(12_345)).rejects.toThrow(/failed with HTTP 500/)
  })

  it('aborts a download that never completes', async () => {
    const key = process.platform + '-' + process.arch
    internals.assets = {
      [key]: { asset: 'cloudflared-fake', sha256: 'a'.repeat(64) },
    }
    internals.downloadTimeoutMs = 50
    // The fetch never settles on its own; only the abort signal ends it.
    vi.stubGlobal('fetch', vi.fn((_url: string, options?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
      })))
    const service = await withService({ enabled: true })
    await expect(service.open(12_345)).rejects.toThrow(/timed out after 50 ms/)
  })

  it('rejects a download over the size bound', async () => {
    const key = process.platform + '-' + process.arch
    internals.assets = {
      [key]: { asset: 'cloudflared-fake', sha256: 'a'.repeat(64) },
    }
    internals.maxDownloadBytes = 4
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamingResponse('0123456789')))
    const service = await withService({ enabled: true })
    await expect(service.open(12_345)).rejects.toThrow(/exceeds the 4-byte download bound/)
  })

  it('installs a verified raw binary into the cache and spawns it', async () => {
    const bytes = Buffer.from(PRINT_URL_SCRIPT)
    const key = process.platform + '-' + process.arch
    internals.assets = {
      [key]: { asset: 'cloudflared-fake', sha256: createHash('sha256').update(bytes).digest('hex') },
    }
    const fetchMock = vi.fn().mockResolvedValue(streamingResponse(bytes))
    vi.stubGlobal('fetch', fetchMock)
    internals.urlTimeoutMs = 2_000
    const service = await withService({ enabled: true })
    const session = await service.open(12_345)
    expect(session.url).toBe('https://installed-slug.trycloudflare.com')
    await session.close()
    // The verified cache answers the second open without another download.
    const second = await service.open(12_345)
    expect(second.url).toBe('https://installed-slug.trycloudflare.com')
    await second.close()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails loud when the tgz cannot be extracted', async () => {
    const garbage = Buffer.from('not a gzip archive')
    const key = process.platform + '-' + process.arch
    internals.assets = {
      [key]: { asset: 'cloudflared-fake.tgz', sha256: createHash('sha256').update(garbage).digest('hex'), archive: 'tgz' },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamingResponse(garbage)))
    const service = await withService({ enabled: true })
    await expect(service.open(12_345)).rejects.toThrow(/tar failed to extract/)
  })

  it('extracts the macOS tgz asset through the system tar', async () => {
    const scriptBytes = Buffer.from(PRINT_URL_SCRIPT)
    const tgz = makeTgz('cloudflared', scriptBytes)
    const key = process.platform + '-' + process.arch
    internals.assets = {
      [key]: { asset: 'cloudflared-fake.tgz', sha256: createHash('sha256').update(tgz).digest('hex'), archive: 'tgz' },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamingResponse(tgz)))
    internals.urlTimeoutMs = 2_000
    const service = await withService({ enabled: true })
    const session = await service.open(12_345)
    expect(session.url).toBe('https://installed-slug.trycloudflare.com')
    await session.close()
  })
})

/** One fetch response whose body streams the given bytes, like the real release download. */
function streamingResponse(body: string | Buffer): {
  ok: boolean
  status: number
  body: AsyncGenerator<Buffer>
} {
  return {
    ok: true,
    status: 200,
    body: (async function* () { yield Buffer.from(body) })(),
  }
}

/** Build a minimal single-entry gzipped ustar archive for extraction fixtures. */
function makeTgz(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000755\0', 100, 'utf8')
  header.write('0000000\0', 108, 'utf8')
  header.write('0000000\0', 116, 'utf8')
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8')
  header.write('00000000000\0', 136, 'utf8')
  header.write('        ', 148, 'utf8')
  header.write('0', 156, 'utf8')
  header.write('ustar\0', 257, 'utf8')
  header.write('00', 263, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8')
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512)
  content.copy(padded)
  return gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]))
}

