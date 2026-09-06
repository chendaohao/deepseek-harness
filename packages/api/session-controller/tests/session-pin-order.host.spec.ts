/**
 * Session list pin ordering: the host list sorts pinned rows first (newest
 * pin first) and exposes the pinned/pinAt fields from the projection cache;
 * unpinned rows keep the recency order. Composed through the real
 * ApiSessionList with a stubbed projection cache carrying the pinned block.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  createSessionTestRemote,
  installSessionReadTestServices,
  testSessionPersistence,
} from './test-remote.ts'

const sid = (id: string): Session['id'] => id as Session['id']

function header(id: string, createdAt: number): SessionHeader {
  return { version: 2, id: sid(id), createdAt, cwd: '/proj', isSeeded: false }
}

function request<P>(payload: P): P {
  return payload
}

function providePersistence(ctx: Context, persistence: Record<string, unknown>): () => void {
  return ctx.provide('sessionPersistence', testSessionPersistence(ctx, persistence) as never)
}

describe('session list pin ordering', () => {
  it('sorts pinned rows first by pin time, then unpinned rows by recency', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    const metas = [
      header('older-pinned', 100),
      header('newer-pinned', 200),
      header('recent-unpinned', 900),
      header('old-unpinned', 300),
    ]
    providePersistence(ctx, {
      list: () => Promise.resolve(metas),
      locate: () => ({ kind: 'jsonl', path: '/not-read' }),
    })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: (meta: SessionHeader) => {
        if (meta.id === sid('older-pinned')) {
          return {
            asOfSeq: 1,
            values: {
              sessionListMetadata: { blank: false, lastPromptAt: 150 },
              pinned: { pinned: true, pinAt: 150 },
            },
          }
        }
        if (meta.id === sid('newer-pinned')) {
          return {
            asOfSeq: 1,
            values: {
              sessionListMetadata: { blank: false, lastPromptAt: 250 },
              pinned: { pinned: true, pinAt: 250 },
            },
          }
        }
        if (meta.id === sid('recent-unpinned')) {
          return {
            asOfSeq: 0,
            values: { sessionListMetadata: { blank: false, lastPromptAt: 900 } },
          }
        }
        if (meta.id === sid('old-unpinned')) {
          return {
            asOfSeq: 0,
            values: { sessionListMetadata: { blank: false, lastPromptAt: 300 } },
          }
        }
        return undefined
      },
    } as never)
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
    })

    const response = await remote.list(request({}))
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error('unreachable')
    expect(response.value.items.map(item => item.sessionId)).toEqual([
      'newer-pinned',
      'older-pinned',
      'recent-unpinned',
      'old-unpinned',
    ])
    expect(response.value.items[0]).toMatchObject({ pinned: true, pinAt: 250 })
    expect(response.value.items[1]).toMatchObject({ pinned: true, pinAt: 150 })
    expect(response.value.items[2]).not.toHaveProperty('pinned')
    expect(response.value.items[2]).not.toHaveProperty('pinAt')
  })
})
