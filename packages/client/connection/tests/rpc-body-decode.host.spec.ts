/** RPC bridge request-body decoding: mobile browsers compress uploads
 * (`content-encoding: gzip` on metered networks) and WHATWG fetch never
 * decodes request bodies, so the /api JSON parse point owns the codec.
 * Driven through the mounted HostConnectionService so the fence, bridge, and
 * rpcFetchHandler composition stay in the loop. */
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { ClientRequest } from '../src/rpc.ts'
import { RpcId } from '../src/rpc.ts'
import { HostConnectionService } from '../src/rpc-host.ts'
import type { BrowserAuth } from '../src/browser-auth.ts'
import { Context } from '@deepseek-ai/cordis'

async function mounted(): Promise<{
  connection: HostConnectionService
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const fiber = ctx.plugin((pluginCtx) => {
    new HostConnectionService(pluginCtx, [], {
      authenticate: () => ({ authenticated: true }),
    } as unknown as BrowserAuth)
  })
  await fiber.await()
  return {
    connection: ctx.get('connection') as HostConnectionService,
    dispose: () => fiber.dispose(),
  }
}

function envelope(): ClientRequest {
  return {
    type: 'client-request',
    rpcId: RpcId('decode-test'),
    method: 'llm/listProviders',
    payload: { args: {} },
  }
}

/** Drive one compressed/uncompressed POST through the shared handler.
 * @returns the transport status and the payload the RPC handler received. */
async function decodeOutcome(headers: Record<string, string>, raw: Buffer): Promise<{
  status: number
  payload: unknown
}> {
  const { connection, dispose } = await mounted()
  try {
    let received: unknown
    const withdraw = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'llm/listProviders',
      async (_endpoint, payload) => {
        received = payload
        return { ok: true, value: null }
      },
    )
    const shared = connection.createSharedFetchHandler('/api')
    const request = new Request('http://host/api/llm/listProviders', {
      method: 'POST',
      headers,
      body: new Uint8Array(raw),
    })
    const response = await shared.fetch(request)
    await withdraw()
    return { status: response.status, payload: received }
  } finally {
    await dispose()
  }
}

describe('connection rpc request-body content-encoding', () => {
  const message = JSON.stringify(envelope())

  it('decodes a gzip-compressed body to the parsed envelope', async () => {
    const { status, payload } = await decodeOutcome(
      { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      gzipSync(Buffer.from(message)),
    )
    expect(status).toBe(200)
    expect(payload).toEqual({ args: {} })
  })

  it('decodes the zlib-wrapped deflate spelling', async () => {
    const { status, payload } = await decodeOutcome(
      { 'content-type': 'application/json', 'content-encoding': 'deflate' },
      deflateSync(Buffer.from(message)),
    )
    expect(status).toBe(200)
    expect(payload).toEqual({ args: {} })
  })

  it('decodes a brotli-compressed body', async () => {
    const { status, payload } = await decodeOutcome(
      { 'content-type': 'application/json', 'content-encoding': 'br' },
      brotliCompressSync(Buffer.from(message)),
    )
    expect(status).toBe(200)
    expect(payload).toEqual({ args: {} })
  })

  it('accepts x-gzip as gzip', async () => {
    const { status } = await decodeOutcome(
      { 'content-type': 'application/json', 'content-encoding': 'x-gzip' },
      gzipSync(Buffer.from(message)),
    )
    expect(status).toBe(200)
  })

  it('reads an uncompressed body unchanged', async () => {
    const { status, payload } = await decodeOutcome(
      { 'content-type': 'application/json' },
      Buffer.from(message),
    )
    expect(status).toBe(200)
    expect(payload).toEqual({ args: {} })
  })

  it('treats an explicit identity encoding as no encoding', async () => {
    const { status, payload } = await decodeOutcome(
      { 'content-type': 'application/json', 'content-encoding': 'identity' },
      Buffer.from(message),
    )
    expect(status).toBe(200)
    expect(payload).toEqual({ args: {} })
  })

  it('refuses an unknown content-encoding with 415', async () => {
    const { status } = await decodeOutcome(
      { 'content-type': 'application/json', 'content-encoding': 'zstd' },
      Buffer.from(message),
    )
    expect(status).toBe(415)
  })

  it('answers 400 for corrupt compressed bytes', async () => {
    const { status } = await decodeOutcome(
      { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      Buffer.from('not gzip'),
    )
    expect(status).toBe(400)
  })

  it('answers 413 when the decompressed body outgrows the limit', async () => {
    const inflated = ' '.repeat(80 * 1024 * 1024)
    const { status } = await decodeOutcome(
      { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      gzipSync(Buffer.from(inflated)),
    )
    expect(status).toBe(413)
  })

  it('applies no decompression limit to an uncompressed body', async () => {
    const big = JSON.stringify({ ...envelope(), payload: { args: { pad: 'x'.repeat(65 * 1024 * 1024) } } })
    const { status, payload } = await decodeOutcome(
      { 'content-type': 'application/json' },
      Buffer.from(big),
    )
    expect(status).toBe(200)
    expect((payload as { args: { pad: string } }).args.pad).toHaveLength(65 * 1024 * 1024)
  })
})
