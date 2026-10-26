// @vitest-environment jsdom
/** Completion notifier: hidden-document edges, permission gate, tag reuse, and click navigation. */
import { describe, expect, it, vi } from 'vitest'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionStatusSnapshot } from '../src/client/index.ts'
import {
  browserNotifyEnvironment, installCompletionNotifier, type NotifyEnvironment,
} from '../src/client/notify.ts'

interface Harness {
  source: {
    publish(next: SessionStatusSnapshot): void
    snapshot: ObservableSnapshot<SessionStatusSnapshot>
  }
  environment: NotifyEnvironment
  notified: Array<{ title: string; body: string; tag: string }>
  opened: SessionId[]
  readonly focused: number
  dispose(): void
}

/** One notifier bench: manual status publication, recorded notification surface. */
function harness(overrides?: Partial<NotifyEnvironment>): Harness {
  const listeners = new Set<() => void>()
  let snapshot: SessionStatusSnapshot = new Map()
  const observable: ObservableSnapshot<SessionStatusSnapshot> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const notified: Array<{ title: string; body: string; tag: string }> = []
  const opened: SessionId[] = []
  let focused = 0
  const environment: NotifyEnvironment = {
    isHidden: () => true,
    permission: () => 'granted',
    requestPermission: async () => 'granted',
    notify: (title, options) => {
      notified.push({ title, body: options.body, tag: options.tag })
      options.onClick()
    },
    focus: () => { focused += 1 },
    ...overrides,
  }
  const dispose = installCompletionNotifier({
    status: observable,
    displayTitle: id => id === SessionId('s1') ? 'My session' : id,
    openSession: (id) => { opened.push(id) },
    title: 'Task finished',
    body: '{title}',
  }, environment, () => true)
  return {
    source: {
      snapshot: observable,
      publish(next) {
        snapshot = next
        for (const listener of listeners) listener()
      },
    },
    environment, notified, opened, get focused() { return focused }, dispose,
  }
}

const status = (id: SessionId, running: boolean | undefined): SessionStatusSnapshot =>
  new Map([[id, { running, pendingInteraction: undefined, completionUnread: false }]])

describe('completion notifier', () => {
  it('notifies once for a running-to-stopped edge in a hidden document', () => {
    const id = SessionId('s1')
    const h = harness()
    h.source.publish(status(id, true))
    h.source.publish(status(id, false))
    expect(h.notified).toEqual([{ title: 'Task finished', body: 'My session', tag: `dsh-session-${id}` }])
    expect(h.opened).toEqual([id])
    expect(h.focused).toBe(1)
    h.dispose()
  })

  it('stays silent for a baseline stop without an observed run', () => {
    const h = harness()
    h.source.publish(status(SessionId('s1'), false))
    expect(h.notified).toEqual([])
    h.dispose()
  })

  it('keeps the baseline current while visible and notifies the later hidden edge', () => {
    let hidden = false
    const h = harness({ isHidden: () => hidden })
    h.source.publish(status(SessionId('s1'), true))
    expect(h.notified).toEqual([])
    hidden = true
    h.source.publish(status(SessionId('s1'), false))
    expect(h.notified).toHaveLength(1)
    h.dispose()
  })

  it('stays silent without granted permission', () => {
    const h = harness({ permission: () => 'prompt' as NotificationPermission })
    h.source.publish(status(SessionId('s1'), true))
    h.source.publish(status(SessionId('s1'), false))
    expect(h.notified).toEqual([])
    h.dispose()
  })

  it('stays silent while the preference is disabled', () => {
    const listeners = new Set<() => void>()
    let snapshot: SessionStatusSnapshot = new Map()
    const observable: ObservableSnapshot<SessionStatusSnapshot> = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const dispose = installCompletionNotifier({
      status: observable,
      displayTitle: id => id,
      openSession: () => {},
      title: 't', body: '{title}',
    }, {
      isHidden: () => true,
      permission: () => 'granted',
      requestPermission: async () => 'granted',
      notify: () => { throw new Error('must not notify') },
      focus: () => {},
    }, () => false)
    snapshot = status(SessionId('s1'), true)
    for (const listener of listeners) listener()
    snapshot = status(SessionId('s1'), false)
    for (const listener of listeners) listener()
    dispose()
  })

  it('returns a no-op disposer without a notification environment', () => {
    const dispose = installCompletionNotifier({
      status: {
        getSnapshot: () => new Map(),
        subscribe: () => () => {},
      },
      displayTitle: id => id,
      openSession: () => {},
      title: 't', body: '{title}',
    }, undefined, () => true)
    expect(typeof dispose).toBe('function')
    dispose()
  })
})

describe('browser notify environment', () => {
  it('is absent without the Notification constructor', () => {
    const held = (globalThis as { Notification?: typeof Notification }).Notification
    vi.stubGlobal('Notification', undefined)
    try {
      expect(browserNotifyEnvironment()).toBeUndefined()
    } finally {
      if (held !== undefined) vi.stubGlobal('Notification', held)
      else vi.unstubAllGlobals()
    }
  })
})
