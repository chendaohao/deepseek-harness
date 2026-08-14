/** Durable vision observation vocabulary. @module @deepseek-ai/dsh-vision/types */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
// Loaded through the package INDEX (not the /types subpath): the augmentation
// below resolves against the session module graph, which must be loaded first.
import type {} from '@deepseek-ai/dsh-session'

/** One observation request: durable image references plus an optional question. */
export interface VisionObserveRequest {
  /** Durable images to observe, already committed through the attachment seam. */
  attachments: readonly ImageAttachmentRef[]
  /** Optional task-specific question steering the observer's description. */
  question?: string
  /** Cap on observation output tokens; absent leaves the provider default. */
  maxEvidenceTokens?: number
}

/** The text evidence a vision observer produced for one observation request. */
export interface VisionObservation {
  /** Model-facing text describing the observed images. */
  evidence: string
  /** Provider-reported token accounting when the adapter reported any. */
  usage?: { inputTokens: number; outputTokens: number }
}
/**
 * One completed vision observation: the durable evidence text a vision model
 * produced for the referenced images. Log-only, non-surface, and ignorable:
 * reconstruction of model-visible content never reads it, and a reader without
 * the vision vocabulary can safely skip it (the images themselves stay on the
 * surface through their own `user/message` events). Consumers append it so a
 * converted model request stays reconstructable from the log — the
 * "model-visible ⟺ logged" invariant for bridged image input.
 */
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

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One completed vision observation: the durable evidence text a vision
     * model produced for the referenced images. Log-only, non-surface, and
     * ignorable: reconstruction of model-visible content never reads it, and a
     * reader without the vision vocabulary can safely skip it (the images
     * themselves stay on the surface through their own `user/message` events).
     * Consumers append it so a converted model request stays reconstructable
     * from the log — the "model-visible ⟺ logged" invariant for bridged image
     * input.
     */
    'vision/observed': VisionObservedEvent
  }
}
