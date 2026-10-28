/**
 * Assistant continuation across a reconnect, driven through the Client stream
 * fold and the Chat Conversation assembler it feeds.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type {
  SessionAssistantStreamBaseline, SessionAssistantStreamFrame,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  SessionTransientEventEntry,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { inspectSystemPrompt } from '../../ui-conversation/src/client/contract/system-prompt.ts'
import { inspectRequestPrompt } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ClientAssistantStream } from '../../../api/session-controller/src/client/sessions/assistant-stream.ts'
import { assistantDefinition } from '../src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { unknownFallbackDefinition } from '../src/client/conversation-nodes/fallback.ts'
import { messageDefinition } from '../src/client/conversation-nodes/message.ts'
import { requestPromptDefinition, systemMessageDefinition } from '../src/client/conversation-nodes/request-prompt.ts'
import { turnTailDefinition } from '../src/client/conversation-nodes/turn-tail.ts'
import type { AssistantChatData } from '../src/client/contract/chat-nodes.ts'

const ATTEMPT = LlmAttemptId('session:1')
const DURABLE_TAIL = 3

function turnStart(): SessionEvent {
  return { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent
}

function stepStart(): SessionEvent {
  return { seq: 2, time: 2, type: 'step/start', data: { turn: 1, step: 1 } } as unknown as SessionEvent
}

function turnEnd(): SessionEvent {
  return { seq: DURABLE_TAIL, time: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } } as unknown as SessionEvent
}

function chunkFrame(index: number, text: string): SessionAssistantStreamFrame {
  return {
    type: 'chunk', attemptId: ATTEMPT, revision: index + 2, index, time: 20 + index,
    chunk: { type: 'text-delta', index: 0, text },
  }
}

const START: SessionAssistantStreamFrame = {
  type: 'start', attemptId: ATTEMPT, revision: 1, startedAfterSeq: -1, turn: 1, step: 1,
}

function assembler(): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(
    {
      entries: () => [
        messageDefinition,
        systemMessageDefinition(inspectSystemPrompt),
        requestPromptDefinition(inspectRequestPrompt),
        assistantDefinition,
        turnTailDefinition,
      ],
      fallbackEntry: () => unknownFallbackDefinition,
    },
    { entries: () => [chatViewDefinition] },
  )
  value.activateTarget('chat')
  return value
}

function assistantText(value: ConversationNodeAssembler): string {
  const current = value.snapshot('chat') as ChatSnapshot | undefined
  if (current === undefined) throw new Error('chat view was not registered')
  const parts: string[] = []
  for (const node of current.nodes.values() as Iterable<ConversationViewNode>) {
    const data = (node as { readonly data?: Partial<AssistantChatData> }).data
    for (const block of data?.blocks ?? []) {
      if (block.kind === 'text') parts.push(block.text)
    }
  }
  return parts.join('')
}

describe('assistant continuation', () => {
  it('keeps chunks captured before a reconnect distinct from the ones after it', () => {
    const fold = new ClientAssistantStream()
    const entries = [turnStart(), stepStart(), turnEnd()].map(event => ({ type: 'event' as const, event }))
    fold.replace(entries)

    // Two chunks reached the window before the carrier dropped.
    fold.acceptFrame(START)
    const captured: SessionTransientEventEntry[] = []
    for (const [index, text] of ['前0', '前1'].entries()) {
      const result = fold.acceptFrame(chunkFrame(index, text))
      if (result?.type !== 'transient') throw new Error('expected a transient chunk')
      captured.push(result.entry)
    }

    // The reconnect adopts the window the user is reading plus the Host's
    // attempt metadata, which is the continuation path's own reseed.
    const baseline: SessionAssistantStreamBaseline = {
      revision: 5,
      activeAttempt: {
        attemptId: ATTEMPT, startedAfterSeq: DURABLE_TAIL as never, turn: 1, step: 1, nextIndex: 2, stream: [],
      },
    }
    fold.replace([...entries, ...captured], baseline, false)

    const after = fold.acceptFrame(chunkFrame(2, '续'))
    if (after?.type !== 'transient') throw new Error('expected a transient chunk')
    const rows = [...captured, after.entry]

    // A presented row carries a position of its own: a seq an earlier row
    // already owns makes the assembler treat the new chunk as a repeat, and
    // the streaming reply stops growing at the reconnect.
    const seqs = rows.map(row => row.event.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect([...seqs].sort((left, right) => left - right)).toEqual(seqs)

    // The assembler drops a row whose seq an earlier one already owns, so the
    // reply has to render all three chunks and survive a rebuild over the same
    // window rather than raising on a Match presented twice.
    const window = assembler()
    window.replaceWindow([...entries, ...rows], false)
    window.flush()
    expect(assistantText(window)).toBe('前0前1续')

    expect(() => window.rebuildRegistry()).not.toThrow()
    window.flush()
    expect(assistantText(window)).toBe('前0前1续')
  })
})
