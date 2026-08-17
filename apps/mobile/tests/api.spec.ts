// The transport assembly: pairing cookie injection and base-URL targeting.
import { describe, expect, it, vi } from 'vitest'

// expo/fetch is the device default; the spec injects its own fetch instead,
// so the module must not touch the real native import at load time.
vi.mock('expo/fetch', () => ({ fetch: vi.fn() }))

import type { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createApi } from '../src/lib/api'
import type { FetchLike } from '@deepseek-ai/dsh-client-mobile'

describe('createApi transport assembly', () => {
  it('targets the paired base URL and carries the session cookie on every request', async () => {
    const mockFetch = vi.fn(async (_input: string | URL, _init?: RequestInit): Promise<Response> => {
      return new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const client = createApi({ baseUrl: 'https://pair.example', cookie: 'tok-123' }, mockFetch as unknown as FetchLike)

    await client.respond({
      type: 'client-response',
      rpcId: 'rpc-1' as RpcId,
      result: { ok: true, value: { sessionId: 's1', approvalId: 'ap1', outcome: 'rejected' } },
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [input, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(String(input)).toMatch(/^https:\/\/pair\.example\//)
    expect((init.headers as Record<string, string>).cookie).toBe('dsh_remote=tok-123')
  })

  it('defaults the fetch implementation to expo/fetch', () => {
    const client = createApi({ baseUrl: 'https://pair.example', cookie: 'tok' })
    expect(client).toBeInstanceOf(Object)
    expect((client as unknown as { cookieHeader: string }).cookieHeader).toBe('dsh_remote=tok')
  })
})
