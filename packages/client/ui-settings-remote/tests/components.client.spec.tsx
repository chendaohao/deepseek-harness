// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteSection } from '../src/client/RemoteSection.tsx'
import type { RemoteSectionInjected, RemoteSectionProps } from '../src/client/RemoteSection.tsx'
import type { RemoteDeviceView } from '@deepseek-ai/dsh-api-remotes/client'
import { en, type RemoteLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

type Snapshot = Awaited<ReturnType<RemoteSectionInjected['list']>>
const t = ((key: RemoteLocaleKey, vars?: Record<string, string>): string => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(vars ?? {})) {
    text = text.replaceAll('{' + name + '}', value)
  }
  return text
}) as RemoteSectionInjected['t']

const DAY_MS = 86_400_000
const NOW = Date.now()
/** Brand a fixture device id once (tests are the sanctioned cast point). */
const device = (value: string) => value as RemoteDeviceView['deviceId']

const DEVICES: Snapshot = [
  {
    deviceId: device('dev-a'),
    label: 'Pixel 8',
    boundAt: NOW - 40 * DAY_MS,
    lastUsedAt: NOW,
    expiresAt: NOW + 29 * DAY_MS,
  },
  {
    deviceId: device('dev-d'),
    label: '办公笔记本',
    boundAt: NOW - 10 * DAY_MS,
    lastUsedAt: NOW - 30 * 60_000,
    expiresAt: NOW + 10 * DAY_MS,
  },
  {
    deviceId: device('dev-b'),
    label: 'Chrome on macOS',
    boundAt: NOW - 3 * DAY_MS,
    lastUsedAt: NOW - 2 * 3_600_000,
    expiresAt: NOW + DAY_MS,
  },
  {
    deviceId: device('dev-c'),
    label: '旧平板',
    boundAt: NOW - 60 * DAY_MS,
    lastUsedAt: NOW - 3 * DAY_MS,
    expiresAt: NOW,
  },
]

function props(list: RemoteSectionInjected['list'], unbind: RemoteSectionInjected['unbind'] = async () => true): RemoteSectionProps {
  return { t, list, unbind }
}

describe('RemoteSection', () => {
  it('renders rows with bound date, relative use, and the countdown', async () => {
    const list = vi.fn(async () => DEVICES)
    render(<RemoteSection {...props(list)} />)
    expect(await screen.findByText('Pixel 8')).toBeTruthy()
    expect(list).toHaveBeenCalledOnce()
    expect(screen.getByText(en.lastUsedJustNow)).toBeTruthy()
    expect(screen.getByText(t('lastUsedMinutesAgo', { n: '30' }))).toBeTruthy()
    expect(screen.getByText(t('lastUsedHoursAgo', { n: '2' }))).toBeTruthy()
    expect(screen.getByText(t('lastUsedDaysAgo', { n: '3' }))).toBeTruthy()
    expect(screen.getByText(t('expiresInDays', { n: '29' }))).toBeTruthy()
    // A deadline inside today renders the today copy, never a zero-day count.
    expect(screen.getByText(en.expiresToday)).toBeTruthy()
    expect(screen.queryByText(t('expiresInDays', { n: '0' }))).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    expect(screen.getAllByRole('button', { name: en.unbind })).toHaveLength(4)
  })

  it('renders the empty state when no devices are bound', async () => {
    render(<RemoteSection {...props(async () => [])} />)
    expect(await screen.findByText(en.empty)).toBeTruthy()
  })

  it('shows a failure alert with retry and does not leak transport detail', async () => {
    const list = vi.fn<RemoteSectionInjected['list']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce([])
    render(<RemoteSection {...props(list)} />)
    expect((await screen.findByRole('alert')).textContent).toContain(en.loadFailed)
    expect(screen.queryByText(/private transport detail/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText(en.empty)).toBeTruthy()
  })

  it('unbinds through a two-step confirmation and reloads the list', async () => {
    const list = vi.fn(async () => DEVICES)
    const unbind = vi.fn(async () => true)
    render(<RemoteSection {...props(list, unbind)} />)
    await screen.findByText('Pixel 8')
    // First tap only arms the confirmation.
    fireEvent.click(screen.getAllByRole('button', { name: en.unbind })[0]!)
    expect(unbind).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.confirmUnbind }))
    await waitFor(() => { expect(unbind).toHaveBeenCalledWith('dev-a') })
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
  })

  it('cancel disarms the confirmation and a failed unbind surfaces the alert', async () => {
    const list = vi.fn(async () => DEVICES)
    const unbind = vi.fn(async () => false)
    render(<RemoteSection {...props(list, unbind)} />)
    await screen.findByText('Chrome on macOS')
    fireEvent.click(screen.getAllByRole('button', { name: en.unbind })[2]!)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(unbind).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: en.confirmUnbind })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: en.unbind })[2]!)
    fireEvent.click(screen.getByRole('button', { name: en.confirmUnbind }))
    await waitFor(() => { expect(unbind).toHaveBeenCalledWith('dev-b') })
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('ignores late list settlements after unmount', async () => {
    const deferred = Promise.withResolvers<Snapshot>()
    const view = render(<RemoteSection {...props(() => deferred.promise)} />)
    view.unmount()
    await act(async () => { deferred.resolve(DEVICES) })
    const rejected = Promise.withResolvers<Snapshot>()
    const second = render(<RemoteSection {...props(() => rejected.promise)} />)
    second.unmount()
    await act(async () => { rejected.reject(new Error('late failure')) })
  })

  it('renders nothing without a complete inject face', () => {
    const view = render(<RemoteSection />)
    expect(view.container.textContent).toBe('')
  })

  it('surfaces an unbind transport failure as the alert', async () => {
    const list = vi.fn(async () => DEVICES)
    const unbind = vi.fn<RemoteSectionInjected['unbind']>()
      .mockRejectedValueOnce(new Error('transport down'))
    render(<RemoteSection {...props(list, unbind)} />)
    await screen.findByText('Pixel 8')
    fireEvent.click(screen.getAllByRole('button', { name: en.unbind })[0]!)
    fireEvent.click(screen.getByRole('button', { name: en.confirmUnbind }))
    await waitFor(() => { expect(unbind).toHaveBeenCalledWith('dev-a') })
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
