import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Keyless vision route: answers any observation with fixed evidence text. */
class VisionMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      ...(model === 'vision-model' ? { inputModalities: ['text', 'image'] as const } : {}),
    }
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = 'mock vision evidence: a red square on a white background'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 7 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'vision-mock-llm'
export const inject = ['llm']

/** Register the keyless `vision-route` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['vision-route'], new VisionMockAdapter())
}
