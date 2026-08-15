import { describe, expect, it } from 'vitest'
import { PairingError } from '../src/errors.ts'
import { extractSessionCookie, pairWithHost, parsePairingUrl } from '../src/pairing.ts'
import type { FetchLike } from '../src/types.ts'

describe('parsePairingUrl', () => {
  it('splits a valid pairing URL into origin and ticket', () => {
    expect(parsePairingUrl('  https://fake-slug.trycloudflare.com/pair/abc123  '))
      .toEqual({ baseUrl: 'https://fake-slug.trycloudflare.com', ticket: 'abc123' })
  })

  it('decodes a percent-encoded ticket', () => {
    expect(parsePairingUrl('https://host.example/pair/a%2Fb')).toEqual({
      baseUrl: 'https://host.example', ticket: 'a/b',
    })
  })

  it('rejects unparseable URLs', () => {
    expect(() => parsePairingUrl('not a url')).toThrow(PairingError)
    expect(() => parsePairingUrl('not a url')).toThrow(/invalid-url/)
  })

  it('rejects non-HTTPS origins', () => {
    expect(() => parsePairingUrl('http://host.example/pair/abc')).toThrow(/pairing requires HTTPS/)
  })

  it('rejects URLs without a pairing ticket', () => {
    expect(() => parsePairingUrl('https://host.example/')).toThrow(/missing pairing ticket/)
    expect(() => parsePairingUrl('https://host.example/pair/')).toThrow(/missing pairing ticket/)
    expect(() => parsePairingUrl('https://host.example/pair/a/b')).toThrow(/missing pairing ticket/)
  })

  it('rejects a malformed percent escape in the ticket', () => {
    expect(() => parsePairingUrl('https://host.example/pair/%zz')).toThrow(/not percent-decodable/)
  })
})

describe('extractSessionCookie', () => {
  it('reads dsh_remote through getSetCookie', () => {
    const headers = { getSetCookie: () => ['other=1; Path=/', 'dsh_remote=secret; HttpOnly; Secure'] }
    expect(extractSessionCookie(headers)).toBe('secret')
  })

  it('falls back to the folded set-cookie header', () => {
    const headers = { get: (name: string) => name === 'set-cookie' ? 'x=1, dsh_remote=folded; Path=/' : null }
    expect(extractSessionCookie(headers)).toBe('folded')
  })

  it('returns undefined when no cookie matches', () => {
    expect(extractSessionCookie({ get: () => 'other=1' })).toBeUndefined()
    expect(extractSessionCookie({ getSetCookie: () => ['dsh_remote=; Path=/'] })).toBeUndefined()
    expect(extractSessionCookie({ get: () => null })).toBeUndefined()
  })
})

describe('pairWithHost', () => {
  it('pairs through a manual-redirect GET and returns base URL plus cookie', async () => {
    const calls: RequestInit[] = []
    const impl: FetchLike = async (_input, init) => {
      calls.push(init ?? {})
      return new Response(null, { status: 302, headers: { 'set-cookie': 'dsh_remote=abc123; HttpOnly; Secure; SameSite=Strict' } })
    }
    await expect(pairWithHost('https://fake-slug.trycloudflare.com/pair/t1', impl))
      .resolves.toEqual({ baseUrl: 'https://fake-slug.trycloudflare.com', cookie: 'abc123' })
    expect(calls[0]?.redirect).toBe('manual')
  })

  it('reports rejected when the gate answers a non-redirect status', async () => {
    const impl: FetchLike = async () => new Response('pairing page', { status: 200 })
    await expect(pairWithHost('https://host.example/pair/t1', impl)).rejects.toMatchObject({ failure: 'rejected' })
    const notFound: FetchLike = async () => new Response(null, { status: 404 })
    await expect(pairWithHost('https://host.example/pair/t1', notFound)).rejects.toMatchObject({ failure: 'rejected' })
  })

  it('reports no-cookie when the redirect carries no dsh_remote', async () => {
    const impl: FetchLike = async () => new Response(null, { status: 302 })
    await expect(pairWithHost('https://host.example/pair/t1', impl)).rejects.toMatchObject({ failure: 'no-cookie' })
  })

  it('reports network when the fetch itself fails', async () => {
    const impl: FetchLike = async () => {
      throw new Error('socket closed')
    }
    await expect(pairWithHost('https://host.example/pair/t1', impl)).rejects.toMatchObject({ failure: 'network' })
  })
})
