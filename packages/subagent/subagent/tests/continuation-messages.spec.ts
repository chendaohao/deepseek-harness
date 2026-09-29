import { describe, expect, it } from 'vitest'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSettlementMessage } from '../src/continuation-messages.ts'

const childId = SessionId('settled-child')
const summary = { type: 'text', text: `Background subagent ${childId} finished and will do no further work unless you send it more.` }
const reasoning: ContentBlock = { type: 'reasoning', text: 'private child reasoning' }
const toolCall: ContentBlock = { type: 'tool-call', id: ToolCallId('child-call'), name: 'read', arguments: '{}' }

describe('continuable settlement content', () => {
  it.each([
    ['reasoning before the answer', [reasoning, { type: 'text', text: 'answer' }]],
    ['a tool call after the answer', [{ type: 'text', text: 'answer' }, toolCall]],
  ] satisfies [string, ContentBlock[]][])('reports only the closing text with %s', (_label, output) => {
    const original = structuredClone(output)
    const message = createSettlementMessage(childId, { stopReason: 'completed', output })

    expect(message.role).toBe('user')
    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'answer' },
    ])
    expect(output).toEqual(original)
  })

  it.each([
    ['absent output', undefined],
    ['empty output', []],
    ['reasoning-only output', [reasoning]],
    ['empty text', [{ type: 'text', text: '' }]],
  ] satisfies [string, ContentBlock[] | undefined][])('reports no closing message for %s', (_label, output) => {
    const message = createSettlementMessage(childId, { stopReason: 'completed', ...output === undefined ? {} : { output } })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'It left no closing message.' },
    ])
  })

  it('names the spent output budget when the last turn committed nothing visible', () => {
    const message = createSettlementMessage(childId, {
      stopReason: 'max-tokens',
      budget: { turnEnd: 'max-tokens', toolCalls: 0, textChars: 0, largestReasoningChars: 122_686 },
    })

    expect(message.content).toEqual([
      { type: 'text', text: `Background subagent ${childId} hit its output token limit before it finished.` },
      { type: 'text', text: 'It left no closing message.' },
      {
        type: 'text',
        text: 'It ended turn max-tokens with 122,686 characters of reasoning in one block and no visible output; '
          + 'the constraint that stopped it was output budget, not the size of the task.',
      },
    ])
  })

  it.each([
    ['visible text', { turnEnd: 'max-tokens', toolCalls: 0, textChars: 40, largestReasoningChars: 900 }],
    ['a tool call', { turnEnd: 'max-tokens', toolCalls: 1, textChars: 0, largestReasoningChars: 900 }],
  ])('omits the budget diagnosis when the last turn emitted %s', (_label, budget) => {
    const message = createSettlementMessage(childId, { stopReason: 'max-tokens', budget })

    expect(message.content).toEqual([
      { type: 'text', text: `Background subagent ${childId} hit its output token limit before it finished.` },
      { type: 'text', text: 'It left no closing message.' },
    ])
  })

  it('names the ceiling without a recorded reasoning block', () => {
    const message = createSettlementMessage(childId, {
      stopReason: 'max-tokens',
      budget: { turnEnd: 'max-tokens', toolCalls: 0, textChars: 0, largestReasoningChars: 0 },
    })

    expect(message.content.at(-1)).toEqual({
      type: 'text',
      text: 'It ended turn max-tokens with no visible output; the constraint that stopped it was output budget, not the size of the task.',
    })
  })

  it.each(['aborted', 'error', 'blocked', 'completed'])(
    'omits the budget diagnosis for a %s turn, which did not run out of output',
    (turnEnd) => {
      const message = createSettlementMessage(childId, {
        stopReason: 'aborted',
        budget: { turnEnd, toolCalls: 0, textChars: 0, largestReasoningChars: 90_000 },
      })

      expect(message.content).toEqual([
        { type: 'text', text: `Background subagent ${childId} was stopped before it finished.` },
        { type: 'text', text: 'It left no closing message.' },
      ])
    },
  )

  it('preserves text block order and bytes around omitted reasoning and tool calls', () => {
    const first: ContentBlock = { type: 'text', text: '  first\n' }
    const second: ContentBlock = { type: 'text', text: '\n第二段  ' }
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [reasoning, first, toolCall, second],
    })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      first,
      second,
    ])
  })
})
