import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { AttachmentError, AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { VisionService } from '@deepseek-ai/dsh-vision'
import type { VisionObserveRequest, VisionObservation } from '@deepseek-ai/dsh-vision'
import { apply, applyVisionObserveTool, formatVisionObserveOutput } from '../src/index.ts'

/** 1x1 red PNG (valid signature, IHDR, IDAT). */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

const testToolSignal = new AbortController().signal

/** Fake vision service recording observation requests. */
class FakeVision extends VisionService {
  readonly requests: VisionObserveRequest[] = []
  readonly visionRoute = Object.freeze({ provider: 'vision-route', model: 'vision-model' })
  readonly maxImagesPerRequest = 4
  constructor(ctx: Context, private readonly evidence = 'a red square') {
    super(ctx)
  }

  async observe(request: VisionObserveRequest, signal?: AbortSignal): Promise<VisionObservation> {
    signal?.throwIfAborted()
    this.requests.push(request)
    return { evidence: this.evidence, usage: { inputTokens: 3, outputTokens: 4 } }
  }
}

/** Attachment store with scripted save failures for the propagation arms. */
class PngOnlyStore extends AttachmentStore {
  readonly imageLimits = {
    maxImageBytes: 1000,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 1000,
    maxImagePixels: 1000,
    mediaTypes: ['image/png'] as const,
  }

  /** Scripted save failure; a success value bypasses it. */
  saveError: unknown = new AttachmentError('disk full', 'STORAGE')
  /** When set, saveImage succeeds with this reference instead of failing. */
  saveResult: ImageAttachmentRef | undefined

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.reject(new Error('PngOnlyStore: validation unreachable in this test'))
  }

  async saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    if (this.saveResult !== undefined) return this.saveResult
    throw this.saveError
  }

  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return Promise.reject(new Error('PngOnlyStore: read unreachable in this test'))
  }
}

let dir: string
let home: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-vision-tool-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-vision-tool-home-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

interface SetupOptions {
  attachments?: boolean
  visionEvidence?: string
}

async function setup(options: SetupOptions = {}): Promise<{ ctx: Context; vision: FakeVision }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  if (options.attachments !== false) {
    await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  }
  // Constructing the FakeVision service registers `ctx.vision` on the fiber.
  const vision = new FakeVision(ctx, options.visionEvidence)
  await ctx.plugin({ name: 'tool-vision', inject: ['tools', 'fs', 'vision', 'attachments'], apply })
  return { ctx, vision }
}

/** Context with the PNG-only store and the tool registered. */
async function pngOnlyContext() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  new PngOnlyStore(ctx)
  new FakeVision(ctx)
  await ctx.plugin({ name: 'tool-vision', inject: ['tools', 'fs', 'vision', 'attachments'], apply })
  return ctx
}

/** A fake calling agent pinned to one session workspace. */
function agentOn(): object {
  return {
    options: {},
    session: {
      header: { cwd: dir },
      requestHeader: () => undefined,
    },
  }
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, agent?: object) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`vision-call-${++callCounter}`),
    name,
    arguments: args,
    ...agent ? { agent: agent as never } : {},
  })
}

function observe(ctx: Context, args: unknown, agent?: object) {
  return call(ctx, 'vision_observe', args, agent)
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('vision_observe registration', () => {
  it('registers while a durable attachment store is mounted', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.schemas().some(tool => tool.name === 'vision_observe')).toBe(true)
  })

  it('does not register without an attachment store', async () => {
    const { ctx } = await setup({ attachments: false })
    expect(ctx.tools.schemas().some(tool => tool.name === 'vision_observe')).toBe(false)
  })
})

describe('vision_observe happy path', () => {
  it('observes the committed bytes and renders the evidence envelope', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const { ctx, vision } = await setup()
    const result = await observe(ctx, { file_path: 'red.png', question: 'what color?' }, agentOn())

    expect(result.isError).toBe(false)
    expect(vision.requests).toHaveLength(1)
    const request = vision.requests[0]!
    expect(request.question).toBe('what color?')
    expect(request.attachments).toHaveLength(1)
    const ref = request.attachments[0]!
    expect(ref.mediaType).toBe('image/png')
    expect(ref.bytes).toBe(PNG_1X1.length)
    expect(ref.name).toBe('red.png')
    expect(ref.attachmentId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(text(result)).toBe(formatVisionObserveOutput({
      path: join(dir, 'red.png'),
      evidence: 'a red square',
      image: {
        attachmentId: ref.attachmentId,
        mediaType: 'image/png',
        bytes: PNG_1X1.length,
        width: 1,
        height: 1,
        name: 'red.png',
      },
    }))

    // The committed object must read back verbatim through the store.
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new Error('expected the attachment service')
    const stored = await attachments.readImage(ref)
    expect(Buffer.from(stored.data)).toEqual(PNG_1X1)
  })

  it('emits fs/observed for the read image', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const { ctx } = await setup()
    const observed: string[] = []
    ctx.on('fs/observed', target => void observed.push(target.displayPath))
    await observe(ctx, { file_path: 'red.png' }, agentOn())
    expect(observed).toEqual([join(dir, 'red.png')])
  })

  it('omits the question when none is supplied', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const { ctx, vision } = await setup()
    await observe(ctx, { file_path: 'red.png' }, agentOn())
    expect(vision.requests[0]!.question).toBeUndefined()
  })

  it('works on a text-only route (no image-modality gate)', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const { ctx } = await setup()
    const agent = {
      options: { provider: 'text-only', model: 'deepseek-chat' },
      session: { header: { cwd: dir }, requestHeader: () => ({ config: { provider: 'text-only', model: 'deepseek-chat' } }) },
    }
    const result = await observe(ctx, { file_path: 'red.png' }, agent)
    expect(result.isError).toBe(false)
  })
})

describe('registration surface', () => {
  it('withdraws vision_observe when the attachment store is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(FsPolicy)
    const attachmentsFiber = await ctx.plugin(LocalAttachmentStore, { dshHome: home })
    new FakeVision(ctx)
    const visionFiber = await ctx.plugin({ name: 'tool-vision', inject: ['tools', 'fs', 'vision', 'attachments'], apply })
    const names = () => ctx.tools.schemas().map(schema => schema.name).sort()
    expect(names()).toContain('vision_observe')

    await attachmentsFiber.dispose()
    expect(names()).not.toContain('vision_observe')

    await visionFiber.dispose()
    expect(names()).toEqual([])
  })
})

describe('vision_observe refusals', () => {
  it('refuses an empty file_path', async () => {
    const { ctx } = await setup()
    const result = await observe(ctx, { file_path: '   ' }, agentOn())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('must be a non-empty string')
  })

  it('refuses non-image bytes through store admission', async () => {
    await writeFile(join(dir, 'note.txt'), 'not an image')
    const { ctx } = await setup()
    const result = await observe(ctx, { file_path: 'note.txt' }, agentOn())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Unsupported or malformed image data')
  })

  it('refuses a missing file', async () => {
    const { ctx } = await setup()
    const result = await observe(ctx, { file_path: 'ghost.png' }, agentOn())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not found')
  })

  it('detects the format from the bytes regardless of the file extension', async () => {
    // PNG bytes under a .jpg extension and under an extension-less name (the
    // attachment store's hash-named objects have no extension): the store
    // detects the real format instead of trusting the path.
    await writeFile(join(dir, 'fake.jpg'), PNG_1X1)
    await writeFile(join(dir, 'screenshot'), PNG_1X1)
    const { ctx, vision } = await setup()
    const jpg = await observe(ctx, { file_path: 'fake.jpg' }, agentOn())
    expect(jpg.isError).toBe(false)
    expect(vision.requests[0]!.attachments[0]!.mediaType).toBe('image/png')
    const bare = await observe(ctx, { file_path: 'screenshot' }, agentOn())
    expect(bare.isError).toBe(false)
    expect(vision.requests[1]!.attachments[0]!.mediaType).toBe('image/png')
  })

  it('refuses a directory path', async () => {
    await mkdir(join(dir, 'folder.png'))
    const { ctx } = await setup()
    const result = await observe(ctx, { file_path: 'folder.png' }, agentOn())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not a regular file')
  })

  it('refuses when the attachment service disappears mid-flight', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(FsPolicy)
    new FakeVision(ctx)
    // Direct registration bypasses the inject gate so the defensive re-check runs.
    applyVisionObserveTool(ctx)
    const result = await observe(ctx, { file_path: 'red.png' }, agentOn())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no attachment service is mounted')
  })

  it('canonicalizes a parent-traversing session cwd', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const { ctx } = await setup()
    // path.join would normalize the parent segment away; keep it in the raw
    // string so the canonicalization path actually runs.
    const agent = {
      options: {},
      session: {
        header: { cwd: dir + '/sub/..' },
        requestHeader: () => undefined,
      },
    }
    const result = await observe(ctx, { file_path: 'red.png' }, agent)
    expect(result.isError).toBe(false)
  })

  it('resolves without a session cwd for non-agent callers', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const { ctx } = await setup()
    const result = await observe(ctx, { file_path: 'red.png' })
    expect(result.isError).toBe(false)
  })

  it('propagates attachment failures untouched', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await pngOnlyContext()
    const store = ctx.get('attachments', false) as PngOnlyStore
    store.saveError = new Error('backend exploded')
    const plain = await observe(ctx, { file_path: 'red.png' }, agentOn())
    expect(plain.isError).toBe(true)
    expect(text(plain)).toContain('backend exploded')
    store.saveError = new AttachmentError('disk full', 'STORAGE')
    const coded = await observe(ctx, { file_path: 'red.png' }, agentOn())
    expect(coded.isError).toBe(true)
    expect(text(coded)).toContain('disk full')
  })

  it('declares vision_observe parallel-safe', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.executionMode({
      signal: testToolSignal, callId: CallId('vision-parallel'), name: 'vision_observe', arguments: { file_path: 'a.png' },
    })).toEqual({ kind: 'parallel' })
  })

  it('renders a committed image without a display name', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await pngOnlyContext()
    const store = ctx.get('attachments', false) as PngOnlyStore
    store.saveResult = {
      attachmentId: AttachmentId('no-name:1'),
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
    }
    const result = await observe(ctx, { file_path: 'red.png' }, agentOn())
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('<path>')
  })

  it('surfaces an observation failure as a tool error', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const { ctx } = await setup({ visionEvidence: 'x' })
    const vision = ctx.get('vision') as FakeVision
    vision.observe = () => Promise.reject(new Error('vision exploded'))
    const result = await observe(ctx, { file_path: 'red.png' }, agentOn())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('vision exploded')
  })
})
