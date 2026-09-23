/**
 * Response compression for the HTTP carrier: brotli-preferred, gzip fallback,
 * negotiated per request from Accept-Encoding. {@link maybeCompressResponse}
 * wraps a ServerResponse with a transparent facade that defers header
 * commitment to the first body write, then decides per response whether the
 * body is compressible (status, content-type, known length vs threshold) and
 * pipes the body through the codec — or passes it through untouched. SSE
 * (text/event-stream) always passes through, so streaming latency is
 * unchanged. The facade forwards the header-mutation surface (setHeader,
 * appendHeader, removeHeader), the event surface (close/drain), and the
 * writable-state getters the carrier and its handlers rely on.
 * @module @deepseek-ai/dsh-host-webserver/compress
 */

import { createBrotliCompress, createGzip } from 'node:zlib'
import type { OutgoingHttpHeaders, OutgoingHttpHeader, ServerResponse } from 'node:http'

/** User-facing compression modes. 'auto' negotiates; 'br'/'gzip' force a codec when the client accepts it; 'none' disables. */
export type CompressionMode = 'auto' | 'br' | 'gzip' | 'none'

/** The accepted text-like MIME families that benefit from compression. */
export const COMPRESSIBLE_MIME_PREFIXES = [
  'text/',
  'application/javascript',
  'application/json',
  'application/manifest+json',
  'application/xml',
  'image/svg+xml',
  'application/wasm',
  'multipart/form-data',
] as const

/** Default minimum body size (bytes) before compression is worth the CPU. */
export const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 1024

/**
 * Parse one Accept-Encoding header into accepted encodings, honoring q-values
 * and the identity token. A malformed q-value counts as 0 for that token.
 * @param header - the raw header value.
 * @returns which of br / gzip / identity are acceptable, and whether any
 * explicit encoding token was present.
 */
export function parseAcceptEncoding(header: string): { br: boolean; gzip: boolean; identity: boolean; any: boolean } {
  let br = false
  let gzip = false
  let identity = false
  let any = false
  for (const raw of header.split(',')) {
    const [token = '', ...params] = raw.trim().split(';')
    const name = token.trim().toLowerCase()
    if (name === '') continue
    const q = parseQ(params)
    if (q <= 0) continue
    any = true
    if (name === 'br') br = true
    else if (name === 'gzip' || name === 'x-gzip') gzip = true
    else if (name === 'identity') identity = true
  }
  return { br, gzip, identity, any }
}

function parseQ(params: string[]): number {
  for (const param of params) {
    const [key = '', value] = param.trim().split('=')
    if (key.toLowerCase() !== 'q') continue
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
    return 0
  }
  return 1
}

/**
 * Choose the encoding for one request under the configured mode.
 * @param header - raw Accept-Encoding, or undefined.
 * @param mode - configured compression mode.
 * @returns the encoding to use, or undefined for identity.
 */
export function pickEncoding(header: string | undefined, mode: CompressionMode): 'br' | 'gzip' | undefined {
  if (mode === 'none' || header === undefined) return undefined
  const accepted = parseAcceptEncoding(header)
  if (mode === 'br') return accepted.br ? 'br' : undefined
  if (mode === 'gzip') return accepted.gzip ? 'gzip' : undefined
  if (accepted.br) return 'br'
  if (accepted.gzip) return 'gzip'
  // No explicit encoding token, or only identity accepted.
  return !accepted.any || accepted.identity ? undefined : 'gzip'
}

/**
 * Whether a MIME type is worth compressing (SSE and unknown types are not).
 * @param contentType - the response Content-Type header value, if any.
 * @returns true when the MIME type is compressible.
 */
export function isCompressibleMime(contentType: string | undefined): boolean {
  if (contentType === undefined) return false
  const lower = contentType.toLowerCase()
  if (lower === 'text/event-stream') return false
  return COMPRESSIBLE_MIME_PREFIXES.some(prefix => lower.startsWith(prefix))
}

/**
 * Whether a status code carries a body worth compressing.
 * @param status - the response status code.
 * @returns true when the status permits a compressible body.
 */
export function isCompressibleStatus(status: number): boolean {
  // 1xx/204/304 have no body; 206 is a byte-range response whose identity must
  // be preserved (a range of a compressed stream is a different byte space).
  return !(status < 200 || status === 204 || status === 304 || status === 206)
}

/**
 * Decide compression for one response. The decision is made at the first body
 * write, when the handler has committed its headers.
 * @param opts - status, content-type, content-length (when known), and the
 * negotiated encoding.
 * @param thresholdBytes - minimum known body size; unknown length always
 * compresses when the other conditions hold.
 * @returns the encoding to apply, or undefined to send identity.
 */
export function decideCompression(
  opts: { status: number; contentType: string | undefined; contentLength: number | undefined; encoding: 'br' | 'gzip' | undefined },
  thresholdBytes: number,
): 'br' | 'gzip' | undefined {
  const { status, contentType, contentLength, encoding } = opts
  if (encoding === undefined) return undefined
  if (!isCompressibleStatus(status)) return undefined
  if (!isCompressibleMime(contentType)) return undefined
  if (contentLength !== undefined && contentLength < thresholdBytes) return undefined
  return encoding
}

/**
 * Wrap a response for compression when the request accepts an encoding.
 * Returns the original response untouched when nothing applies (no
 * Accept-Encoding, compression disabled) — the common curl/back-end case.
 * The facade defers header commitment until the first body write so the
 * decision sees the handler's content-type and status; until then the
 * response behaves exactly like the original (setHeader/writeHead/appendHeader
 * included). After commitment, writes pass through the codec or straight to
 * the socket (SSE and other non-compressible bodies keep zero added latency).
 * @param res - the response to wrap.
 * @param encoding - negotiated encoding, or undefined.
 * @param thresholdBytes - minimum known body size for compression.
 * @returns the (possibly wrapped) response.
 */
export function maybeCompressResponse(
  res: ServerResponse,
  encoding: 'br' | 'gzip' | undefined,
  thresholdBytes: number,
): ServerResponse {
  if (encoding === undefined) return res
  const codec = encoding === 'br' ? createBrotliCompress() : createGzip()
  let pendingStatus: number | undefined
  let pendingHeaders: Record<string, string | string[] | number> = {}
  let committed = false
  let decided: 'br' | 'gzip' | undefined
  let ended = false

  const commit = (status: number, headers: Record<string, string | string[] | number>): void => {
    if (committed) return
    committed = true
    if (decided !== undefined) {
      // The compressed byte length differs from the raw body's; a stale
      // content-length would hang or truncate the client.
      delete headers['content-length']
      headers['content-encoding'] = decided
      headers.vary = appendVary(headers.vary, 'accept-encoding')
      res.writeHead(status, headers)
      // Pipe from the first byte: the codec output must reach the socket while
      // the body streams, or callers using write-return backpressure (drain
      // waits) deadlock waiting on a socket that never drains.
      codec.on('error', (error) => { res.destroy(error) })
      codec.pipe(res)
    } else {
      res.writeHead(status, headers)
    }
  }

  // The facade is a hand-rolled structural subset of ServerResponse; the
  // literal stays loose (methods typed by the parameter lists below) and the
  // final cast bridges the interface's exact overload set.
  const facade = {
    // Handlers set the status by assignment far more often than by writeHead
    // (every sendJson-style helper, and the connection fence's refusal). The
    // accessor keeps that assignment on the one path the deferred commit and
    // the compression decision read, so a refusal is never served as 200.
    get statusCode(): number {
      return pendingStatus ?? res.statusCode
    },
    set statusCode(value: number) {
      pendingStatus = value
    },
    writeHead(
      status: number,
      headers: OutgoingHttpHeaders | OutgoingHttpHeader[] | string | undefined,
      extra?: OutgoingHttpHeaders | OutgoingHttpHeader[],
    ): ServerResponse {
      // Support both writeHead(status, headers) and writeHead(status, message, headers).
      const nextHeaders: Record<string, string | number | string[]> = {}
      if (typeof headers === 'string') {
        Object.assign(nextHeaders, extra ?? {})
      } else {
        Object.assign(nextHeaders, headers ?? {})
      }
      pendingStatus = status
      pendingHeaders = { ...pendingHeaders, ...nextHeaders }
      return facade
    },
    setHeader(name: string, value: string | number | readonly string[]): void {
      pendingHeaders[name.toLowerCase()] = value as string | number | string[]
    },
    appendHeader(name: string, value: string | readonly string[]): void {
      // A handler's Set-Cookie append (daily browser-cookie refresh, multiple
      // cookies) must survive the deferred commit: appending into the pending
      // set keeps it ahead of the first body write, and after commitment the
      // real response owns the throw for a sent-header append.
      if (committed) {
        res.appendHeader(name, value)
        return
      }
      const key = name.toLowerCase()
      const existing = pendingHeaders[key]
      // A prior single value (including a numeric header) becomes the first
      // element of the appended list; header values reach the wire as text.
      const prior = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)]
      pendingHeaders[key] = [...prior, ...(typeof value === 'string' ? [value] : value)]
    },
    getHeader(name: string): string | number | string[] | undefined {
      return pendingHeaders[name.toLowerCase()]
    },
    removeHeader(name: string): void {
      const key = name.toLowerCase()
      const next: Record<string, string | number | string[]> = {}
      for (const [k, v] of Object.entries(pendingHeaders)) {
        if (k !== key) next[k] = v
      }
      pendingHeaders = next
    },
    flushHeaders(): void {
      if (committed) { res.flushHeaders(); return }
      // Headers leave before any body byte: compression cannot be decided
      // afterwards (the header bytes are already on the wire), so the rest of
      // this response is identity.
      committed = true
      decided = undefined
      res.writeHead(pendingStatus ?? 200, pendingHeaders)
      res.flushHeaders()
    },
    write(chunk: string | Buffer, cb?: (error?: Error | null) => void): boolean {
      if (!committed) {
        const status = pendingStatus ?? 200
        const contentType = String(pendingHeaders['content-type'] ?? '')
        const lengthHeader = pendingHeaders['content-length']
        const contentLength = typeof lengthHeader === 'string' ? Number(lengthHeader) : undefined
        decided = decideCompression(
          { status, contentType, contentLength, encoding },
          thresholdBytes,
        )
        commit(status, pendingHeaders)
      }
      if (decided === undefined) return res.write(chunk, cb)
      if (codec.write(chunk)) {
        cb?.()
        return true
      }
      codec.once('drain', () => { cb?.() })
      return false
    },
    end(chunk?: string | Buffer, cb?: () => void): ServerResponse {
      if (ended) return facade
      ended = true
      if (chunk !== undefined) facade.write(chunk)
      if (decided === undefined) {
        if (!committed) {
          committed = true
          res.writeHead(pendingStatus ?? 200, pendingHeaders)
        }
        res.end(cb)
        return facade
      }
      // The commit already piped the codec into the response (pipe owns
      // backpressure and ends the response when the codec finishes); the
      // callback follows the response finish.
      codec.end()
      if (cb !== undefined) res.once('finish', () => { cb() })
      return facade
    },
    /* v8 ignore next 4 -- `on` is the persistent drain-listener form; no
    consumer attaches one (the /api bridge's drain-wait is once + off). */
    on(event: string, listener: (...args: unknown[]) => void): ServerResponse {
      res.on(event, listener as never)
      return facade
    },
    once(event: string, listener: (...args: unknown[]) => void): ServerResponse {
      // Drain follows whichever stream write() reported backpressure on: the
      // codec for compressed responses, the socket for identity ones. The /api
      // bridge and other handlers wait on this event after a false write, so
      // routing it to the socket here would never fire (the socket is only fed
      // by the codec pipe, whose output lags the codec's writable side).
      if (event === 'drain' && decided !== undefined) codec.once(event, listener)
      else res.once(event, listener)
      return facade
    },
    off(event: string, listener: (...args: unknown[]) => void): ServerResponse {
      if (event === 'drain' && decided !== undefined) codec.off(event, listener as never)
      else res.off(event, listener as never)
      return facade
    },
    addListener(event: string, listener: (...args: unknown[]) => void): ServerResponse {
      res.addListener(event, listener as never)
      return facade
    },
    removeListener(event: string, listener: (...args: unknown[]) => void): ServerResponse {
      res.removeListener(event, listener as never)
      return facade
    },
    emit(event: string, ...args: unknown[]): boolean {
      return res.emit(event as never, ...(args as never[]))
    },
    get headersSent(): boolean { return committed ? res.headersSent : false },
    get writableEnded(): boolean { return ended || res.writableEnded },
    get writable(): boolean { return res.writable },
    get destroyed(): boolean { return res.destroyed },
    destroy(error?: Error): void { res.destroy(error) },
  } as unknown as ServerResponse
  return facade
}

function appendVary(current: string | string[] | number | undefined, value: string): string {
  const parts = Array.isArray(current) ? current : current === undefined ? [] : String(current).split(',')
  const names = parts.map(part => part.trim().toLowerCase())
  if (names.includes(value)) return parts.join(', ')
  return [...parts, value].join(', ')
}
