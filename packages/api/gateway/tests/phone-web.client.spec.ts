/** Phone-web detection: the capability gate that decides whether a page churns its streams on foreground return. */
import { afterEach, describe, expect, it } from 'vitest'
import { isPhoneWeb } from '../src/client/stream-client.ts'

const originalMatchMedia = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia')
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

afterEach(() => {
  if (originalMatchMedia === undefined) Reflect.deleteProperty(globalThis, 'matchMedia')
  else Object.defineProperty(globalThis, 'matchMedia', originalMatchMedia)
  if (originalNavigator === undefined) Reflect.deleteProperty(globalThis, 'navigator')
  else Object.defineProperty(globalThis, 'navigator', originalNavigator)
})

/** Install one `matchMedia` query table plus a user agent for the call under test. */
function install(query: { readonly hover: boolean; readonly coarse: boolean }, userAgent: string): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: (media: string) => ({
      matches: media === '(hover: hover)' ? query.hover : query.coarse,
    }),
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent } })
}

describe('isPhoneWeb', () => {
  it('treats a coarse pointer without hover as phone web', () => {
    install({ hover: false, coarse: true }, 'Mozilla/5.0 (Linux; Android 14)')
    expect(isPhoneWeb()).toBe(true)
  })

  it('keeps a laptop touchscreen out: it reports hover, so its tab switches keep the socket', () => {
    install({ hover: true, coarse: true }, 'Mozilla/5.0 (Windows NT 11.0)')
    expect(isPhoneWeb()).toBe(false)
  })

  it('keeps a fine-pointer desktop out', () => {
    install({ hover: true, coarse: false }, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    expect(isPhoneWeb()).toBe(false)
  })

  it('falls back to the user agent for a coarse-pointer runtime without hover support', () => {
    install({ hover: false, coarse: false }, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')
    expect(isPhoneWeb()).toBe(true)
  })

  it('does not read a desktop user agent as phone when the engine answers neither query', () => {
    install({ hover: false, coarse: false }, 'Mozilla/5.0 (X11; Linux x86_64)')
    expect(isPhoneWeb()).toBe(false)
  })

  it('falls back to the user agent where matchMedia is absent', () => {
    Reflect.deleteProperty(globalThis, 'matchMedia')
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0)' } })
    expect(isPhoneWeb()).toBe(true)
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } })
    expect(isPhoneWeb()).toBe(false)
  })
})
