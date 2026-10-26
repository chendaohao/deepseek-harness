/** Host face of the Session UI adapter: settings registration without a settings service. */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('ui-session Host apply', () => {
  it('keeps the Host loader half inert without a settings service', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
