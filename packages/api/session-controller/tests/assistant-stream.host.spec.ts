import { describe, expect, it } from 'vitest'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionAssistantStreamAccumulator } from '../src/assistant-stream.ts'

describe('SessionAssistantStreamAccumulator', () => {
  it('replaces stale lifecycles, rejects frame gaps, and caches each baseline', () => {
    const accumulator = new SessionAssistantStreamAccumulator()
    const empty = accumulator.snapshot()
    expect(accumulator.snapshot()).toBe(empty)

    accumulator.accept({
      type: 'start', attemptId: LlmAttemptId('stale'), revision: 2, turn: 1, step: 1,
    }, -1)
    expect(accumulator.snapshot()).toEqual({ revision: 2 })

    accumulator.accept({
      type: 'start', attemptId: LlmAttemptId('current'), revision: 1, turn: 2, step: 3,
    }, SessionSeq(5))
    expect(accumulator.snapshot()).toMatchObject({
      revision: 1,
      activeAttempt: {
        attemptId: 'current', startedAfterSeq: 5, turn: 2, step: 3, nextIndex: 0, stream: [],
      },
    })

    accumulator.accept({
      type: 'chunk', attemptId: LlmAttemptId('other'), revision: 2, index: 0,
      time: 4, chunk: { type: 'text-delta', index: 0, text: 'lost' },
    }, SessionSeq(5))
    expect(accumulator.snapshot()).toEqual({ revision: 2 })

    accumulator.accept({
      type: 'start', attemptId: LlmAttemptId('settled'), revision: 3, turn: 2, step: 4,
    }, SessionSeq(8))
    accumulator.accept({
      type: 'chunk', attemptId: LlmAttemptId('settled'), revision: 4, index: 0,
      time: 5, chunk: { type: 'text-delta', index: 0, text: 'ok' },
    }, SessionSeq(8))
    const active = accumulator.snapshot()
    expect(active).toMatchObject({
      revision: 4,
      activeAttempt: {
        attemptId: 'settled', startedAfterSeq: 8, nextIndex: 1,
        stream: [{ type: 'text-chunks', time0: 5, index: 0, dt: [], texts: ['ok'] }],
      },
    })
    expect(accumulator.snapshot()).toBe(active)

    accumulator.accept({
      type: 'end', attemptId: LlmAttemptId('settled'), revision: 5, index: 1,
      outcome: { kind: 'abandoned' },
    }, SessionSeq(9))
    expect(accumulator.snapshot()).toEqual({ revision: 5 })
  })

  it('answers a reported Assistant position with metadata only when it still matches', () => {
    const accumulator = new SessionAssistantStreamAccumulator()
    const attemptId = LlmAttemptId('session:1')
    accumulator.accept({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }, SessionSeq(5))
    accumulator.accept({
      type: 'chunk', attemptId, revision: 2, index: 0,
      time: 4, chunk: { type: 'text-delta', index: 0, text: 'a' },
    }, SessionSeq(5))
    const cursor = {
      attemptId, startedAfterSeq: SessionSeq(5), revision: 2, nextIndex: 1,
    } as const

    // The caller's rows describe exactly this stream, so only the metadata is
    // owed: the prefix it would rebuild from those rows is dropped.
    const resumed = accumulator.opening(cursor, true)
    expect(resumed.outcome).toBe('resumed')
    expect(resumed.baseline).toMatchObject({
      revision: 2,
      activeAttempt: { attemptId, startedAfterSeq: 5, nextIndex: 1, stream: [] },
    })

    // A caller behind this attempt rebuilds from a complete prefix instead.
    const behind = accumulator.opening({ ...cursor, nextIndex: 0 }, true)
    expect(behind.outcome).toBe('replaced')
    expect(behind.baseline).toMatchObject({
      activeAttempt: { nextIndex: 1, stream: [{ type: 'text-chunks', texts: ['a'] }] },
    })

    // An id reused by a replacement Agent names a different stream: the
    // counter restarts with the Agent, so only the opening position separates them.
    accumulator.accept({ type: 'start', attemptId, revision: 1, turn: 2, step: 1 }, SessionSeq(9))
    expect(accumulator.opening(cursor, true).outcome).toBe('replaced')
    expect(accumulator.opening(
      { attemptId, startedAfterSeq: SessionSeq(9), revision: 1, nextIndex: 0 },
      true,
    ).outcome).toBe('resumed')

    // No reported position keeps the cursor-only answer, and an ordinary
    // opening always owes the complete prefix.
    expect(accumulator.opening(undefined, true)).toEqual({
      baseline: accumulator.metadataSnapshot(), outcome: undefined,
    })
    expect(accumulator.opening(undefined, false).baseline).toBe(accumulator.snapshot())
  })

  it('replaces an attempt it no longer holds, including one that already ended', () => {
    const accumulator = new SessionAssistantStreamAccumulator()
    const attemptId = LlmAttemptId('session:1')
    accumulator.accept({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }, SessionSeq(5))
    accumulator.accept({ type: 'chunk', attemptId, revision: 2, index: 0,
      time: 4, chunk: { type: 'text-delta', index: 0, text: 'a' } }, SessionSeq(5))
    const cursor = {
      attemptId, startedAfterSeq: SessionSeq(5), revision: 2, nextIndex: 1,
    } as const
    expect(accumulator.opening(cursor, true).outcome).toBe('resumed')

    // The attempt settled while the caller was away. Nothing is live to
    // continue, so the caller's rows must be retired rather than appended to.
    accumulator.accept({ type: 'end', attemptId, revision: 3, index: 1,
      outcome: { kind: 'abandoned' } }, SessionSeq(6))
    const ended = accumulator.opening(cursor, true)
    expect(ended.outcome).toBe('replaced')
    expect(ended.baseline).toEqual({ revision: 3 })
  })
})
