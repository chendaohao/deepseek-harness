import { describe, expect, it } from 'vitest'
import { VisionError } from '../src/error.ts'

describe('VisionError', () => {
  it('carries a stable machine-routing code', () => {
    const error = new VisionError('no vision route configured', 'VISION_UNCONFIGURED')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('VisionError')
    expect(error.code).toBe('VISION_UNCONFIGURED')
    expect(error.message).toBe('no vision route configured')
  })

  it('chains a cause through ErrorOptions', () => {
    const cause = new Error('provider refused')
    const error = new VisionError('observation failed', 'VISION_OBSERVE_FAILED', { cause })
    expect(error.cause).toBe(cause)
  })
})
