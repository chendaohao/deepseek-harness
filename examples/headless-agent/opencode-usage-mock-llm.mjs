/**
 * Keyless headless-agent adapter for the opencode-usage snapshot scenario:
 * one scripted opencode_usage tool call, then a deterministic final answer
 * derived from the tool result (queriedAt is never echoed, keeping the
 * transcript stable across runs).
 */

import { CallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const OFF = ReasoningEffortId('off')

class OpencodeUsageMockAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: OFF, name: 'Off' }],
        defaultEffort: OFF,
      },
    }
  }

  async * stream(options) {
    const toolResult = options.messages.at(-1)?.content.find((block) => block.type === 'tool-result')
    if (toolResult === undefined) {
      const args = '{}'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('snapshot-usage-call'), name: 'opencode_usage', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('snapshot-usage-call'), name: 'opencode_usage', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const toolText = toolResult.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    const used = (label) => {
      const match = toolText.match(new RegExp(label + ': (\\d+)% used'))
      return match === null ? '?' : match[1]
    }
    const reply = `OPENCODE_USAGE_OK rolling=${used('5h rolling')} weekly=${used('Weekly')} monthly=${used('Monthly')}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 6, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'opencode-usage-mock-llm'
export const inject = ['llm']

/** Register the keyless `cli-mock-usage` adapter. */
export function apply(ctx) {
  ctx.llm.registerAdapter(['cli-mock-usage'], new OpencodeUsageMockAdapter())
}
