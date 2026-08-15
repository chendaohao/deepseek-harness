import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureAbortSignalStatics, randomUuid } from '../src/shims.ts'

describe('randomUuid', () => {
  it('returns a UUID v4 from the platform source', () => {
    const uuid = randomUuid()
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(randomUuid()).not.toBe(uuid)
  })

  it('falls back to getRandomValues without randomUUID', () => {
    const original = globalThis.crypto
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues')
    Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: original.getRandomValues.bind(original) }, configurable: true })
    try {
      expect(randomUuid()).toMatch(/^[0-9a-f-]{36}$/)
      expect(random).toHaveBeenCalled()
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true })
    }
  })

  it('falls back to Math.random without any crypto', () => {
    const original = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
    try {
      expect(randomUuid()).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true })
    }
  })
})

describe('ensureAbortSignalStatics', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops every input listener once the combined signal settles', () => {
    const original = (signals: AbortSignal[]): AbortSignal => AbortSignal.any(signals)
    try {
      delete (AbortSignal as unknown as Record<string, unknown>).any
      ensureAbortSignalStatics()
      const first = new AbortController()
      const second = new AbortController()
      const removeSpy = vi.spyOn(second.signal, 'removeEventListener')
      const combined = AbortSignal.any([first.signal, second.signal])
      first.abort(new Error('first'))
      expect(combined.aborted).toBe(true)
      // The settled combine removed the listener from the surviving input.
      expect(removeSpy).toHaveBeenCalled()
      // A later abort of the surviving input must not fire anything (no
      // listener remains) — reaching this line without a throw suffices, but
      // the spy assertion above is the observable contract.
      second.abort(new Error('late'))
    } finally {
      ;(AbortSignal as unknown as Record<string, unknown>).any = original
    }
  })

  it('keeps native statics when present', () => {
    const original = (AbortSignal as unknown as Record<string, unknown>).timeout
    ensureAbortSignalStatics()
    expect((AbortSignal as unknown as Record<string, unknown>).timeout).toBe(original)
  })

  it('installs timeout when missing and the installed one aborts', async () => {
    vi.useFakeTimers()
    const original = (AbortSignal as unknown as Record<string, unknown>).timeout
    try {
      delete (AbortSignal as unknown as Record<string, unknown>).timeout
      ensureAbortSignalStatics()
      const signal = AbortSignal.timeout(100)
      expect(signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(99)
      expect(signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(signal.aborted).toBe(true)
    } finally {
      ;(AbortSignal as unknown as Record<string, unknown>).timeout = original
    }
  })

  it('installs any when missing; the combined signal aborts with the first input', () => {
    const original = (AbortSignal as unknown as Record<string, unknown>).any
    try {
      delete (AbortSignal as unknown as Record<string, unknown>).any
      ensureAbortSignalStatics()
      const first = new AbortController()
      const second = new AbortController()
      const combined = AbortSignal.any([first.signal, second.signal])
      expect(combined.aborted).toBe(false)
      second.abort(new Error('second'))
      expect(combined.aborted).toBe(true)
      expect(combined.reason).toBeInstanceOf(Error)
      // An already-aborted input aborts the combined signal immediately.
      const aborted = new AbortController()
      aborted.abort()
      expect(AbortSignal.any([aborted.signal]).aborted).toBe(true)
    } finally {
      ;(AbortSignal as unknown as Record<string, unknown>).any = original
    }
  })
})
