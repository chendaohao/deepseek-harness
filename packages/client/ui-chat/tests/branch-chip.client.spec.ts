// @vitest-environment jsdom
/** The run chip's branch reads and the route's wire form: one request,
 * drop on connection replacement, cancellation on disposal. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { chatBranchUrl, CHAT_BRANCH_PATH, CHAT_BRANCH_ROUTE, isChatBranch } from '../src/branch.ts'
import { BranchChipStore } from '../src/client/chat/branch-chip.ts'

const SID = SessionId('s1')

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('branch route wire form', () => {
  it('serves from the authenticated api channel and addresses one Session', () => {
    expect(CHAT_BRANCH_PATH).toBe('/api/chat.branch')
    expect(CHAT_BRANCH_ROUTE).toBe(CHAT_BRANCH_PATH.slice(1))
    expect(chatBranchUrl(SID)).toBe('api/chat.branch?sessionId=s1')
  })

  it('accepts only a branch name or an explicit null', () => {
    expect(isChatBranch({ branch: 'master' })).toBe(true)
    expect(isChatBranch({ branch: null })).toBe(true)
    expect(isChatBranch({ branch: '' })).toBe(false)
    expect(isChatBranch({ branch: 42 })).toBe(false)
    expect(isChatBranch({})).toBe(false)
    expect(isChatBranch(null)).toBe(false)
    expect(isChatBranch('master')).toBe(false)
  })
})

describe('BranchChipStore', () => {
  it('publishes loading, then the served branch', async () => {
    const store = new BranchChipStore()
    let settle: (value: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { settle = resolve })))
    const reading = store.load(SID)
    expect(store.state.getSnapshot()['s1']).toBe('loading')
    settle(Response.json({ branch: 'master' }))
    await reading
    expect(store.state.getSnapshot()['s1']).toEqual({ branch: 'master' })
    await store.dispose()
  })

  it('reports no chip for a null branch, an invalid answer, a refusal, or a transport failure', async () => {
    const cases: Array<[() => Response | Error, string]> = [
      [() => Response.json({ branch: null }), 'null branch'],
      [() => Response.json({ branch: 7 }), 'invalid answer'],
      [() => new Response('nope', { status: 500 }), 'refusal'],
      [() => new Error('offline'), 'transport failure'],
    ]
    for (const [respond, label] of cases) {
      const store = new BranchChipStore()
      vi.stubGlobal('fetch', vi.fn(async () => {
        const answer = respond()
        if (answer instanceof Error) throw answer
        return answer
      }))
      await store.load(SID)
      const state = store.state.getSnapshot()['s1']
      if (label === 'null branch') expect(state).toEqual({ branch: null })
      else expect(state).toBe('missing')
      await store.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('reads again on a later run rather than reusing a standing answer', async () => {
    const store = new BranchChipStore()
    const fetch = vi.fn(async () => Response.json({ branch: 'master' }))
    vi.stubGlobal('fetch', fetch)
    await store.load(SID)
    await store.load(SID)
    expect(fetch).toHaveBeenCalledTimes(2)
    await store.dispose()
  })

  it('drops answers and abandons in-flight reads on connection replacement', async () => {
    const store = new BranchChipStore()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ branch: 'master' })))
    await store.load(SID)
    expect(store.state.getSnapshot()['s1']).toEqual({ branch: 'master' })
    let settle: (value: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { settle = resolve })))
    const stale = store.load(SID)
    store.reset()
    expect(store.state.getSnapshot()).toEqual({})
    settle(Response.json({ branch: 'stale' }))
    await stale
    expect(store.state.getSnapshot()).toEqual({})
    await store.dispose()
  })

  it('never publishes after disposal', async () => {
    let settle: (value: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { settle = resolve })))
    const store = new BranchChipStore()
    const reading = store.load(SID)
    const closing = store.dispose()
    settle(Response.json({ branch: 'master' }))
    await Promise.all([reading, closing])
    expect(store.state.getSnapshot()).toEqual({})
    await store.load(SID)
    expect(store.state.getSnapshot()).toEqual({})
  })
})
