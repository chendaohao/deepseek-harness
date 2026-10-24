/** Remote-section registration: the settings section seat, dictionaries, and teardown recovery. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-remote/client'
import { apply as hostApply } from '../src/index.ts'
import { RemoteSettingsSection } from '../src/client/RemoteSettingsSection.tsx'
import type { RemoteSettingsSectionInjected } from '../src/client/RemoteSettingsSection.tsx'

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

/** Declare the settings-section hole the way the settings shell entry does. */
function declare(slots: SlotRegistry): () => void {
  return slots.register(
    {
      name: 'root',
      children: {
        'settings.section': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
}

describe('ui-remote apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote'])
  })

  it('keeps the host Loader entry inert', () => {
    expect(() => { hostApply() }).not.toThrow()
  })

  it('registers the settings section and dictionaries, and frees them on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(RemoteSettingsSection)
    expect(entry.options).toMatchObject({ id: 'remote', order: 25 })
    expect(entry.locale).toBe('settings.remote')
    const injected = (entry.inject as object as () => RemoteSettingsSectionInjected)()
    expect(injected.remote).toBe(b.remote)
    expect(b.locale.bind('settings.remote')('nav')).toBe('远程控制')
    b.locale.setLocale('en')
    expect(b.locale.bind('settings.remote')('nav')).toBe('Remote')
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toEqual([])
    // The (ns, locale) seats are free again — the dictionary disposer ran.
    expect(() => b.locale.register('settings.remote', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('settings.remote', 'en', {})).not.toThrow()
  })

  it('leaves a third-party dictionary in the bare `remote` namespace untouched', async () => {
    const b = await bench()
    // A language pack owns `remote` independently of this plugin; registering
    // both used to abort this entry with "already has locale".
    b.locale.register('remote', 'ru', { nav: 'Пульт' })
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.section')[0]!.component).toBe(RemoteSettingsSection)
    await fiber.dispose()
  })

  it('leaves the hole untouched before the declaration exists', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.section')).toEqual([])
    declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('settings.section')[0]!.component).toBe(RemoteSettingsSection)
    await fiber.dispose()
  })
})
