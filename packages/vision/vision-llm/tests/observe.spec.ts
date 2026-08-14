import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  adapterResolveCount = 0
})
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { VisionError } from '@deepseek-ai/dsh-vision'
import { DEFAULT_OBSERVE_PROMPT, apply } from '../src/index.ts'

const REF: ImageAttachmentRef = {
  attachmentId: AttachmentId('vision-test:1'),
  mediaType: 'image/png',
  bytes: 4,
  width: 1,
  height: 1,
}

/** Exact-route fake adapter; behavior is scripted per test. */
let adapterResolveCount = 0
class FakeAdapter extends LlmAdapter {
  constructor(
    private readonly models: LlmModelInfo[],
    private readonly behavior: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
  ) {
    super()
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    adapterResolveCount += 1
    const found = this.models.find(candidate => candidate.id === model)
    return Promise.resolve({
      provider: 'vision-route',
      id: model,
      name: found?.name ?? model,
      ...(found?.inputModalities === undefined ? {} : { inputModalities: [...found.inputModalities] }),
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.behavior(options)
  }
}

function streamText(...texts: string[]): AsyncIterable<StreamChunk> {
  return (async function* () {
    for (const text of texts) {
      yield { type: 'text-delta', index: 0, text }
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 7 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

async function mount(
  behavior: AsyncIterable<StreamChunk> | ((options: GenerateOptions) => AsyncIterable<StreamChunk>),
  models?: LlmModelInfo[],
) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const run = typeof behavior === 'function' ? behavior : () => behavior
  ctx.llm.registerAdapter(['vision-route'], new FakeAdapter(models ?? [
    { provider: 'vision-route', id: 'vision-model', name: 'Vision', inputModalities: ['text', 'image'] },
    { provider: 'vision-route', id: 'text-model', name: 'Text', inputModalities: ['text'] },
  ], run))
  return ctx
}

describe('vision-llm apply', () => {
  it('registers ctx.vision for an image-capable route', async () => {
    const ctx = await mount(streamText('a red square'))
    apply(ctx, { provider: 'vision-route', model: 'vision-model', prompt: DEFAULT_OBSERVE_PROMPT, maxImagesPerRequest: 2 })
    expect(ctx.vision).toBeDefined()
    expect(ctx.get('vision')).toBeDefined()
  })

  it('fails loud at first observation when the route does not resolve', async () => {
    const ctx = await mount(streamText('x'))
    apply(ctx, { provider: 'missing-route', model: 'ghost-model', prompt: DEFAULT_OBSERVE_PROMPT, maxImagesPerRequest: 2 })
    await expect(ctx.vision.observe({ attachments: [REF] }))
      .rejects.toThrow(/cannot resolve vision route/)
  })

  it('fails loud at first observation when the model declares no image input', async () => {
    const ctx = await mount(streamText('x'))
    apply(ctx, { provider: 'vision-route', model: 'text-model', prompt: DEFAULT_OBSERVE_PROMPT, maxImagesPerRequest: 2 })
    const error = await ctx.vision.observe({ attachments: [REF] })
      .then(() => null, (error: unknown) => error)
    expect(error).toBeInstanceOf(VisionError)
    expect((error as VisionError).code).toBe('VISION_UNCONFIGURED')
  })
})

describe('VisionLlmProvider.observe', () => {
  it('streams evidence from the configured route with the image attachment', async () => {
    let seen: GenerateOptions | undefined
    const ctx = await mount((options) => {
      seen = options
      return streamText('a red square ', 'on a white background')
    })
    apply(ctx, { provider: 'vision-route', model: 'vision-model', prompt: DEFAULT_OBSERVE_PROMPT, maxImagesPerRequest: 2 })
    const observation = await ctx.vision.observe({ attachments: [REF], question: 'what is this?' })
    expect(observation.evidence).toBe('a red square on a white background')
    expect(observation.usage).toEqual({ inputTokens: 10, outputTokens: 7 })
    expect(seen!.provider).toBe('vision-route')
    expect(seen!.model).toBe('vision-model')
    expect(seen!.system).toBe(DEFAULT_OBSERVE_PROMPT)
    expect(seen!.messages[0]!.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', attachment: REF },
    ])
    expect(seen!.messages[0]!.source).toEqual({ kind: 'plugin', plugin: 'vision-llm' })
  })

  it('rejects an empty request', async () => {
    const ctx = await mount(streamText('x'))
    apply(ctx, { provider: 'vision-route', model: 'vision-model', prompt: DEFAULT_OBSERVE_PROMPT, maxImagesPerRequest: 2 })
    await expect(ctx.vision.observe({ attachments: [] }))
      .rejects.toMatchObject({ code: 'VISION_EMPTY_REQUEST' })
  })

  it('rejects more images than the configured cap', async () => {
    const ctx = await mount(streamText('x'))
    apply(ctx, { provider: 'vision-route', model: 'vision-model', prompt: DEFAULT_OBSERVE_PROMPT, maxImagesPerRequest: 1 })
    await expect(ctx.vision.observe({ attachments: [REF, REF] }))
      .rejects.toMatchObject({ code: 'VISION_TOO_MANY_IMAGES' })
  })

  it('propagates a provider error finish as LlmError', async () => {
    const ctx = await mount(async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'UPSTREAM' } } }
    })
    apply(ctx, { provider: 'vision-route', model: 'vision-model', prompt: DEFAULT_OBSERVE_PROMPT, maxImagesPerRequest: 2 })
    await expect(ctx.vision.observe({ attachments: [REF] }))
      .rejects.toMatchObject({ code: 'UPSTREAM', message: 'provider exploded' })
  })

  it('wraps a non-LLM stream failure as VISION_OBSERVE_FAILED', async () => {
    const ctx = await mount(streamText('x'))
    ctx.on('llm/stream', () => {
      throw new Error('wire broke')
    })
    apply(ctx, { provider: 'vision-route', model: 'vision-model', prompt: DEFAULT_OBSERVE_PROMPT, maxImagesPerRequest: 2 })
    await expect(ctx.vision.observe({ attachments: [REF] }))
      .rejects.toMatchObject({ code: 'VISION_OBSERVE_FAILED' })
  })

  it('rejects an empty evidence stream', async () => {
    const ctx = await mount(async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    apply(ctx, { provider: 'vision-route', model: 'vision-model', prompt: DEFAULT_OBSERVE_PROMPT, maxImagesPerRequest: 2 })
    await expect(ctx.vision.observe({ attachments: [REF] }))
      .rejects.toMatchObject({ code: 'VISION_OBSERVE_FAILED' })
  })

  it('propagates the caller signal as an abort', async () => {
    const controller = new AbortController()
    const ctx = await mount(async function* () {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled', code: 'ABORTED' } } }
    })
    apply(ctx, { provider: 'vision-route', model: 'vision-model', prompt: DEFAULT_OBSERVE_PROMPT, maxImagesPerRequest: 2 })
    controller.abort(new Error('cancelled by caller'))
    await expect(ctx.vision.observe({ attachments: [REF] }, controller.signal))
      .rejects.toThrow('cancelled by caller')
  })

  it('validates the route only once', async () => {
    const ctx = await mount(() => streamText('evidence'))
    apply(ctx, { provider: 'vision-route', model: 'vision-model', prompt: DEFAULT_OBSERVE_PROMPT, maxImagesPerRequest: 2 })
    // The gate is the only public resolveModelInfo consumer; two observations
    // resolving exactly once prove the route cache.
    const resolve = vi.spyOn(ctx.llm, 'resolveModelInfo')
    await ctx.vision.observe({ attachments: [REF] })
    await ctx.vision.observe({ attachments: [REF] })
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('propagates a pre-aborted signal before any provider work', async () => {
    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    const ctx = await mount(streamText('x'))
    apply(ctx, { provider: 'vision-route', model: 'vision-model', prompt: DEFAULT_OBSERVE_PROMPT, maxImagesPerRequest: 2 })
    await expect(ctx.vision.observe({ attachments: [REF] }, controller.signal))
      .rejects.toThrow('already cancelled')
  })
})
