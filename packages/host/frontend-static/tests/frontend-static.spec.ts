/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver and frontend-static rows, and every
 * assertion observes the served HTTP surface — asset serving, explicit index
 * entry points with index taps, 404 misses, traversal rejection, 405 on non-
 * GET/HEAD, and seat release on fiber disposal (HMR safety).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as FrontendStatic from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a dist fixture and the authenticated Web rows, then boot them through the real Loader. */
async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-frontend-static-'))
  const dist = join(root, 'dist')
  await mkdir(dist)
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<head></head><body>shell</body>')
  await writeFile(join(dist, 'app.js'), 'export {}')
  await writeFile(join(dist, 'blob.bin'), 'BLOB')
  await writeFile(join(dist, 'manifest.webmanifest'), '{}')
  await writeFile(join(dist, 'sw.js'), '/* dsh shell worker */')
  await writeFile(join(dist, 'LICENSE'), 'MIT')
  await mkdir(join(dist, 'assets'))
  await writeFile(join(dist, 'assets', 'app-abc12345.js'), 'export {}')
  await mkdir(join(dist, 'empty'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: '${join(root, '.credentials.yaml')}'`,
    '    watch: false',
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-client-connection'",
    '- id: frontend',
    "  name: '@deepseek-ai/dsh-host-frontend-static'",
    '  config:',
    `    distIndex: '${distIndex}'`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', LocalCredentials],
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
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
  return context
}

/** GET (by default) one path against the running server; returns status, content-type, a body prefix, and the caching headers. */
async function request(port: number, path: string, init?: RequestInit): Promise<{
  status: number
  type: string | null
  body: string
  cacheControl: string | null
  etag: string | null
}> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    // Window wide enough to keep index body markers visible behind the
    // served prelude (base anchor + injection rows + boot-readiness tail).
    body: (await response.text()).slice(0, 200),
    cacheControl: response.headers.get('cache-control'),
    etag: response.headers.get('etag'),
  }
}

/** Exchange the connection's authenticated URL for its cookie; wrap request inits with it. */
async function authenticate(port: number): Promise<(init?: RequestInit) => RequestInit> {
  const launchUrl = context!.connection.authenticatedUrl(`http://127.0.0.1:${String(port)}`)
  const exchange = await fetch(launchUrl, { redirect: 'manual' })
  expect(exchange.status).toBe(303)
  expect(exchange.headers.get('location')).toBe('/')
  const setCookie = exchange.headers.get('set-cookie')
  if (setCookie === null) throw new Error('authenticated frontend did not set a cookie')
  const cookie = setCookie.split(';', 1)[0]!
  return (init?: RequestInit): RequestInit => {
    const headers = new Headers(init?.headers)
    headers.set('cookie', cookie)
    return { ...init, headers }
  }
}

describe('real Loader composition', () => {
  it('serves explicit index entries and files while preserving HTTP error semantics', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const server = loaded.webServer
    const port = server.port
    const authenticated = await authenticate(port)

    expect(await request(port, '/')).toMatchObject({
      status: 401,
      type: 'text/plain; charset=utf-8',
      body: 'dsh web authentication required; reopen the URL printed by dsh web.\n',
    })

    // Real assets with their MIME types; a live rebuild is served on the next read.
    expect(await request(port, '/app.js')).toMatchObject({ status: 200, type: 'text/javascript; charset=utf-8', body: 'export {}' })
    expect(await request(port, '/manifest.webmanifest')).toMatchObject({
      status: 200,
      type: 'application/manifest+json',
      body: '{}',
    })
    expect(await request(port, '/app.js', { method: 'HEAD' })).toMatchObject({
      status: 200,
      type: 'text/javascript; charset=utf-8',
      body: '',
    })
    await writeFile(join(root!, 'dist', 'app.js'), 'export const rebuilt = true')
    expect(await request(port, '/app.js')).toMatchObject({ status: 200, body: 'export const rebuilt = true' })

    // Unknown extension ships as octet-stream.
    expect(await request(port, '/blob.bin')).toMatchObject({ status: 200, type: 'application/octet-stream', body: 'BLOB' })

    // Only the root and index path render index.html through registered taps.
    const untap = server.tapIndex(html => html.replace('<head>', '<head><script>window.__T__=1</script>'))
    for (const path of ['/', '/index.html', '/?fixture']) {
      const got = await request(port, path, authenticated())
      expect(got.status).toBe(200)
      expect(got.type).toBe('text/html; charset=utf-8')
      expect(got.body).toContain('__T__')
      expect(got.body).toContain('shell')
    }
    // The served index carries its no-cache class and a body validator even
    // on HEAD, where the body itself is discarded; the validator matches GET.
    const getIndex = await request(port, '/', authenticated())
    const headIndex = await request(port, '/', authenticated({ method: 'HEAD' }))
    expect(headIndex.status).toBe(200)
    expect(headIndex.type).toBe('text/html; charset=utf-8')
    expect(headIndex.body).toBe('')
    expect(headIndex.cacheControl).toBe('no-cache')
    expect(headIndex.etag).toBe(getIndex.etag)
    untap()
    expect((await request(port, '/', authenticated())).body).not.toContain('__T__')

    // A missing configured index follows the same empty-404 contract for both
    // of its public entry paths and for both supported methods; misses ship
    // no caching headers to revalidate.
    await rm(join(root!, 'dist', 'index.html'))
    for (const path of ['/', '/index.html']) {
      const get = await request(port, path, authenticated())
      const head = await request(port, path, authenticated({ method: 'HEAD' }))
      expect(get).toEqual({ status: 404, type: null, body: '', cacheControl: null, etag: null })
      expect(head).toEqual(get)
    }

    // Ordinary unknown paths and static-resource misses are empty 404s for
    // both GET and HEAD; neither class can be mistaken for the HTML shell.
    const ordinaryMisses = ['/no/such/route', '/empty', '/app.js/child']
    const assetMisses = [
      '/missing.js',
      '/missing.css',
      '/missing.mjs',
      '/missing.js.map',
      '/missing.webmanifest',
      '/missing.manifest',
    ]
    for (const path of [...ordinaryMisses, ...assetMisses]) {
      const get = await request(port, path)
      const head = await request(port, path, { method: 'HEAD' })
      expect(get).toMatchObject({ status: 404, type: null, body: '' })
      expect(head).toMatchObject(get)
    }
    expect(await request(port, '/api/no/such/route', authenticated())).toEqual({
      status: 404,
      type: 'text/plain;charset=UTF-8',
      body: 'not found',
      cacheControl: null,
      etag: null,
    })

    // Traversal outside the dist root is 403, non-GET/HEAD is 405, and a
    // malformed filesystem target still reaches the webserver's 400 guard.
    expect((await request(port, '/..%2f..%2fetc%2fpasswd')).status).toBe(403)
    expect((await request(port, '/app.js', { method: 'POST' })).status).toBe(405)
    expect((await request(port, '/bad%00path')).status).toBe(400)

    // HMR safety: disposing the frontend row releases the fallback seat (the
    // unclaimed webserver answers 404) and the seat is claimable again.
    const frontendEntry = [...loaded.loader.entries()].find(e => e.options.id === 'frontend')
    expect(frontendEntry).toBeDefined()
    await frontendEntry!.fiber?.dispose()
    expect((await request(port, '/no/such/route')).status).toBe(404)
    expect(() => server.registerFallback(() => {})).not.toThrow()
  })

  it('serves cache headers and 304 revalidation per resource class', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const port = loaded.webServer.port
    const authenticated = await authenticate(port)

    // Hashed assets are immutable forever.
    const asset = await request(port, '/assets/app-abc12345.js')
    expect(asset.cacheControl).toBe('public, max-age=31536000, immutable')
    expect(asset.etag).toBeDefined()

    // Non-hashed static files are short-cached with revalidation.
    const plain = await request(port, '/app.js')
    expect(plain.cacheControl).toBe('public, max-age=3600, must-revalidate')
    expect(plain.etag).toBeDefined()
    const revalidated = await request(port, '/app.js', { headers: { 'if-none-match': plain.etag! } })
    expect(revalidated.status).toBe(304)

    // A dotless name is not content-addressed, so it is short-cached too.
    expect((await request(port, '/LICENSE')).cacheControl).toBe('public, max-age=3600, must-revalidate')

    // The service worker revalidates every visit so deployed workers take over.
    const worker = await request(port, '/sw.js')
    expect(worker.cacheControl).toBe('no-cache')
    expect(worker.etag).toBeDefined()
    expect((await request(port, '/sw.js', { headers: { 'if-none-match': worker.etag! } })).status).toBe(304)

    // The index document (here the SPA fallback) always revalidates too; it
    // sits behind the browser authentication like every index response.
    const index = await request(port, '/', authenticated())
    expect(index.cacheControl).toBe('no-cache')
    expect(index.etag).toBeDefined()
    expect((await request(port, '/', authenticated({ headers: { 'if-none-match': index.etag! } }))).status).toBe(304)
  })
})
