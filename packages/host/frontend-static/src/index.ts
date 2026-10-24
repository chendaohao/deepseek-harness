/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: a webserver resource serving the built frontend directory
 * with explicit index entry points. A readable index renders at the dist root
 * and configured index path; missing paths return 404, traversal outside the
 * dist root is 403, unknown extensions ship as octet-stream, and non-GET/HEAD
 * is 405. An HTTP index request first passes Connection's browser
 * authentication and renders for the browser Peer; an in-process read renders
 * for the Peer its caller admitted. Both renders go through the webserver's
 * index render (structured injection rows, then raw taps). Non-index assets
 * stay public; every served body carries a strong ETag and a cache class —
 * content-addressed files are immutable, a service worker revalidates on every
 * visit, the rest take the short class — and answers a matching
 * `If-None-Match` with 304. The dist location is workspace knowledge of the
 * composing application, so `distIndex` is typically supplied through a
 * `!!js` expression, never hardcoded by a deployment.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'frontend-static'

/** Services required before the authenticated fallback seat can be claimed. */
export const inject = ['webServer', 'connection']

/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
})

const HTML_MIME = 'text/html; charset=utf-8'

const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // Launchers require an image Content-Type for the install icons.
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  // The packed VFS image. Served as its own bytes, never as a Content-Encoding:
  // the worker inflates the body itself, and a transport-level encoding would
  // leave it inflating an already-decoded archive.
  '.gz': 'application/gzip',
}

/** Long cache for content-addressed files: one year, never revalidated. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'

/** Short cache for non-hashed static files: one hour, revalidated on use. */
const SHORT_CACHE = 'public, max-age=3600, must-revalidate'

/** Service-worker scripts revalidate on every visit: a cached worker would
 * stall deployed shell updates for the short-cache window. no-cache plus the
 * ETag keeps the unchanged case a 304 round-trip. */
const WORKER_CACHE = 'no-cache'

/**
 * Whether the pathname names a Vite content-addressed asset: the build emits
 * assets/<name>-<hash>.<ext> (and fonts/langs siblings); their names embed the
 * file content digest, so they can be cached forever.
 */
function isHashedAsset(pathname: string): boolean {
  const base = basename(pathname)
  const dot = base.lastIndexOf('.')
  if (dot === -1) return false
  const stem = base.slice(0, dot)
  const hashDash = stem.lastIndexOf('-')
  if (hashDash === -1) return false
  const hash = stem.slice(hashDash + 1)
  return /^[a-zA-Z0-9_-]{8,}$/.test(hash)
}

/**
 * Weak validator for one body: a SHA-1 of its bytes. Weak because the transport
 * may compress the bytes (the webserver negotiates brotli/gzip), so the
 * validator names the representation rather than the transferred octets.
 */
function bodyEtag(body: Uint8Array): string {
  return `W/"${createHash('sha1').update(body).digest('base64url')}"`
}

/** The cache class of one non-index file: hashed names never revalidate, a
 * worker script always does, everything else takes the short class. */
function assetCache(pathname: string): string {
  if (isHashedAsset(pathname)) return IMMUTABLE_CACHE
  return basename(pathname) === 'sw.js' ? WORKER_CACHE : SHORT_CACHE
}

/** Filesystem failure codes that mean a target is simply absent or not a file. */
const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/** A Response body that is `bytes` itself, without the copy a buffer body gets. */
function bytesBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Answer one GET or HEAD dist request; the webserver answers any other method
 * with 405 before a resource runs. A malformed percent-escape or a filesystem
 * failure other than a missing or non-file target rejects.
 * @param request - the request; its method, URL path, and If-None-Match are read.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param authorizeIndex - answers an index request before its bytes are read:
 * the response to send instead of the index, or undefined to serve it.
 * @param renderIndex - turns the raw index.html body into the served document
 * for the dist root and configured index path.
 * @returns the dist response; a HEAD response carries the GET status and
 * headers without a body. Every served body carries a weak ETag and its cache
 * class, and a request whose `If-None-Match` equals that ETag receives an
 * empty 304 with the same headers.
 */
async function serveStatic(
  request: Request, distRoot: string, distIndex: string,
  authorizeIndex: () => Response | undefined,
  renderIndex: (html: string) => string,
): Promise<Response> {
  const pathname = decodeURIComponent(new URL(request.url).pathname)
  const target = resolve(normalize(join(distRoot, pathname)))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) return new Response(null, { status: 403 })
  let body: string | Uint8Array<ArrayBuffer>
  let headers: Record<string, string>
  try {
    if (target === distRoot || target === distIndex) {
      const refusal = authorizeIndex()
      if (refusal !== undefined) return refusal
      body = renderIndex(await readFile(distIndex, 'utf8'))
      // The index document carries the boot manifest injected by the
      // webserver's index render, whose graph changes with the plugin set: it
      // revalidates rather than caching. The ETag is taken over the rendered
      // document, so a changed plugin set is a changed validator.
      headers = { 'content-type': HTML_MIME, 'cache-control': WORKER_CACHE, 'etag': bodyEtag(Buffer.from(body)) }
    } else {
      body = await readFile(target)
      headers = {
        'content-type': MIME[extname(target)] ?? 'application/octet-stream',
        'cache-control': assetCache(pathname),
        'etag': bodyEtag(body),
      }
    }
  } catch (error) {
    // Only absent or non-file targets are 404; other filesystem failures reach
    // the caller, which the webserver answers with 400 over HTTP.
    if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    return new Response(null, { status: 404 })
  }
  // The client's held validator answers 304 with the headers intact, so a
  // revalidating client re-reads no bytes.
  if (request.headers.get('if-none-match') === headers.etag) return new Response(null, { status: 304, headers })
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(typeof body === 'string' ? body : bytesBody(body), { status: 200, headers })
}

/**
 * Claim the webserver fallback seat with a resource serving the dist.
 * @param ctx - plugin context carrying the webServer and connection services.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  // Connection's browser authentication writes the token exchange's 303 or
  // the 401 through a writeHead/end response; capture it as a Fetch response.
  // The answer stays a 401 unless Connection writes another one.
  const authorizeIndex = (request: Request): Response | undefined => {
    let status = 401
    let headers = new Headers()
    let body: string | undefined
    const admitted = ctx.connection.authorizeIndex(request, {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus
        headers = new Headers(nextHeaders)
      },
      end(text) { body = text },
    })
    return admitted ? undefined : new Response(body, { status, headers })
  }
  ctx.effect(() => ctx.webServer.registerFallback({
    resource: (request, peer) => serveStatic(
      request,
      distRoot,
      distIndex,
      // A read with a Peer was admitted by its caller; an HTTP request carries
      // none and passes Connection's browser authentication instead.
      () => peer === undefined ? authorizeIndex(request) : undefined,
      // The browser authentication admits the owner's shared browser Peer. The
      // base goes in after all index transforms, so it precedes every resource
      // reference they insert.
      html => ctx.webServer.renderIndex(html, peer ?? ctx.connection.browserPeer)
        .replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="./">`),
    ),
  }), 'frontend-static: fallback seat')
}
