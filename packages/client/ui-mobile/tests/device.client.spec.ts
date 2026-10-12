/** Device gate: the phone predicate decides whether any of the layer installs. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPhoneDevice } from '../src/client/device.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** A media-query table answering the two queries the predicate asks. */
function queryTable(hover: boolean, coarse: boolean): (query: string) => { matches: boolean } {
  return media => ({ matches: media === '(hover: hover)' ? hover : coarse })
}

describe('isPhoneDevice', () => {
  it('treats a coarse pointer without hover as a phone', () => {
    expect(isPhoneDevice({ matchMedia: queryTable(false, true), userAgent: '' })).toBe(true)
  })

  it('excludes a laptop touchscreen, which reports hover', () => {
    expect(isPhoneDevice({ matchMedia: queryTable(true, true), userAgent: '' })).toBe(false)
  })

  it('excludes a fine-pointer desktop', () => {
    expect(isPhoneDevice({ matchMedia: queryTable(true, false), userAgent: '' })).toBe(false)
  })

  it('falls back to the user agent when no query engine is present', () => {
    expect(isPhoneDevice({ matchMedia: undefined, userAgent: 'Mozilla/5.0 (Linux; Android 14)' })).toBe(true)
    expect(isPhoneDevice({ matchMedia: undefined, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe(false)
  })

  it('falls back to the user agent when a query engine matches neither query', () => {
    // A runtime whose engine answers false for both queries is not a phone by
    // capability; the user agent decides.
    expect(isPhoneDevice({ matchMedia: queryTable(false, false), userAgent: 'Mozilla/5.0 (iPhone)' })).toBe(true)
  })

  it('reads the browser globals when no environment is given', () => {
    // The suite lane has no matchMedia; the user agent then decides, and an
    // empty one is not a phone.
    expect(isPhoneDevice()).toBe(false)
  })

  it('reads the global user agent when a query engine exists but answers neither query', () => {
    vi.stubGlobal('matchMedia', queryTable(false, false))
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPad)' })
    expect(isPhoneDevice()).toBe(true)
  })

  it('treats a missing global navigator as no user agent', () => {
    // No matchMedia and no navigator at all: the empty fallback is not a phone.
    vi.stubGlobal('navigator', undefined)
    expect(isPhoneDevice()).toBe(false)
  })
})