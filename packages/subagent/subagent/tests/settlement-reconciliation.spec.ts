import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session/types'
import { coldSettlementTerminal, settlementNoticeCovers } from '../src/settlement-reconciliation.ts'

let seq = 0
function event<K extends SessionEventType>(type: K, time: number, data: SessionEventMap[K]): SessionEvent<K> {
  return { type, seq: SessionSeq(++seq), time, data }
}

function turnStart(turn: number, time: number): SessionEvent<'turn/start'> {
  return event('turn/start', time, { turn })
}

function turnEnd(turn: number, time: number, kind: 'completed' | 'aborted' | 'interrupted' | 'error' | 'max-tokens' | 'blocked'): SessionEvent<'turn/end'> {
  const reason = kind === 'error'
    ? { kind, error: { message: 'boom', code: 'X' } } as const
    : { kind } as const
  return event('turn/end', time, { turn, reason })
}

function assistantText(text: string, time: number): SessionEvent<'assistant/message'> {
  return event('assistant/message', time, {
    turn: 1,
    step: 1,
    stream: [],
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
}

function inboxInsert(time: number, text: string): SessionEvent<'agent/inbox/spliced'> {
  return event('agent/inbox/spliced', time, {
    target: 'next-turn',
    start: 0,
    inserted: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
  })
}

function inboxClaim(time: number): SessionEvent<'agent/inbox/spliced'> {
  return event('agent/inbox/spliced', time, {
    target: 'next-turn',
    start: 0,
    removedCount: 1,
    inserted: [],
  })
}

describe('coldSettlementTerminal', () => {
  it('has nothing to account for an empty suffix', () => {
    expect(coldSettlementTerminal([])).toBeUndefined()
  })

  it('reads a turn open at the log end as stopped mid-turn', () => {
    const terminal = coldSettlementTerminal([turnStart(1, 10)])
    expect(terminal?.stopReason).toBe('aborted')
    expect(terminal?.output).toBeUndefined()
  })

  it('reads a child that never opened a turn as stopped before it started', () => {
    const terminal = coldSettlementTerminal([inboxInsert(5, 'queued task')])
    expect(terminal?.stopReason).toBe('aborted')
  })

  it('maps an interrupted ending to a stopped account with its visible prefix', () => {
    const terminal = coldSettlementTerminal([
      turnStart(1, 10),
      assistantText('partial answer', 11),
      turnEnd(1, 12, 'interrupted'),
    ])
    expect(terminal?.stopReason).toBe('aborted')
    expect(terminal?.output).toEqual([{ type: 'text', text: 'partial answer' }])
  })

  it('keeps a cleanly completed epoch completed', () => {
    const terminal = coldSettlementTerminal([
      turnStart(1, 10),
      assistantText('done', 11),
      turnEnd(1, 12, 'completed'),
    ])
    expect(terminal?.stopReason).toBe('completed')
    expect(terminal?.output).toEqual([{ type: 'text', text: 'done' }])
  })

  it('reads follow-up input no turn claimed as stopped work, not completion', () => {
    const terminal = coldSettlementTerminal([
      turnStart(1, 10),
      turnEnd(1, 12, 'completed'),
      inboxInsert(13, 'follow-up nobody ran'),
    ])
    expect(terminal?.stopReason).toBe('aborted')
  })

  it('does not mistake the loop own inbox claim for unrun input', () => {
    const terminal = coldSettlementTerminal([
      inboxInsert(9, 'task'),
      turnStart(1, 10),
      inboxClaim(10),
      turnEnd(1, 12, 'completed'),
    ])
    expect(terminal?.stopReason).toBe('completed')
  })

  it('maps the remaining terminal kinds without crediting success', () => {
    expect(coldSettlementTerminal([turnStart(1, 1), turnEnd(1, 2, 'max-tokens')])?.stopReason).toBe('max-tokens')
    expect(coldSettlementTerminal([turnStart(1, 1), turnEnd(1, 2, 'error')])?.stopReason).toBe('error')
    expect(coldSettlementTerminal([turnStart(1, 1), turnEnd(1, 2, 'blocked')])?.stopReason).toBe('refusal')
    expect(coldSettlementTerminal([turnStart(1, 1), turnEnd(1, 2, 'aborted')])?.stopReason).toBe('aborted')
  })
})

describe('settlementNoticeCovers', () => {
  const childId = 'child-1' as SessionId
  const notice = (time: number, sender: SessionId = childId) => event('user/message', time, createUserMessage({
    content: [{ type: 'text', text: 'Background subagent x failed before it finished.' }],
    source: { kind: 'subagent-settled', form: 'notice', summary: 'settled', senderSessionId: sender },
  }))

  it('covers only a notice at or after the child last event', () => {
    expect(settlementNoticeCovers([notice(20)], childId, 15)).toBe(true)
    expect(settlementNoticeCovers([notice(20)], childId, 25)).toBe(false)
  })

  it('ignores notices naming a different child and other user messages', () => {
    const other = notice(30, 'child-2' as SessionId)
    const human = event('user/message', 30, createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }))
    expect(settlementNoticeCovers([other, human], childId, 15)).toBe(false)
  })
})
