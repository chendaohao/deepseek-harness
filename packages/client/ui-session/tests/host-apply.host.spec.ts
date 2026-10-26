/** Host face of the Session UI adapter: settings registration without a settings service. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('ui-session Host apply', () => {
  it('keeps the Host loader half inert without a settings service', () => {
    const ctx = new Context()
    // The settings registration waits on an optional service, so a roster that
    // never provides one must still load the plugin.
    expect(() => { apply(ctx) }).not.toThrow()
  })
})
