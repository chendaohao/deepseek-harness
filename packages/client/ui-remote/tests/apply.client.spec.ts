/** Remote-panel registration: the footer action seat, dictionaries, and teardown recovery. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-remote/client'
import { RemoteFooterAction } from '../src/client/RemoteFooterAction.tsx'
import type { RemoteFooterActionInjected } from '../src/client/RemoteFooterAction.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const remote = { $on: vi.fn(() => () => {}) }
  ctx.provide('remote', remote)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, remote }
}

/** Declare the footer-action hole the way ui-sidebar's shell entry does. */
function declare(slots: SlotRegistry): () => void {
  return slots.register(
    {
      name: 'root',
      children: {
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
}

describe('ui-remote apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote'])
  })

  it('registers the footer action and dictionaries, and frees them on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('sidebar.footer.action')[0]!
    expect(entry.component).toBe(RemoteFooterAction)
    expect(entry.options).toMatchObject({ id: 'remote', order: 0 })
    expect(entry.locale).toBe('remote')
    const injected = (entry.inject as unknown as () => RemoteFooterActionInjected)()
    expect(injected.remote).toBe(b.remote)
    expect(b.locale.bind('remote')('panel.title')).toBe('移动端远程控制')
    b.locale.setLocale('en')
    expect(b.locale.bind('remote')('panel.title')).toBe('Mobile Remote Control')
    await fiber.dispose()
    expect(b.slots.entries('sidebar.footer.action')).toEqual([])
    // The (ns, locale) seats are free again — the dictionary disposer ran.
    expect(() => b.locale.register('remote', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('remote', 'en', {})).not.toThrow()
  })

  it('leaves the hole untouched before the declaration exists', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('sidebar.footer.action')).toEqual([])
    declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('sidebar.footer.action')[0]!.component).toBe(RemoteFooterAction)
    await fiber.dispose()
  })
})
