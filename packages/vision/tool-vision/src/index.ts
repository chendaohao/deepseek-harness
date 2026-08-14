/**
 * The model-facing `vision_observe` tool: reads a PNG/JPEG/WebP/GIF file,
 * durably commits its bytes through the attachment service, and returns the
 * text evidence a configured vision model produced for it. Unlike
 * `read_image` (which requires the CURRENT model route to accept image
 * input), `vision_observe` works on text-only routes: the image never
 * reaches the main model, only its evidence does.
 * @module @deepseek-ai/dsh-tool-vision
 */

import { basename, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-vision'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-vision'

/**
 * Services required by the vision tool suite. The attachment store is a hard
 * dependency: without it the tool cannot commit image bytes durably, so the
 * plugin simply does not load (unlike the multi-tool filesystem suite, this
 * package owns one tool).
 */
export const inject = ['tools', 'fs', 'vision', 'attachments']

/** Extensions `vision_observe` accepts; magic-byte validation at the attachment service stays authoritative. */
const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** The canonical outcome declared by the `vision_observe` output schema. */
export interface VisionObserveValue {
  path: string
  evidence: string
  image: {
    attachmentId: string
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
  }
}

/**
 * Format an observation as the model-facing text envelope.
 * @param value - the canonical observation outcome.
 * @returns the model-facing envelope text.
 */
export function formatVisionObserveOutput(value: VisionObserveValue): string {
  return `<path>${value.path}</path>\n<evidence>\n${value.evidence}\n</evidence>`
}

/**
 * Resolution options shared with the filesystem tools: the calling agent's
 * session workspace cwd, so relative paths act on the session's workspace.
 * Mirrors `dsh-tool-fs`'s session-cwd helper.
 * @param exec - the tool-execution context supplying session cwd and cancellation.
 * @param requestedPath - the path the provider will resolve.
 * @returns provider resolution options for the current tool call.
 */
function sessionResolveOptions(exec: ToolExecution, requestedPath: string): { cwd?: string; signal?: AbortSignal } {
  const cwd = exec.agent?.session.header.cwd
  const PARENT_PATH_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/
  if (cwd === undefined) return { signal: exec.signal }
  const needsCanonical = PARENT_PATH_SEGMENT.test(cwd) || PARENT_PATH_SEGMENT.test(requestedPath)
  return {
    cwd: needsCanonical ? canonicalPath(cwd) : cwd,
    signal: exec.signal,
  }
}

/**
 * Resolve a model-supplied path, observe absence, and require a regular file.
 * Mirrors `dsh-tool-fs`'s read-target helper.
 * @param ctx - the plugin context providing filesystem resolution and observation events.
 * @param exec - the current tool execution, including session cwd and cancellation.
 * @param requestedPath - the raw path supplied to the tool.
 * @returns the resolved target and its single stat result.
 */
async function resolveRegularReadTarget(
  ctx: Context,
  exec: ToolExecution,
  requestedPath: string,
): Promise<{ target: FsTarget; info: FsInfo }> {
  const target = await ctx.fs.resolve(requestedPath, sessionResolveOptions(exec, requestedPath))
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (info.type !== 'file') {
    throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  return { target, info }
}

/**
 * Register the `vision_observe` tool into the given context. The composing
 * plugin owns the attachments gate: `src/index.ts` calls this inside
 * `ctx.inject(['attachments'], …)` so the tool exists only while a durable
 * store is mounted. Execution still re-checks `ctx.get('attachments')` for
 * direct callers.
 * @param ctx - the registration scope; execution uses its `fs`, `vision`,
 *   and optional `attachments` services.
 */
export function applyVisionObserveTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'vision_observe',
    description: 'Observe a PNG/JPEG/WebP/GIF file through a separate vision model and return text evidence, so text-only model routes can see images. Requires a configured vision route (dsh-vision-llm).',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' },
      question: { type: 'string', description: 'Optional question steering what the vision model should describe.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          evidence: { type: 'string', required: true },
          image: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => {
        return [{ type: 'text', text: formatVisionObserveOutput(value) }]
      },
    },
    // Content-addressed attachment writes are idempotent, so concurrent reads
    // of the same file cannot conflict.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')

      // Every gate runs before any filesystem I/O so a refusal never leaks
      // partial reads or attachment writes.
      const mediaType = IMAGE_EXTENSIONS[extname(args.file_path).toLowerCase()]
      if (mediaType === undefined) {
        throw new Error(`cannot observe "${args.file_path}": vision_observe only accepts PNG/JPEG/WebP/GIF paths`)
      }
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error(`cannot observe "${args.file_path}": no attachment service is mounted`)
      }
      if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`cannot observe "${args.file_path}": ${mediaType} images are not accepted by this deployment`)
      }

      const { target, info } = await resolveRegularReadTarget(ctx, exec, args.file_path)

      // The tool result is one message carrying one image, so the per-message
      // aggregate bound applies beside the per-image bound.
      const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      const data = await ctx.fs.readBytes(target, exec.signal, byteCap)
      // Persist before observing: the evidence references a durably committed
      // object even when the tool result is recorded.
      let ref: ImageAttachmentRef
      try {
        ref = await attachments.saveImage({ data, mediaType, name: basename(target.displayPath) })
      } catch (error: unknown) {
        if (!(error instanceof AttachmentError) || error.code !== 'IMAGE_TYPE_MISMATCH') throw error
        const extension = extname(target.displayPath).toLowerCase()
        throw new Error(
          `cannot observe "${target.displayPath}": the ${extension} extension declares ${mediaType}, but the bytes use a different image format; `
          + 'rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats',
          { cause: error },
        )
      }

      const observation = await ctx.vision.observe(
        { attachments: [ref], ...(args.question === undefined ? {} : { question: args.question }) },
        exec.signal,
      )
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return {
        path: target.displayPath,
        evidence: observation.evidence,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name === undefined ? {} : { name: ref.name },
        },
      }
    },
  }))
}

/** Register the `vision_observe` tool. */
export function apply(ctx: Context): void {
  applyVisionObserveTool(ctx)
}
