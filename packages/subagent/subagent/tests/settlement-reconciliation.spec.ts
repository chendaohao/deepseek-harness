import { describe, expect, it } from 'vitest'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { coldSettlementTerminal, settlementNoticeCovers } from '../src/settlement-reconciliation.ts'

let seq = 0
function nextSeq(): SessionSeq {
  return SessionSeq(++seq)
}

function turnStart(turn: number, time: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: nextSeq(), time, data: { turn } }
}

function turnEnd(
  turn: number,
  time: number,
  kind: 'completed' | 'aborted' | 'interrupted' | 'error' | 'max-tokens' | 'blocked',
): SessionEvent<'turn/end'> {
  const reason: TurnEndReason = kind === 'completed' || kind === 'interrupted' || kind === 'max-tokens' || kind === 'blocked'
    ? { kind }
    : kind === 'aborted'
      ? { kind, reason: { kind: 'legacy' } }
      : { kind, error: { message: 'boom', code: 'X' } }
  return { type: 'turn/end', seq: nextSeq(), time, data: { turn, reason } }
}

function assistantText(text: string, time: number): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq: nextSeq(),
    time,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      stream: [],
      message: {
        role: 'assistant',
        id: MessageId(`m-${seq}`),
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      },
    },
  }
}

function inboxInsert(time: number, text: string): SessionEvent<'agent/inbox/spliced'> {
  return {
    type: 'agent/inbox/spliced',
    seq: nextSeq(),
    time,
    data: {
      target: 'next-turn',
      start: 0,
      inserted: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
    },
  }
}

function inboxClaim(time: number): SessionEvent<'agent/inbox/spliced'> {
  return {
    type: 'agent/inbox/spliced',
    seq: nextSeq(),
    time,
    data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
  }
}

function userMessageEvent(time: number, source: MessageSource): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: nextSeq(),
    time,
    surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text: 'x' }], source }),
  }
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
  const notice = (time: number, sender: SessionId = childId) => userMessageEvent(time, {
    kind: 'subagent-settled', form: 'notice', summary: 'settled', senderSessionId: sender,
  })

  it('covers only a notice at or after the child last event', () => {
    expect(settlementNoticeCovers([notice(20)], childId, 15)).toBe(true)
    expect(settlementNoticeCovers([notice(20)], childId, 25)).toBe(false)
  })

  it('ignores notices naming a different child and other user messages', () => {
    const other = notice(30, 'child-2' as SessionId)
    const human = userMessageEvent(30, { kind: 'user' })
    expect(settlementNoticeCovers([other, human], childId, 15)).toBe(false)
  })
})
