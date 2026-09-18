// @vitest-environment jsdom
/** Desktop remote-control panel: trigger → modal, initial state fetch, live events, and the device roster. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteFooterAction, type RemoteFooterActionProps } from '../src/client/RemoteFooterAction.tsx'
import type { RemoteDeviceRecord } from '../src/client/remote-types.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The locale seat's key domain is the remote dict ∪ common; the stub falls back to the key. */
const t: RemoteFooterActionProps['t'] = key => (en as Record<string, string>)[key] ?? key

/** Global standard-kit stubs: these components consume none of the hooks. */
const unusedHook = (() => { throw new Error('unused by remote panel components') }) as never
const kit = {
  useSessions: unusedHook,
  useSessionStatus: unusedHook,
  useSessionRetainInfo: unusedHook,
  useWorkspaces: unusedHook,
  useResource: unusedHook,
  usePanelInfo: unusedHook,
}

/** A typed remote stub that records `$on` subscriptions for later dispatch. */
function makeRemote() {
  const listeners = new Map<string, (payload: unknown) => void>()
  const remote = {
    $on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    }),
  }
  return {
    remote: remote as never,
    emit: (event: string, payload: unknown) => {
      act(() => { listeners.get(event)?.(payload) })
    },
  }
}

/** One resolved fetch response shaped like the panel's `res` reads. */
function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => data,
  } as Response)
}

/** A device record that reads online (fresh liveness). */
function device(deviceId: string, name: string): RemoteDeviceRecord {
  const now = Date.now()
  return { deviceId, name, createdAt: now, lastSeen: now, expiresAt: now + 30 * 86_400_000 }
}

describe('RemoteFooterAction', () => {
  it('renders the trigger icon with the label in the wide column', () => {
    const { container } = render(<RemoteFooterAction {...kit} wide remote={{ $on: vi.fn(() => () => {}) } as never} t={t} />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(screen.getByText('Remote')).toBeTruthy()
  })

  it('renders the rail icon without the label when collapsed', () => {
    const { container } = render(<RemoteFooterAction {...kit} wide={false} remote={{ $on: vi.fn(() => () => {}) } as never} t={t} />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(screen.queryByText('Remote')).toBeNull()
  })
})

describe('RemotePanel initial render', () => {
  it('opens the modal, pulls /remote/state, issues the pairing QR, and renders the open badge', async () => {
    const { remote, emit } = makeRemote()
    const pairUrl = 'https://foo.trycloudflare.com/pair/token'
    globalThis.fetch = vi.fn(async (input: string) => {
      const url = input
      if (url === '/remote/state') {
        return jsonResponse({ tunnelUrl: 'https://foo.trycloudflare.com', tunnelStatus: 'open', devices: [] })
      }
      if (url === '/remote/pair/issue') return jsonResponse({ url: pairUrl })
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))

    expect(await screen.findByText('Mobile Remote Control')).toBeTruthy()
    expect(screen.getByText('Scan to connect from your phone')).toBeTruthy()
    expect(await screen.findByText('Tunnel open')).toBeTruthy()
    await waitFor(() => { expect(globalThis.fetch).toHaveBeenCalledWith('/remote/state') })
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/remote/pair/issue', { method: 'POST' })
    })
    // The pairing QR is in the dialog once the pair URL lands (title carries the URL).
    const qrTitle = await screen.findByTitle(pairUrl)
    expect(qrTitle).toBeTruthy()
    // The QR renders large enough to scan reliably within the dialog column.
    const qrSvg = qrTitle.closest('svg')
    expect(qrSvg?.getAttribute('width')).toBe('200')
    expect(qrSvg?.getAttribute('height')).toBe('200')
    // Live event wiring: the tunnel ended event flips the badge; a device change
    // populates the roster without a refetch.
    emit('remote-tunnel/state', { status: 'ended' })
    expect(screen.getByText('Tunnel closed')).toBeTruthy()
    emit('remote/devices/change', [device('d1', 'Phone A')])
    expect(screen.getByText('Phone A')).toBeTruthy()
  })

  it('renders the closed badge and no QR when the tunnel is down', async () => {
    const { remote } = makeRemote()
    globalThis.fetch = vi.fn(async (input: string) => {
      const url = input
      if (url === '/remote/state') {
        return jsonResponse({ tunnelUrl: null, tunnelStatus: 'down', devices: [] })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))

    expect(await screen.findByText('Tunnel closed')).toBeTruthy()
    expect(screen.getByText('Tunnel is closed; no pairing QR code is available')).toBeTruthy()
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/remote/pair/issue', { method: 'POST' })
  })
})

describe('RemotePanel device roster', () => {
  it('renders each device row with its status and revokes on demand', async () => {
    const { remote } = makeRemote()
    globalThis.fetch = vi.fn(async (input: string) => {
      const url = input
      if (url === '/remote/state') {
        return jsonResponse({
          tunnelUrl: null,
          tunnelStatus: 'down',
          devices: [device('d1', 'Phone A'), device('d2', 'Tablet B')],
        })
      }
      if (url === '/remote/devices/d1/revoke') return jsonResponse({})
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))

    expect(await screen.findByText('Phone A')).toBeTruthy()
    expect(screen.getByText('Tablet B')).toBeTruthy()
    expect(screen.getAllByText(/Online/)).toHaveLength(2)
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!)
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/remote/devices/d1/revoke', { method: 'POST' })
    })
  })

  it('revokes an offline paired device without painting the load error', async () => {
    const { remote } = makeRemote()
    const offline = { ...device('d9', 'Old Phone'), lastSeen: Date.now() - 10 * 60_000 }
    globalThis.fetch = vi.fn(async (input: string) => {
      const url = input
      if (url === '/remote/state') {
        return jsonResponse({ tunnelUrl: null, tunnelStatus: 'down', devices: [offline] })
      }
      if (url === '/remote/devices/d9/revoke') return jsonResponse({})
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))

    expect(await screen.findByText('Old Phone')).toBeTruthy()
    expect(screen.getByText(/Offline/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/remote/devices/d9/revoke', { method: 'POST' })
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('confirms before stopping and then calls /remote/stop', async () => {
    const { remote } = makeRemote()
    globalThis.fetch = vi.fn(async (input: string) => {
      const url = input
      if (url === '/remote/state') {
        return jsonResponse({ tunnelUrl: null, tunnelStatus: 'down', devices: [] })
      }
      if (url === '/remote/stop') return jsonResponse({})
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Tunnel closed')

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByText(/Stop remote control\?/)).toBeTruthy()
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/remote/stop', { method: 'POST' })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }))
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/remote/stop', { method: 'POST' })
    })
  })

  it('renames a device inline and posts the new label', async () => {
    const { remote } = makeRemote()
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (typeof input === 'string' && input === '/remote/state') {
        return jsonResponse({ tunnelUrl: null, tunnelStatus: 'down', devices: [device('d1', 'Phone A')] })
      }
      if (typeof input === 'string' && input.startsWith('/remote/devices/d1/rename?name=')) return jsonResponse({})
      throw new Error('unexpected fetch')
    })

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Phone A')

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const nameInput = screen.getByDisplayValue('Phone A')
    // An emptied draft disables the save action.
    fireEvent.change(nameInput, { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Save' }).matches(':disabled')).toBe(true)
    fireEvent.change(nameInput, { target: { value: '我的iPhone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/remote/devices/d1/rename?name=' + encodeURIComponent('我的iPhone'), { method: 'POST' })
    })
  })
})
