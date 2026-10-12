// @vitest-environment jsdom
/** Desktop remote-control panel: trigger → modal, initial state fetch, live events, and the device roster. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteFooterAction, type RemoteFooterActionProps } from '../src/client/RemoteFooterAction.tsx'
import type { RemoteDeviceRecord } from '../src/client/remote-types.ts'
import { en } from '../src/client/locales.ts'
import panelCss from '../src/client/RemoteFooterAction.module.css'

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

/** One refused control-plane response. */
function failed(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as Response
}

/**
 * A fetch stub whose routes settle only when the test releases them, so a
 * dialog can close while a control-plane call is still in flight. Routes in
 * `ready` answer immediately; every other URL queues until `settle`.
 */
function controlledFetch(ready: Record<string, () => Response> = {}) {
  const pending = new Map<string, Array<(outcome: Response | Error) => void>>()
  const fetchMock = vi.fn((input: string) => {
    const answered = ready[input]
    if (answered !== undefined) return Promise.resolve(answered())
    return new Promise<Response>((resolve, reject) => {
      const queue = pending.get(input) ?? []
      queue.push((outcome) => { if (outcome instanceof Error) reject(outcome); else resolve(outcome) })
      pending.set(input, queue)
    })
  })
  globalThis.fetch = fetchMock as typeof fetch
  return {
    count: (input: string) => fetchMock.mock.calls.filter(call => call[0] === input).length,
    async settle(input: string, outcome: Response | Error): Promise<void> {
      const release = pending.get(input)?.shift()
      if (release === undefined) throw new Error(`no pending ${input}`)
      await act(async () => { release(outcome) })
    },
  }
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
  it('caps the dialog against the viewport and scrolls the panel body', async () => {
    // The roster grows without bound, so an uncapped card pushes the stop row
    // past the viewport, where the fixed modal layer cannot scroll to it.
    const { remote } = makeRemote()
    globalThis.fetch = vi.fn(async (input: string) => {
      const url = input
      if (url === '/remote/state') {
        return jsonResponse({ tunnelUrl: null, tunnelStatus: 'down', devices: [] })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Tunnel closed')

    // Assert the panel's own classes, not Modal's built-in `.content` region,
    // which every dialog carries.
    const dialog = screen.getByRole('dialog', { name: 'Mobile Remote Control' })
    expect(dialog.className).toContain(panelCss.dialog)
    const panel = dialog.querySelector(`.${panelCss.content}`)
    expect(panel).toBeTruthy()
    expect(panel?.textContent).toContain('Tunnel closed')
  })

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
    }) as typeof fetch

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
    }) as typeof fetch

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
    }) as typeof fetch

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
    }) as typeof fetch

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
    }) as typeof fetch

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

  it('cancels a rename from the button and from the Escape key', async () => {
    const { remote } = makeRemote()
    globalThis.fetch = vi.fn(async (input: string) => {
      if (input === '/remote/state') {
        return jsonResponse({ tunnelUrl: null, tunnelStatus: 'down', devices: [device('d1', 'Phone A')] })
      }
      throw new Error(`unexpected fetch ${input}`)
    }) as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Phone A')

    // Cancel restores the row without issuing any request.
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(screen.getByDisplayValue('Phone A')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByDisplayValue('Phone A')).toBeNull()
    expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy()

    // Escape cancels the draft the same way.
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByDisplayValue('Phone A')
    fireEvent.change(input, { target: { value: 'draft' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByDisplayValue('draft')).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/rename'), expect.anything(),
    )
  })

  it('saves a rename from the Enter key and keeps the row on a failed save', async () => {
    const { remote } = makeRemote()
    globalThis.fetch = vi.fn(async (input: string) => {
      if (input === '/remote/state') {
        return jsonResponse({ tunnelUrl: null, tunnelStatus: 'down', devices: [device('d1', 'Phone A')] })
      }
      if (typeof input === 'string' && input.startsWith('/remote/devices/d1/rename?name=')) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response)
      }
      throw new Error(`unexpected fetch ${input}`)
    }) as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Phone A')

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByDisplayValue('Phone A')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // The failed save paints the rename error and keeps the draft open.
    expect((await screen.findByRole('alert')).textContent).toBe('Failed to rename device')
    expect(screen.getByDisplayValue('Renamed')).toBeTruthy()
  })

  it('copies the pairing link and reports a failed control-plane call', async () => {
    const { remote } = makeRemote()
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    const pairUrl = 'https://foo.trycloudflare.com/pair/token'
    let stopFails = false
    globalThis.fetch = vi.fn(async (input: string) => {
      if (input === '/remote/state') {
        return jsonResponse({ tunnelUrl: 'https://foo.trycloudflare.com', tunnelStatus: 'open', devices: [] })
      }
      if (input === '/remote/pair/issue') return jsonResponse({ url: pairUrl })
      if (input === '/remote/stop') {
        return stopFails
          ? Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response)
          : jsonResponse({})
      }
      throw new Error(`unexpected fetch ${input}`)
    }) as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByTitle(pairUrl)

    // Copying flips the button label to the copied state.
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(pairUrl) })
    // The stub translate falls back to the key, so the copied seat reads 'copied'.
    expect(await screen.findByRole('button', { name: 'copied' })).toBeTruthy()

    // A refused stop surfaces the load error instead of silently succeeding.
    stopFails = true
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Failed to load remote status')
  })

  it('reports a failed revoke and a failed refresh without losing the panel', async () => {
    const { remote } = makeRemote()
    const pairUrl = 'https://foo.trycloudflare.com/pair/token'
    let pairFails = false
    globalThis.fetch = vi.fn(async (input: string) => {
      if (input === '/remote/state') {
        return jsonResponse({
          tunnelUrl: 'https://foo.trycloudflare.com',
          tunnelStatus: 'open',
          devices: [device('d1', 'Phone A')],
        })
      }
      if (input === '/remote/pair/issue') {
        if (pairFails) return Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as Response)
        return jsonResponse({ url: pairUrl })
      }
      if (input === '/remote/devices/d1/revoke') {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response)
      }
      throw new Error(`unexpected fetch ${input}`)
    }) as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Phone A')

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Failed to load remote status')

    // A failed pairing issue reports the pair-specific message.
    pairFails = true
    fireEvent.click(screen.getByRole('button', { name: 'Refresh QR code' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Tunnel is closed; no pairing QR code is available')
    })
  })

  it('surfaces a transport failure while loading the panel state', async () => {
    const { remote } = makeRemote()
    globalThis.fetch = vi.fn(async () => { throw new Error('network down') })

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Failed to load remote status')
  })

  it('renders the failed tunnel state from a live state frame', async () => {
    const { remote, emit } = makeRemote()
    globalThis.fetch = vi.fn(async (input: string) => {
      if (input === '/remote/state') {
        return jsonResponse({ tunnelUrl: null, tunnelStatus: 'down', devices: [] })
      }
      throw new Error(`unexpected fetch ${input}`)
    }) as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Tunnel closed')

    emit('remote-tunnel/state', { status: 'failed', message: 'handshake refused' })
    await waitFor(() => { expect(screen.getByText('Tunnel connection failed')).toBeTruthy() })
  })

  it('dismisses the stop confirmation without calling the control plane', async () => {
    const { remote } = makeRemote()
    globalThis.fetch = vi.fn(async (input: string) => {
      if (input === '/remote/state') {
        return jsonResponse({ tunnelUrl: null, tunnelStatus: 'down', devices: [] })
      }
      throw new Error(`unexpected fetch ${input}`)
    }) as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Tunnel closed')

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByText(/Stop remote control\?/)).toBeTruthy()
    // The cancel seat restores the plain stop button and issues no request.
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(screen.queryByText(/Stop remote control\?/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/remote/stop', { method: 'POST' })
  })

  it('ignores live events that arrive after the panel unmounts', async () => {
    const { remote, emit } = makeRemote()
    globalThis.fetch = vi.fn(async (input: string) => {
      if (input === '/remote/state') {
        return jsonResponse({ tunnelUrl: null, tunnelStatus: 'down', devices: [] })
      }
      throw new Error(`unexpected fetch ${input}`)
    }) as typeof fetch

    const view = render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Tunnel closed')

    // Close the modal: the panel body unmounts and its subscriptions detach, so
    // a late frame must not update state on the disposed instance.
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByText('Tunnel closed')).toBeNull() })
    emit('remote/devices/change', [device('d1', 'Phone A')])
    expect(screen.queryByText('Phone A')).toBeNull()
    view.unmount()
  })
})

describe('RemotePanel lifecycle edges', () => {
  it('renders the load error when the control plane answers /remote/state with a non-ok status', async () => {
    const { remote } = makeRemote()
    globalThis.fetch = vi.fn(async (input: string) => {
      if (input === '/remote/state') {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as Response)
      }
      throw new Error(`unexpected fetch ${input}`)
    }) as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))

    // An HTTP refusal is a failure, not an empty snapshot: the panel reports it
    // instead of painting the closed-tunnel placeholder.
    expect((await screen.findByRole('alert')).textContent).toBe('Failed to load remote status')
    // The failed snapshot is not adopted as a down tunnel: the QR stays in its
    // unavailable placeholder rather than reading as a resolved closed tunnel.
    expect(screen.getByText('Tunnel is closed; no pairing QR code is available')).toBeTruthy()
  })

  it('drops a state snapshot that lands after the panel closed', async () => {
    const { remote } = makeRemote()
    let releaseState: ((value: Response) => void) | undefined
    globalThis.fetch = vi.fn(async (input: string) => {
      if (input === '/remote/state') {
        // Held open so the dialog can close while the snapshot is still in flight.
        return new Promise<Response>((resolve) => { releaseState = resolve })
      }
      throw new Error(`unexpected fetch ${input}`)
    }) as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByRole('button', { name: 'Refresh QR code' })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })

    await act(async () => {
      releaseState!(await jsonResponse({ tunnelUrl: null, tunnelStatus: 'down', devices: [device('d1', 'Phone A')] }))
    })
    // The disposed panel instance must not adopt the late roster or its tunnel view.
    expect(screen.queryByText('Phone A')).toBeNull()
    expect(screen.queryByText('Tunnel closed')).toBeNull()
  })

  it('drops a pairing URL and a tunnel frame that land after the panel closed', async () => {
    const { remote, emit } = makeRemote()
    const pairUrl = 'https://foo.trycloudflare.com/pair/token'
    let releasePair: ((value: Response) => void) | undefined
    globalThis.fetch = vi.fn(async (input: string) => {
      if (input === '/remote/state') {
        return jsonResponse({ tunnelUrl: 'https://foo.trycloudflare.com', tunnelStatus: 'open', devices: [] })
      }
      if (input === '/remote/pair/issue') {
        return new Promise<Response>((resolve) => { releasePair = resolve })
      }
      throw new Error(`unexpected fetch ${input}`)
    }) as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Tunnel open')
    await waitFor(() => { expect(releasePair).toBeDefined() })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByText('Tunnel open')).toBeNull() })

    // A live frame that arrives after disposal must not resurrect the panel.
    emit('remote-tunnel/state', { status: 'failed', message: 'late frame' })
    await act(async () => { releasePair!(await jsonResponse({ url: pairUrl })) })
    expect(screen.queryByTitle(pairUrl)).toBeNull()
    expect(screen.queryByText('Tunnel connection failed')).toBeNull()
  })

  it('adopts an open tunnel frame, reverts the copied label on its timer, and refuses a copy without a URL', async () => {
    const { remote, emit } = makeRemote()
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    const pairUrl = 'https://foo.trycloudflare.com/pair/token'
    globalThis.fetch = vi.fn(async (input: string) => {
      if (input === '/remote/state') {
        return jsonResponse({ tunnelUrl: null, tunnelStatus: 'down', devices: [] })
      }
      if (input === '/remote/pair/issue') return jsonResponse({ url: pairUrl })
      throw new Error(`unexpected fetch ${input}`)
    }) as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Tunnel closed')

    // No pairing URL exists yet, so the copy seat stays inert and never writes.
    const copySeat = screen.getByRole('button', { name: 'Copy link' })
    expect(copySeat).toHaveProperty('disabled', true)
    fireEvent.click(copySeat)
    expect(writeText).not.toHaveBeenCalled()

    // A live open frame upgrades the badge without refetching the snapshot.
    emit('remote-tunnel/state', { status: 'open', url: 'https://foo.trycloudflare.com' })
    expect(await screen.findByText('Tunnel open')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh QR code' }))
    await screen.findByTitle(pairUrl)

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(pairUrl) })
    expect(await screen.findByRole('button', { name: 'copied' })).toBeTruthy()
    // The copied acknowledgement is a 1.2 s timer and must clear itself.
    await waitFor(
      () => { expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy() },
      { timeout: 3000 },
    )
  })

  it('ignores an empty rename submitted from the keyboard', async () => {
    const { remote } = makeRemote()
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (input: string) => {
      calls.push(input)
      if (input === '/remote/state') {
        return jsonResponse({ tunnelUrl: null, tunnelStatus: 'down', devices: [device('d1', 'Phone A')] })
      }
      throw new Error(`unexpected fetch ${input}`)
    }) as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Phone A')

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '   ' } })
    // Enter is not gated by the Save seat's disabled state, so the callback
    // itself has to refuse a blank label.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(calls.some(url => url.includes('/rename?name='))).toBe(false)
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('drops a refused state snapshot that lands after the panel closed', async () => {
    const { remote } = makeRemote()
    const control = controlledFetch()
    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await waitFor(() => { expect(control.count('/remote/state')).toBe(1) })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })

    // A rejected snapshot resolves into the catch; the disposed instance must
    // not paint its load error onto a panel nobody is showing.
    await control.settle('/remote/state', new Error('network down'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('drops a refused pairing call that lands after the panel closed', async () => {
    const { remote } = makeRemote()
    const control = controlledFetch({
      '/remote/state': () => ({ ok: true, status: 200, json: async () => ({ tunnelUrl: 'https://foo.trycloudflare.com', tunnelStatus: 'open', devices: [] }) } as Response),
    })
    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Tunnel open')
    await waitFor(() => { expect(control.count('/remote/pair/issue')).toBe(1) })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByText('Tunnel open')).toBeNull() })

    await control.settle('/remote/pair/issue', failed(503))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('drops a refused revoke, stop, and rename that land after the panel closed', async () => {
    const { remote } = makeRemote()
    const control = controlledFetch({
      '/remote/state': () => ({
        ok: true, status: 200,
        json: async () => ({ tunnelUrl: null, tunnelStatus: 'down', devices: [device('d1', 'Phone A')] }),
      } as Response),
    })
    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Phone A')

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Phone Z' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(control.count('/remote/devices/d1/revoke')).toBe(1)
      expect(control.count('/remote/stop')).toBe(1)
      expect(control.count('/remote/devices/d1/rename?name=Phone%20Z')).toBe(1)
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })

    // Every completion below is refused or applied off-screen; none may set
    // state on the disposed panel or repaint its error line.
    await control.settle('/remote/devices/d1/revoke', failed(500))
    await control.settle('/remote/stop', failed(500))
    await control.settle('/remote/devices/d1/rename?name=Phone%20Z', await jsonResponse({}))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('drops a refused rename that lands after the panel closed', async () => {
    const { remote } = makeRemote()
    const control = controlledFetch({
      '/remote/state': () => ({
        ok: true, status: 200,
        json: async () => ({ tunnelUrl: null, tunnelStatus: 'down', devices: [device('d1', 'Phone A')] }),
      } as Response),
    })
    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Phone A')

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Phone Z' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(control.count('/remote/devices/d1/rename?name=Phone%20Z')).toBe(1) })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })

    await control.settle('/remote/devices/d1/rename?name=Phone%20Z', failed(500))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('drops frames delivered on a subscription that outlives the panel', async () => {
    // An event already dispatched when the dialog closes still holds this
    // callback even though the panel disposed its subscription.
    const delivered = new Map<string, (payload: unknown) => void>()
    const remote = {
      $on: vi.fn((event: string, listener: (payload: unknown) => void) => {
        delivered.set(event, listener)
        return () => {}
      }),
    }
    globalThis.fetch = vi.fn(async (input: string) => {
      if (input === '/remote/state') {
        return jsonResponse({ tunnelUrl: null, tunnelStatus: 'down', devices: [] })
      }
      throw new Error(`unexpected fetch ${input}`)
    }) as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote as never} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByText('Tunnel closed')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })

    act(() => {
      delivered.get('remote-tunnel/state')!({ status: 'open', url: 'https://late.trycloudflare.com' })
      delivered.get('remote/devices/change')!([device('d9', 'Late Phone')])
    })
    expect(screen.queryByText('Tunnel open')).toBeNull()
    expect(screen.queryByText('Late Phone')).toBeNull()
  })

  it('leaves the copied state alone when the clipboard write is refused', async () => {
    const { remote } = makeRemote()
    const writeText = vi.fn(async () => { throw new Error('denied') })
    Object.assign(navigator, { clipboard: { writeText } })
    const pairUrl = 'https://foo.trycloudflare.com/pair/token'
    globalThis.fetch = vi.fn(async (input: string) => {
      if (input === '/remote/state') {
        return jsonResponse({ tunnelUrl: 'https://foo.trycloudflare.com', tunnelStatus: 'open', devices: [] })
      }
      if (input === '/remote/pair/issue') return jsonResponse({ url: pairUrl })
      throw new Error(`unexpected fetch ${input}`)
    }) as typeof fetch

    render(<RemoteFooterAction {...kit} wide remote={remote} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await screen.findByTitle(pairUrl)

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(pairUrl) })
    // A refused write must not claim success, so the seat keeps its plain label.
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy() })
    expect(screen.queryByRole('button', { name: 'copied' })).toBeNull()
  })
})
