/** Vision observation seam (`ctx.vision`). @module @deepseek-ai/dsh-vision */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { VisionObserveRequest, VisionObservation } from './types.ts'
// Type-only edge: loads the dsh-session declaration face for the SessionEventMap merge.

/** Cordis service key of the vision-bridge marker service. */
export const VISION_BRIDGE_SERVICE = 'visionBridge'

export { VisionError } from './error.ts'
export type { VisionObserveRequest, VisionObservation } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    vision: VisionService
    /**
     * Present while a vision bridge converts image content for text-only
     * routes; host admission checks read it to admit images a text-only main
     * model would otherwise refuse.
     */
    visionBridge: {}
  }
}

/** Durable record of one vision observation, appended by the observing consumer. */
export interface VisionObservedEvent {
  /** Turn of the observation's owning step when the consumer knows it. */
  turn?: number
  /** Step of the observation's owning step when the consumer knows it. */
  step?: number
  /** Message id of the observed user message when the consumer knows it. */
  messageId?: string
  /** The durable images the evidence describes. */
  attachments: readonly ImageAttachmentRef[]
  /** The model-facing evidence text produced for the images. */
  evidence: string
  /** The provider route and model that produced the evidence. */
  vision: { provider: string; model: string }
  /** Provider-reported token accounting when the adapter reported any. */
  usage?: { inputTokens: number; outputTokens: number }
}

/**
 * Vision observation service: turn durable image attachments into text
 * evidence without assuming the current model route can see images. The
 * service is a pure capability — it never writes session events; the
 * observing consumer owns recording (a tool result records itself, the
 * request bridge appends `vision/observed`).
 */
export abstract class VisionService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'vision')
  }

  /**
   * The provider route and model this observer uses, declared beside the
   * service so consumers can record and attribute observations without
   * knowing the provider's configuration.
   */
  abstract readonly visionRoute: { provider: string; model: string }

  /** Deployment-resolved maximum images observed in one request. */
  abstract readonly maxImagesPerRequest: number

  /**
   * Observe one set of durable images and return text evidence.
   * @param request - the image references and optional steering question.
   * @param signal - optional cancellation for provider work.
   * @returns the evidence text and provider token accounting when reported.
   * @throws {@link VisionError} for observation failures; the provider route
   *   surfaces its own LlmError for request-level failures.
   */
  abstract observe(request: VisionObserveRequest, signal?: AbortSignal): Promise<VisionObservation>
}

export default VisionService
