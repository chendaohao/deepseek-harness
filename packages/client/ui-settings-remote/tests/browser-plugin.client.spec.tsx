// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { RemoteSection } from '../src/client/RemoteSection.tsx'
import type { RemoteSectionInjected } from '../src/client/RemoteSection.tsx'
import { apply, inject, NS } from '../src/client/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

type DeviceId = Parameters<RemoteSectionInjected['unbind']>[0]
type ListResult =
  | { readonly ok: true; readonly value: { readonly devices: readonly unknown[] } }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
type UnbindResult =
  | { readonly ok: true; readonly value: { readonly removed: boolean } }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const list = vi.fn<() => Promise<ListResult>>()
    .mockResolvedValue({ ok: true, value: { devices: [] } })
  const unbind = vi.fn<(deviceId: DeviceId) => Promise<UnbindResult>>()
    .mockResolvedValue({ ok: true, value: { removed: true } })
  ctx.provide('remote.remoteAccessDevices', { list, unbind })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, unbind }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-remote browser plugin', () => {
  it('declares only the services used by the Settings Remote contribution', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.remoteAccessDevices'])
  })

  it('registers a localized section without reading the Remote eagerly', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entries = b.slots.entries('settings.section')
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.component).toBe(RemoteSection)
    expect(entry.options).toMatchObject({ id: 'remote', order: 20 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('远程访问')
    expect(b.list).not.toHaveBeenCalled()

    const injected = (entry.inject as unknown as () => RemoteSectionInjected)()
    await expect(injected.list()).resolves.toEqual([])
    expect(b.list).toHaveBeenCalledOnce()
    b.list.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(injected.list()).rejects.toThrow('remoteAccessDevices.list failed: REMOTE_ERROR: unavailable')
    const first = 'dev-a' as DeviceId
    await expect(injected.unbind(first)).resolves.toBe(true)
    b.unbind.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(injected.unbind(first)).rejects.toThrow('remoteAccessDevices.unbind failed: REMOTE_ERROR: unavailable')
    await b.ctx.fiber.dispose()
  })

  it('removes its contribution when the fiber disposes', async () => {
    const b = await bench()
    const disposeDeclaration = declare(b.slots)
    const plugin = b.ctx.plugin({ inject: [...inject], apply })
    await plugin.await()
    expect(b.slots.entries('settings.section')).toHaveLength(1)
    await b.ctx.fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    disposeDeclaration()
  })
})
