import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
// Same-package internals: the lib artifact is not built on a clean tree.
import { MobileApiClient, VoiceChatController } from '../src/index.ts'
import * as MobileInvariant from '../src/invariant.ts'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(MobileInvariant).await()).resolves.toBeDefined()
  })

  it('the package root exports the constructible library surface', () => {
    expect(MobileApiClient).toBeTypeOf('function')
    expect(VoiceChatController).toBeTypeOf('function')
  })
})
