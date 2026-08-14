/**
 * Automatic vision bridge: on text-only model routes, converts image content
 * in agent-loop requests into text evidence from the configured vision
 * observer, so pasted images keep working on models that cannot see them.
 * The original `user/message` events stay untouched (the UI keeps showing the
 * images); each observation is recorded as an `ignorable` `vision/observed`
 * event so the converted request stays reconstructable from the session log.
 * @module @deepseek-ai/dsh-vision-bridge
 */

import { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, UserMessage } from '@deepseek-ai/dsh-llm'
import { contentHasImage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { VisionObservedEvent } from '@deepseek-ai/dsh-vision'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'vision-bridge'

/** Services required by the bridge. */
export const inject = ['llm', 'sessions', 'vision']

/** One observed image batch, cached by its message and attachment ids. */
interface CachedEvidence {
  evidence: string
  vision: { provider: string; model: string }
}

/**
 * Cache key for one image batch: the message id plus the ordered attachment
 * ids, so identical batches in different messages stay distinct.
 * @param messageId - the owning user message's id.
 * @param attachments - the batch's durable image references.
 * @returns the stable cache key.
 */
export function batchKey(messageId: string, attachments: readonly ImageAttachmentRef[]): string {
  return messageId + '|' + attachments.map(ref => ref.attachmentId).join('+')
}

/**
 * The model-facing evidence block replacing one image batch.
 * @param messageId - the owning user message's id, so the main model can tie evidence back.
 * @param attachments - the batch's durable image references.
 * @param evidence - the observation text produced for the batch.
 * @returns the text block placed where the batch's first image stood.
 */
export function evidenceBlockFor(
  messageId: string,
  attachments: readonly ImageAttachmentRef[],
  evidence: string,
): ContentBlock {
  const ids = attachments.map(ref => ref.attachmentId).join(',')
  return {
    type: 'text',
    text: `<vision-evidence message-id="${messageId}" attachment-ids="${ids}">\n<content>\n${evidence}\n</content>`,
  }
}

/** One user message's images, split into observation batches. */
interface MessageImageGroup {
  message: UserMessage
  question: string | undefined
  batches: ImageAttachmentRef[][]
}

/**
 * Register the bridge: observes image-bearing agent-loop requests on
 * text-only routes and converts them before they reach the adapter.
 * @param ctx - Cordis context carrying `llm`, `sessions`, and `vision`.
 */
export function apply(ctx: Context): void {
  // Evidence index per session, fed by the authoritative log so a restarted
  // process reuses recorded observations instead of re-observing history.
  const evidenceBySession = new WeakMap<Session, Map<string, CachedEvidence>>()

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'vision/observed' || event.data.messageId === undefined) return
    let byKey = evidenceBySession.get(session)
    if (byKey === undefined) {
      byKey = new Map()
      evidenceBySession.set(session, byKey)
    }
    byKey.set(batchKey(event.data.messageId, event.data.attachments), {
      evidence: event.data.evidence,
      vision: event.data.vision,
    })
  })

  ctx.on('llm/stream', (options: GenerateOptions, next) => {
    // Only agent-loop requests carry the durable session identity the bridge
    // needs; hand-built requests (including the bridge's own vision calls)
    // stay untouched, so no re-entrancy guard is required.
    if (!isAgentLoopRequest(options)) return next()
    if (!options.messages.some(message => contentHasImage(message.content))) return next()
    if (options.sessionId === undefined) return next()
    // ctx.get reads the global service store; the listener fiber may not carry
    // the sessions injection on its lookup chain.
    const session = ctx.get('sessions')?.get(options.sessionId)
    if (session === undefined) return next()

    return (async function* () {
      // Exact-route gate, matching read_image's: the model must DECLARE image
      // input to receive images natively; unknown capability bridges.
      const info = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal)
      if (info.inputModalities?.includes('image') === true) {
        yield* next()
        return
      }
      const converted = await convertRequest(ctx, session, options, evidenceBySession)
      // The converted request is a fresh object, not marked as an agent-loop
      // request, so it passes the bridge and the loop invariant untouched.
      yield* ctx.llm.stream({ ...options, messages: converted })
    })()
  })
}

/**
 * Observe every uncached image batch and return the converted messages.
 * @param ctx - context carrying `vision` for observation.
 * @param session - the request's session, owning appended events and the cache.
 * @param options - the original frozen request.
 * @param evidenceBySession - the per-session evidence index.
 * @returns messages with each image batch replaced by its evidence block.
 */
async function convertRequest(
  ctx: Context,
  session: Session,
  options: GenerateOptions,
  evidenceBySession: WeakMap<Session, Map<string, CachedEvidence>>,
): Promise<GenerateOptions['messages']> {
  const groups = collectGroups(ctx, options.messages)
  for (const group of groups) {
    for (const batch of group.batches) {
      const key = batchKey(group.message.id, batch)
      const byKey = evidenceBySession.get(session)
      if (byKey?.has(key) === true) continue
      const observation = await ctx.vision.observe(
        { attachments: batch, ...(group.question === undefined ? {} : { question: group.question }) },
        options.signal,
      )
      const record: VisionObservedEvent = {
        messageId: group.message.id,
        attachments: [...batch],
        evidence: observation.evidence,
        vision: ctx.vision.visionRoute,
        ...(observation.usage === undefined ? {} : { usage: observation.usage }),
      }
      session.append('vision/observed', record, { ignorable: true })
      // The session/event listener above fills the index from the appended
      // event; no write here is needed.
    }
  }
  return convertMessages(session, options.messages, groups, evidenceBySession)
}

/**
 * Split each image-bearing user message into observation batches.
 * @param ctx - context carrying the vision service's batch cap.
 * @param messages - the request's frozen messages.
 * @returns one group per image-bearing user message.
 */
function collectGroups(ctx: Context, messages: GenerateOptions['messages']): MessageImageGroup[] {
  const cap = ctx.vision.maxImagesPerRequest
  const groups: MessageImageGroup[] = []
  for (const candidate of messages) {
    if (candidate.role !== 'user') continue
    const message = candidate as UserMessage
    const images = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image',
    )
    if (images.length === 0) continue
    const batches: ImageAttachmentRef[][] = []
    for (let index = 0; index < images.length; index += cap) {
      batches.push(images.slice(index, index + cap).map(block => block.attachment))
    }
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    groups.push({ message, question: text.length === 0 ? undefined : text, batches })
  }
  return groups
}

/**
 * Replace each image batch in the original messages with its evidence block.
 * @param session - the session owning the evidence index.
 * @param messages - the original frozen messages.
 * @param groups - the collected image groups, keyed by message id.
 * @param evidenceBySession - the per-session evidence index.
 * @returns the converted messages, one evidence block per batch.
 */
function convertMessages(
  session: Session,
  messages: GenerateOptions['messages'],
  groups: MessageImageGroup[],
  evidenceBySession: WeakMap<Session, Map<string, CachedEvidence>>,
): GenerateOptions['messages'] {
  const byMessage = new Map(groups.map(group => [group.message.id, group]))
  return messages.map((message) => {
    const group = byMessage.get(message.id)
    if (group === undefined) return message
    const content: ContentBlock[] = []
    let batchIndex = 0
    // collectGroups never emits an empty batch list.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- guarded by collectGroups.
    let remaining = group.batches[0]!.length
    for (const block of message.content) {
      if (block.type !== 'image') {
        content.push(block)
        continue
      }
      if (remaining === 0) {
        batchIndex += 1
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the batch list is non-empty.
        remaining = group.batches[batchIndex]!.length
      }
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the batch list is non-empty.
      if (remaining === group.batches[batchIndex]!.length) {
        // First image of the batch: place the batch's evidence block here.
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the batch list is non-empty.
        const batch = group.batches[batchIndex]!
        const cached = evidenceBySession.get(session)?.get(batchKey(message.id, batch))
        /* v8 ignore next 2 -- every batch was observed and cached above; a miss is a broken invariant. */
        if (cached === undefined) throw new Error('vision-bridge: missing evidence for a converted batch')
        content.push(evidenceBlockFor(message.id, batch, cached.evidence))
      }
      remaining -= 1
    }
    return { ...message, content }
  })
}
