/**
 * Minimal unary RPC client for the mobile surface, riding the platform /api
 * transport: POST /api/<method> with the client-request envelope, resolving
 * the server-response value. The page is a self-contained bundle (no module
 * loader), so the wire contract is reimplemented here over plain fetch; every
 * failure — network, HTTP status, malformed envelope, or a business error the
 * host answered with — folds into the same `{ ok: false, error }` result the
 * views render.
 */

/** The wire error body (code + message, details kept wide). */
export interface RpcError {
  code: string
  message: string
  details?: unknown
}

/** Folded result of one unary call: a business value or a folded error. */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

/** Route prefix owning every api request (platform contract). */
export const API_PREFIX = '/api'

/** Unary budget: a response dropped by a flaky remote link must surface as an error, not hang forever. */
const DEFAULT_RPC_TIMEOUT_MS = 30_000

let rpcCounter = 0

/** Mint one page-unique rpcId (stable under crypto.randomUUID absence). */
export function mintRpcId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  rpcCounter += 1
  return `${random}-${rpcCounter.toString(36)}`
}

function transportError(reason: unknown): RpcError {
  const message = reason instanceof DOMException && reason.name === 'AbortError'
    ? 'aborted'
    : reason instanceof Error ? reason.message : String(reason)
  return { code: 'transport', message: `transport failed: ${message}` }
}

/**
 * One unary call: POST /api/<method> with the client-request envelope,
 * resolving the server-response value into a folded result.
 * @param method - the dotted RPC method, e.g. `session.list`.
 * @param payload - the business payload.
 * @param signal - optional abort.
 * @param timeoutMs - per-call deadline in ms (default {@link DEFAULT_RPC_TIMEOUT_MS}); overridable for tests.
 * @returns the response value, or a folded error.
 */
export async function callUnary<T>(
  method: string,
  payload: unknown,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
): Promise<RpcResult<T>> {
  const rpcId = mintRpcId()
  // A timeout bounds every call: over a remote link a response dropped mid-body
  // must fold to a transport error (and let the EventsClient poll back off)
  // instead of hanging the surface forever.
  const requestSignal = signal === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
  let response: Response
  try {
    response = await fetch(`${API_PREFIX}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: requestSignal,
    })
  } catch (error) {
    return { ok: false, error: transportError(error) }
  }
  if (!response.ok) {
    return { ok: false, error: { code: 'http', message: `HTTP ${String(response.status)}` } }
  }
  let envelope: unknown
  try {
    envelope = await response.json()
  } catch {
    return { ok: false, error: { code: 'transport', message: 'malformed response body' } }
  }
  const parsed = envelope as { type?: unknown; rpcId?: unknown; result?: unknown } | null
  if (parsed === null || parsed.type !== 'server-response' || parsed.rpcId !== rpcId) {
    return { ok: false, error: { code: 'transport', message: 'response envelope mismatch' } }
  }
  const result = parsed.result as {
    ok?: unknown
    value?: unknown
    error?: { code?: unknown; message?: unknown; details?: unknown }
  } | null
  if (result === null) {
    return { ok: false, error: { code: 'transport', message: 'malformed result envelope' } }
  }
  if (result.ok === true) return { ok: true, value: result.value as T }
  if (result.ok === false && result.error !== undefined) {
    return {
      ok: false,
      error: {
        code: typeof result.error.code === 'string' ? result.error.code : 'unknown',
        message: typeof result.error.message === 'string' ? result.error.message : 'RPC call failed',
        ...(result.error.details !== undefined ? { details: result.error.details } : {}),
      },
    }
  }
  return { ok: false, error: { code: 'transport', message: 'malformed result envelope' } }
}
