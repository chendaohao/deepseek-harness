/**
 * The Gateway Remote-stream multiplexer wire (`/api/remote.mux`) for the
 * mobile surface: typed open/cancel client messages and item/end/error server
 * frames over one plain browser WebSocket. The page is a self-contained
 * bundle, so the frame shapes are restated here instead of imported from the
 * gateway package. Logical streams are one-shot per socket for this surface:
 * the events client runs one `session/follow` stream, and the workspace
 * roster opens a short-lived socket for one `workspace/follow` baseline.
 */

/** Exact WebSocket route carrying every Typert Remote stream (gateway contract). */
export const REMOTE_MUX_PATH = '/api/remote.mux'

/** One Host-pushed logical stream frame (gateway `RemoteStreamServerMessage`). */
export type MuxServerFrame =
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  | { readonly type: 'error'; readonly streamId: string; readonly error: { readonly code: string; readonly message: string; readonly details: object } }
  | { readonly type: 'end'; readonly streamId: string }

/** The WebSocket subset this surface uses (the browser WebSocket fits). */
export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
  send(data: string): void
  close(): void
}

/**
 * Send one logical-stream open request (gateway client-message shape).
 * @param socket - the multiplexer socket to send on.
 * @param streamId - client-minted logical stream id.
 * @param endpoint - gateway route the stream opens.
 * @param payload - open payload forwarded to the route.
 */
export function muxOpen(socket: WebSocketLike, streamId: string, endpoint: string, payload: unknown): void {
  socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }))
}

/**
 * Send one logical-stream cancel request (gateway client-message shape).
 * @param socket - the multiplexer socket to send on.
 * @param streamId - logical stream id to cancel.
 */
export function muxCancel(socket: WebSocketLike, streamId: string): void {
  socket.send(JSON.stringify({ type: 'cancel', streamId }))
}

/**
 * Parse one server frame; `undefined` when unrelated or malformed.
 * @param data - raw frame payload from the socket.
 * @returns the parsed frame, or undefined when unrelated or malformed.
 */
export function parseMuxFrame(data: unknown): MuxServerFrame | undefined {
  if (typeof data !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || typeof parsed['streamId'] !== 'string') return undefined
  if (parsed['type'] === 'item') return { type: 'item', streamId: parsed['streamId'], value: parsed['value'] }
  if (parsed['type'] === 'end') return { type: 'end', streamId: parsed['streamId'] }
  if (parsed['type'] === 'error' && isRecord(parsed['error'])
    && typeof parsed['error']['code'] === 'string' && typeof parsed['error']['message'] === 'string') {
    return {
      type: 'error',
      streamId: parsed['streamId'],
      error: {
        code: parsed['error']['code'],
        message: parsed['error']['message'],
        details: isRecord(parsed['error']['details']) ? parsed['error']['details'] : {},
      },
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
