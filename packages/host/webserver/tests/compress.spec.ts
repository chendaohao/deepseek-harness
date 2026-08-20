/**
 * REAL-composition coverage for response compression: a test-only cordis.yml
 * booted through the vendored Loader mounts the webserver row, and every
 * assertion observes the served HTTP surface — brotli/gzip negotiation,
 * threshold and MIME gating, SSE passthrough, content-length removal, Vary,
 * and the no-compression path when the client sends no Accept-Encoding.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { connect } from 'node:net'
import { gunzipSync, brotliDecompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '../src/index.ts'

const BODY = 'export const s = "dsh-compression-spec-' + 'x'.repeat(2048) + '"'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(compression: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-webserver-compress-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    `    compression: '${compression}'`,
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  const server = context.webServer
  server.register({
    kind: 'exact',
    path: '/big',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': String(Buffer.byteLength(BODY)) })
      res.end(BODY)
    },
  })
  server.register({
    kind: 'exact',
    path: '/small',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '12' })
      res.end('hello world!')
    },
  })
  server.register({
    kind: 'exact',
    path: '/binary',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([0, 1, 2, 3, 4, 5]))
    },
  })
  server.register({
    kind: 'exact',
    path: '/sse',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: one\n\n')
      res.end('data: two\n\n')
    },
  })
  // Streams a compressible body far larger than the codec's writable buffer,
  // using the write-return + drain-wait pattern the /api bridge relies on. A
  // facade that buffers codec output until end() deadlocks this handler (the
  // socket never drains), so this route guards the streaming backpressure path.
  server.register({
    kind: 'exact',
    path: '/stream',
    handler: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      const chunk = 'y'.repeat(64 * 1024)
      for (let i = 0; i < 16; i++) {
        if (!res.write(chunk)) {
          await new Promise<void>((resolve) => {
            const done = (): void => { res.off('drain', done); res.off('close', done); resolve() }
            res.once('drain', done)
            res.once('close', done)
          })
        }
      }
      res.end()
    },
  })
  return context
}

/** One raw HTTP response: status, decoded wire body, and lowercase headers. */
interface RawResult {
  status: number
  bytes: Buffer
  headers: Record<string, string>
}

/**
 * GET one path with optional headers over a raw socket, returning the wire
 * bytes and headers. The fetch client auto-decodes compressed bodies, so the
 * assertions read the transport itself.
 */
async function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<RawResult> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  const headerLines = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${String(port)}`,
    'Connection: close',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ].join('\r\n')
  socket.write(headerLines)
  const result = await new Promise<RawResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('raw request timed out'))
    }, 10_000)
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      const whole = Buffer.concat(chunks)
      const headEnd = whole.indexOf('\r\n\r\n')
      const headText = whole.subarray(0, headEnd).toString('latin1')
      const status = Number(/HTTP\/1\.[01] (\d+)/.exec(headText)?.[1] ?? 0)
      const out: Record<string, string> = {}
      for (const line of headText.split('\r\n').slice(1)) {
        const colon = line.indexOf(':')
        if (colon === -1) continue
        out[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      let body = whole.subarray(headEnd + 4)
      // The compressed responses carry no content-length, so the server uses
      // chunked framing; de-chunk the wire body for the byte-level assertions.
      if (out['transfer-encoding'] === 'chunked') {
        const decoded: Buffer[] = []
        let cursor = 0
        while (cursor < body.length) {
          const lineEnd = body.indexOf('\r\n', cursor)
          if (lineEnd === -1) break
          const size = Number.parseInt(body.subarray(cursor, lineEnd).toString('latin1'), 16)
          if (!Number.isFinite(size) || size < 0) break
          if (size === 0) break
          decoded.push(body.subarray(lineEnd + 2, lineEnd + 2 + size))
          cursor = lineEnd + 2 + size + 2
        }
        body = Buffer.concat(decoded)
      }
      resolve({ status, bytes: body, headers: out })
    })
    socket.on('error', reject)
  })
  socket.destroy()
  return result
}

describe('compression negotiation and gating', () => {
  it('serves brotli to an accepting client, dropping content-length and adding Vary', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition('auto')
    const got = await raw(loaded.webServer.port, '/big', { 'accept-encoding': 'gzip, deflate, br' })
    expect(got.status).toBe(200)
    expect(got.headers['content-encoding']).toBe('br')
    expect(got.headers.vary).toContain('accept-encoding')
    expect(got.headers['content-length']).toBeUndefined()
    const decoded = brotliDecompressSync(got.bytes)
    expect(decoded.toString()).toBe(BODY)
    expect(got.bytes.length).toBeLessThan(Buffer.byteLength(BODY))
  })

  it('falls back to gzip when the client does not accept brotli', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition('auto')
    const got = await raw(loaded.webServer.port, '/big', { 'accept-encoding': 'gzip' })
    expect(got.headers['content-encoding']).toBe('gzip')
    const decoded = gunzipSync(got.bytes)
    expect(decoded.toString()).toBe(BODY)
  })

  it('serves identity when the client explicitly accepts identity only', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition('auto')
    const got = await raw(loaded.webServer.port, '/big', { 'accept-encoding': 'identity' })
    expect(got.headers['content-encoding']).toBeUndefined()
    expect(got.bytes.toString()).toBe(BODY)
    expect(got.headers['content-length']).toBe(String(Buffer.byteLength(BODY)))
  })

  it('serves identity when compression is disabled by config', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition('none')
    const got = await raw(loaded.webServer.port, '/big', { 'accept-encoding': 'br' })
    expect(got.headers['content-encoding']).toBeUndefined()
    expect(got.bytes.toString()).toBe(BODY)
  })

  it('skips small bodies under the threshold', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition('auto')
    const got = await raw(loaded.webServer.port, '/small', { 'accept-encoding': 'br' })
    expect(got.headers['content-encoding']).toBeUndefined()
    expect(got.bytes.toString()).toBe('hello world!')
  })

  it('skips non-compressible MIME types', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition('auto')
    const got = await raw(loaded.webServer.port, '/binary', { 'accept-encoding': 'br' })
    expect(got.headers['content-encoding']).toBeUndefined()
    expect([...got.bytes]).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('passes SSE bodies through uncompressed', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition('auto')
    const got = await raw(loaded.webServer.port, '/sse', { 'accept-encoding': 'br' })
    expect(got.headers['content-encoding']).toBeUndefined()
    expect(got.headers['content-type']).toBe('text/event-stream')
    expect(got.bytes.toString()).toBe('data: one\n\ndata: two\n\n')
  })

  it('streams a large compressed body to completion under drain-wait backpressure', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition('auto')
    const got = await raw(loaded.webServer.port, '/stream', { 'accept-encoding': 'br' })
    expect(got.status).toBe(200)
    expect(got.headers['content-encoding']).toBe('br')
    const decoded = brotliDecompressSync(got.bytes)
    expect(decoded.toString()).toBe('y'.repeat(16 * 64 * 1024))
    expect(got.bytes.length).toBeLessThan(decoded.length)
  })

  it('serves identity when the client refuses every encoding', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition('auto')
    const got = await raw(loaded.webServer.port, '/big', { 'accept-encoding': 'identity;q=0, *;q=0' })
    // Every encoding including identity is refused (q=0): nothing may be
    // applied, so the body ships as-is.
    expect(got.headers['content-encoding']).toBeUndefined()
    expect(got.bytes.toString()).toBe(BODY)
  })
})
