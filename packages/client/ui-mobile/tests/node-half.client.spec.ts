/**
 * The server-side guard. This file carries no jsdom pragma, so it runs in the
 * suite's node environment where `document` is undefined — the one state the
 * jsdom specs cannot reach. The host Loader entry is inert by design, and the
 * browser half must not touch a document that does not exist.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-mobile/client'

describe('ui-mobile apply outside a browser', () => {
  it('returns without installing anything when no document exists', async () => {
    expect(typeof document).toBe('undefined')
    const ctx = new Context()
    ctx.provide('layout', { toggleSidebar: () => {} } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await expect(fiber.await()).resolves.toBeDefined()
    await fiber.dispose()
  })
})
