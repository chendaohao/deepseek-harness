import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, LlmRuntime, createAssistantMessage, createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { VisionService } from '@deepseek-ai/dsh-vision'
import type { VisionObserveRequest, VisionObservation } from '@deepseek-ai/dsh-vision'
import { apply, batchKey, evidenceBlockFor } from '../src/index.ts'

const REF_A: ImageAttachmentRef = {
  attachmentId: AttachmentId('bridge-test:a'),
  mediaType: 'image/png',
  bytes: 4,
  width: 1,
  height: 1,
}
const REF_B: ImageAttachmentRef = {
  attachmentId: AttachmentId('bridge-test:b'),
  mediaType: 'image/png',
  bytes: 4,
  width: 1,
  height: 1,
}

/** Records the requests it receives and streams scripted text. */
class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  override resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider: _provider,
      id: model,
      name: model,
      ...(model === 'vision-model' ? { inputModalities: ['text', 'image'] as const } : {}),
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: 'answer' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

/** Fake vision service recording observation requests. */
class FakeVision extends VisionService {
  readonly requests: VisionObserveRequest[] = []
  readonly visionRoute = Object.freeze({ provider: 'vision-route', model: 'vision-model' })
  readonly maxImagesPerRequest: number
  constructor(ctx: Context, maxImagesPerRequest = 4) {
    super(ctx)
    this.maxImagesPerRequest = maxImagesPerRequest
  }

  async observe(request: VisionObserveRequest, signal?: AbortSignal): Promise<VisionObservation> {
    signal?.throwIfAborted()
    this.requests.push(request)
    return { evidence: `evidence-for-${request.attachments.length}`, usage: { inputTokens: 1, outputTokens: 2 } }
  }
}

async function setup(maxImagesPerRequest = 4) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const textAdapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['text-route'], textAdapter)
  const visionAdapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['vision-route'], visionAdapter)
  await ctx.plugin(SessionStore)
  // Constructing the FakeVision service registers `ctx.vision` on the fiber.
  const vision = new FakeVision(ctx, maxImagesPerRequest)
  const bridgeFiber = await ctx.plugin({ name: 'vision-bridge', inject: ['llm', 'sessions', 'vision'], apply })
  const session = ctx.sessions.create(SessionId('bridge-session'), { meta: { cwd: '/' } })
  return { ctx, textAdapter, visionAdapter, vision, session, bridgeFiber }
}

function loopRequest(provider: string, model: string, messages: GenerateOptions['messages'], sessionId: string) {
  return markAgentLoopRequest({ provider, model, messages, sessionId } as GenerateOptions)
}

async function collect(ctx: Context, request: GenerateOptions): Promise<string> {
  let text = ''
  for await (const chunk of ctx.llm.stream(request)) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

describe('evidenceBlockFor and batchKey', () => {
  it('builds a stable batch key from message and attachment ids', () => {
    expect(batchKey('m1', [REF_A, REF_B])).toBe('m1|bridge-test:a+bridge-test:b')
  })

  it('renders the evidence envelope with the attachment ids', () => {
    const block = evidenceBlockFor('m1', [REF_A], 'a red square')
    expect(block).toEqual({
      type: 'text',
      text: '<vision-evidence message-id="m1" attachment-ids="bridge-test:a">\n<content>\na red square\n</content>',
    })
  })
})

describe('vision-bridge conversion', () => {
  it('converts image content to evidence on a text-only route', async () => {
    const { ctx, textAdapter, vision, session } = await setup()
    const message = createUserMessage({
      content: [{ type: 'text', text: 'what is this?' }, { type: 'image', attachment: REF_A }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const answer = await collect(ctx, loopRequest('text-route', 'deepseek-chat', [message], session.id))

    expect(answer).toBe('answer')
    expect(textAdapter.requests).toHaveLength(1)
    const sent = textAdapter.requests[0]!
    expect(sent.messages[0]!.content).toEqual([
      { type: 'text', text: 'what is this?' },
      evidenceBlockFor(message.id, [REF_A], 'evidence-for-1'),
    ])
    expect(sent.messages[0]!.content.some(block => block.type === 'image')).toBe(false)

    // The observation was recorded durably beside the request.
    const observed = session.events.filter(event => event.type === 'vision/observed')
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({
      ignorable: true,
      data: {
        messageId: message.id,
        attachments: [REF_A],
        evidence: 'evidence-for-1',
        vision: { provider: 'vision-route', model: 'vision-model' },
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    })

    // The question carried the message's text.
    expect(vision.requests[0]!.question).toBe('what is this?')
    expect(vision.requests[0]!.attachments).toEqual([REF_A])
  })

  it('passes images natively on a vision-capable route', async () => {
    const { ctx, visionAdapter, vision, session } = await setup()
    const message = createUserMessage({
      content: [{ type: 'image', attachment: REF_A }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    await collect(ctx, loopRequest('vision-route', 'vision-model', [message], session.id))
    expect(visionAdapter.requests[0]!.messages[0]!.content).toEqual([{ type: 'image', attachment: REF_A }])
    expect(vision.requests).toHaveLength(0)
  })

  it('passes messages without images untouched', async () => {
    const { ctx, textAdapter, vision, session } = await setup()
    const message = createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    await collect(ctx, loopRequest('text-route', 'deepseek-chat', [message], session.id))
    expect(textAdapter.requests[0]!.messages[0]!.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(vision.requests).toHaveLength(0)
  })

  it('passes non-agent-loop requests untouched', async () => {
    const { ctx, textAdapter, vision } = await setup()
    const message = createUserMessage({
      content: [{ type: 'image', attachment: REF_A }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const request = { provider: 'text-route', model: 'deepseek-chat', messages: [message] } as GenerateOptions
    await collect(ctx, request)
    expect(textAdapter.requests[0]!.messages[0]!.content).toEqual([{ type: 'image', attachment: REF_A }])
    expect(vision.requests).toHaveLength(0)
  })

  it('reuses cached evidence instead of re-observing', async () => {
    const { ctx, vision, session } = await setup()
    const message = createUserMessage({
      content: [{ type: 'image', attachment: REF_A }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    await collect(ctx, loopRequest('text-route', 'deepseek-chat', [message], session.id))
    await collect(ctx, loopRequest('text-route', 'deepseek-chat', [message], session.id))
    expect(vision.requests).toHaveLength(1)
    expect(session.events.filter(event => event.type === 'vision/observed')).toHaveLength(1)
  })

  it('reuses evidence recorded before the request (restart recovery)', async () => {
    const { ctx, vision, session } = await setup()
    const message = createUserMessage({
      content: [{ type: 'image', attachment: REF_A }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    session.append('vision/observed', {
      messageId: message.id,
      attachments: [REF_A],
      evidence: 'recorded-evidence',
      vision: { provider: 'vision-route', model: 'vision-model' },
    }, { ignorable: true })
    await collect(ctx, loopRequest('text-route', 'deepseek-chat', [message], session.id))
    expect(vision.requests).toHaveLength(0)
  })

  it("splits a message's images into batches by the observer cap", async () => {
    const { ctx, vision, session } = await setup(1)
    const message = createUserMessage({
      content: [{ type: 'image', attachment: REF_A }, { type: 'image', attachment: REF_B }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const answer = await collect(ctx, loopRequest('text-route', 'deepseek-chat', [message], session.id))
    expect(answer).toBe('answer')
    expect(vision.requests).toHaveLength(2)
    expect(vision.requests[0]!.attachments).toEqual([REF_A])
    expect(vision.requests[1]!.attachments).toEqual([REF_B])
    const observed = session.events.filter(event => event.type === 'vision/observed')
    expect(observed).toHaveLength(2)
  })

  it('surfaces an observation failure as a request error', async () => {
    const { ctx, vision, session } = await setup()
    vision.observe = () => Promise.reject(new Error('vision provider down'))
    const message = createUserMessage({
      content: [{ type: 'image', attachment: REF_A }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    await expect(collect(ctx, loopRequest('text-route', 'deepseek-chat', [message], session.id)))
      .rejects.toThrow('vision provider down')
  })

  it('ignores vision/observed events without a message id', async () => {
    const { ctx, session, vision } = await setup()
    session.append('vision/observed', {
      attachments: [REF_A],
      evidence: 'orphan evidence',
      vision: { provider: 'vision-route', model: 'vision-model' },
    }, { ignorable: true })
    const message = createUserMessage({
      content: [{ type: 'image', attachment: REF_A }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    // No messageId in the record, so no cache entry: the request re-observes.
    await collect(ctx, loopRequest('text-route', 'deepseek-chat', [message], session.id))
    expect(vision.requests).toHaveLength(1)
  })

  it('passes a loop request without a session id untouched', async () => {
    const { ctx, textAdapter, vision } = await setup()
    const message = createUserMessage({
      content: [{ type: 'image', attachment: REF_A }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const request = markAgentLoopRequest({ provider: 'text-route', model: 'deepseek-chat', messages: [message] })
    await collect(ctx, request)
    expect(textAdapter.requests[0]!.messages[0]!.content).toEqual([{ type: 'image', attachment: REF_A }])
    expect(vision.requests).toHaveLength(0)
  })

  it('passes a loop request for an unknown session untouched', async () => {
    const { ctx, textAdapter, vision } = await setup()
    const message = createUserMessage({
      content: [{ type: 'image', attachment: REF_A }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    await collect(ctx, loopRequest('text-route', 'deepseek-chat', [message], 'no-such-session'))
    expect(textAdapter.requests[0]!.messages[0]!.content).toEqual([{ type: 'image', attachment: REF_A }])
    expect(vision.requests).toHaveLength(0)
  })

  it('records no usage when the observer reports none', async () => {
    const { ctx, vision, session } = await setup()
    vision.observe = async request => ({ evidence: `evidence-for-${request.attachments.length}` })
    const message = createUserMessage({
      content: [{ type: 'image', attachment: REF_A }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    await collect(ctx, loopRequest('text-route', 'deepseek-chat', [message], session.id))
    const observed = session.events.find(event => event.type === 'vision/observed')
    expect(observed?.type === 'vision/observed' ? observed.data.usage : 'missing').toBeUndefined()
  })

  it('skips non-user and image-less messages when collecting images', async () => {
    const { ctx, vision, session } = await setup()
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: 'assistant reply' }],
      source: { provider: 'text-route', model: 'deepseek-chat' },
    })
    const plain = createUserMessage({
      content: [{ type: 'text', text: 'no images here' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const message = createUserMessage({
      content: [{ type: 'image', attachment: REF_A }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const request = markAgentLoopRequest({
      provider: 'text-route',
      model: 'deepseek-chat',
      messages: [assistant, plain, message],
      sessionId: session.id,
    })
    await collect(ctx, request)
    expect(vision.requests).toHaveLength(1)
  })

  it('converts multiple images in one batch to a single evidence block', async () => {
    const { ctx, vision, session } = await setup(2)
    const message = createUserMessage({
      content: [{ type: 'image', attachment: REF_A }, { type: 'image', attachment: REF_B }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    await collect(ctx, loopRequest('text-route', 'deepseek-chat', [message], session.id))
    expect(vision.requests).toHaveLength(1)
    const observed = session.events.filter(event => event.type === 'vision/observed')
    expect(observed).toHaveLength(1)
  })

  it('unregisters the bridge when disposed', async () => {
    const { ctx, textAdapter, vision, session, bridgeFiber } = await setup()
    const message = createUserMessage({
      content: [{ type: 'image', attachment: REF_A }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    await collect(ctx, loopRequest('text-route', 'deepseek-chat', [message], session.id))
    expect(vision.requests).toHaveLength(1)
    await bridgeFiber.dispose()
    await collect(ctx, loopRequest('text-route', 'deepseek-chat', [message], session.id))
    // After disposal the image passes through untouched and no new observation runs.
    expect(vision.requests).toHaveLength(1)
    expect(textAdapter.requests[1]!.messages[0]!.content).toEqual([{ type: 'image', attachment: REF_A }])
  })
})
