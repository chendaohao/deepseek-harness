/**
 * The reading side of a child's epoch ending: what the parent's settlement
 * notice can say about a failure and about a cancellation.
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { epochAbortCause, epochFailure, formatFailureDetail, lastTurnBudget } from '../src/lifecycle.ts'

let seq = 0
function nextSeq(): SessionSeq {
  return SessionSeq(++seq)
}

function turnStart(turn: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: nextSeq(), time: 1, data: { turn } }
}

function stepStart(turn: number, step: number): SessionEvent<'step/start'> {
  return { type: 'step/start', seq: nextSeq(), time: 1, data: { turn, step } }
}

function turnEnd(turn: number, reason: TurnEndReason): SessionEvent<'turn/end'> {
  return { type: 'turn/end', seq: nextSeq(), time: 1, data: { turn, reason } }
}

function failedEpoch(failure: LlmFailure): SessionEvent[] {
  return [turnStart(1), stepStart(1, 1), turnEnd(1, { kind: 'error', error: failure })]
}

describe('formatFailureDetail', () => {
  it.each([
    ['no code and no status', { message: 'boom', code: 'UNKNOWN' }, 'boom'],
    ['a routing code', { message: 'boom', code: 'RATE_LIMIT' }, 'boom (RATE_LIMIT)'],
    ['an HTTP status alone', { message: 'boom', code: 'UNKNOWN', status: 503 }, 'boom (HTTP 503)'],
    ['both', { message: 'boom', code: 'SERVER', status: 503 }, 'boom (SERVER, HTTP 503)'],
  ] satisfies [string, LlmFailure, string][])('renders %s', (_label, failure, expected) => {
    expect(formatFailureDetail(failure)).toBe(expected)
  })
})

describe('epochFailure', () => {
  it('names the failure the accounting turn recorded', () => {
    expect(epochFailure(failedEpoch({ message: 'upstream queued', code: 'RATE_LIMIT', status: 429 })))
      .toBe('upstream queued (RATE_LIMIT, HTTP 429)')
  })

  it('reports nothing for a turn that did not fail', () => {
    expect(epochFailure([turnStart(1), stepStart(1, 1), turnEnd(1, { kind: 'completed' })])).toBeUndefined()
    expect(epochFailure([])).toBeUndefined()
  })

  it('ignores a failure a later clean turn superseded', () => {
    const events = [
      ...failedEpoch({ message: 'transient', code: 'TRANSPORT' }),
      turnStart(2),
      stepStart(2, 1),
      turnEnd(2, { kind: 'completed' }),
    ]

    expect(epochFailure(events)).toBeUndefined()
  })
})

describe('epochAbortCause', () => {
  it.each([
    [{ kind: 'user' }],
    [{ kind: 'parent' }],
    [{ kind: 'disposed' }],
    [{ kind: 'hook', reason: 'guard denied' }],
  ] as const)('reports the recorded %o cause', (cause) => {
    expect(epochAbortCause([turnStart(1), stepStart(1, 1), turnEnd(1, { kind: 'aborted', reason: cause })]))
      .toEqual(cause)
  })

  it('reports nothing for a turn that ended any other way', () => {
    expect(epochAbortCause([turnStart(1), stepStart(1, 1), turnEnd(1, { kind: 'completed' })])).toBeUndefined()
    expect(epochAbortCause([])).toBeUndefined()
  })
})

describe('lastTurnBudget', () => {
  it('reads the last step of the accounting turn', () => {
    const events: SessionEvent[] = [
      turnStart(1),
      stepStart(1, 1),
      {
        type: 'assistant/attempt',
        seq: nextSeq(),
        time: 2,
        data: {
          turn: 1,
          step: 1,
          stream: [
            { type: 'reasoning-chunks', time0: 0, index: 0, dt: [], texts: ['think', 'ing'] },
            { type: 'text-chunks', time0: 0, index: 1, dt: [], texts: ['visible'] },
            { type: 'tool-call-chunks', time0: 0, index: 2, dt: [], id: ToolCallId('m-call'), args: ['{}'] },
          ],
        },
      } satisfies SessionEvent<'assistant/attempt'>,
      turnEnd(1, { kind: 'max-tokens' }),
    ]

    expect(lastTurnBudget(events)).toEqual({
      turnEnd: 'max-tokens',
      toolCalls: 1,
      textChars: 7,
      largestReasoningChars: 8,
    })
  })

  it('reports nothing for an epoch that ran no turn', () => {
    expect(lastTurnBudget([])).toBeUndefined()
  })
})
