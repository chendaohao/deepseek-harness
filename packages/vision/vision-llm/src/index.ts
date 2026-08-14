/**
 * Vision observation provider over the harness LLM seam: registers
 * `ctx.vision` and answers observations by streaming a configured
 * vision-capable model route through `ctx.llm`. Credentials, retry policy,
 * and streaming belong to the route's own adapter (typically
 * `@deepseek-ai/dsh-llm-pi-ai`); this package never touches provider wire
 * formats or keys.
 * @module @deepseek-ai/dsh-vision-llm
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import { VisionError, VisionService } from '@deepseek-ai/dsh-vision'
import type { VisionObserveRequest, VisionObservation } from '@deepseek-ai/dsh-vision'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'vision-llm'

/** Services required by the vision provider. */
export const inject = ['llm']

/** Default maximum images observed in one request. */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 4

/**
 * The default observation instruction sent as the vision request's system
 * slot. Stable, model-visible text: deployments override it through
 * `prompt` config when they need a different contract.
 */
export const DEFAULT_OBSERVE_PROMPT =
  'You are a vision observer for a text-only agent. Examine the image(s) precisely '
  + 'and describe their content as evidence another model will quote. Report visible '
  + 'text verbatim, layout and structure, objects, people, charts, numbers, and UI '
  + 'elements. Do not infer what is not visible. End with a one-line summary.'

/** Vision observation provider configuration. */
export interface Config {
  /** LLM seam provider route that serves the vision model (e.g. an `llm-pi-ai` route). */
  provider: string
  /** Exact model id on that route; the model must declare `image` input. */
  model: string
  /** System instruction sent with every observation request. */
  prompt: string
  /** Maximum images observed in one request. */
  maxImagesPerRequest: number
  /** Cap on observation output tokens; absent leaves the provider default. */
  maxTokens?: number
}

/** Plugin config (defaults supplied by `Config`). */
export const Config: z<Config> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  prompt: z.string().default(DEFAULT_OBSERVE_PROMPT),
  maxImagesPerRequest: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_REQUEST),
  maxTokens: z.number().step(1).min(1),
})

/** The shape after schemastery applied the defaults; `maxTokens` stays optional. */
type ResolvedConfig = Config & Required<Pick<Config, 'prompt' | 'maxImagesPerRequest'>>

/** Convert one provider stream failure into the harness failure shape. */
function streamFailure(failure: { message: string; code: string }): never {
  throw new LlmError(failure.message, failure.code)
}

/**
 * Register the `ctx.vision` service backed by the configured LLM route.
 * Route validation happens at the first observation, not at load: loader
 * entries start in parallel, so the vision route's adapter may still be
 * registering when this plugin's fiber runs. The failure is still loud —
 * `VISION_UNCONFIGURED` names the route and the fix.
 * @param ctx - Cordis context carrying the `llm` service.
 * @param config - validated provider configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  // Constructing the service registers `ctx.vision` on this fiber; disposal
  // of the plugin fiber unregisters it.
  new VisionLlmProvider(ctx, resolved)
}

/** `ctx.vision` implementation streaming observations through `ctx.llm`. */
export class VisionLlmProvider extends VisionService {
  readonly visionRoute: { provider: string; model: string }

  readonly maxImagesPerRequest: number

  /** Whether the configured route has been validated for image input. */
  private validated = false

  constructor(
    private readonly llmCtx: Context,
    private readonly config: ResolvedConfig,
  ) {
    super(llmCtx)
    this.visionRoute = Object.freeze({ provider: config.provider, model: config.model })
    this.maxImagesPerRequest = config.maxImagesPerRequest
  }

  /**
   * Validate the configured route once: it must resolve and declare image
   * input. Fails loud with configuration guidance.
   * @param signal - optional cancellation for adapter-owned lookup.
   */
  private async ensureRoute(signal?: AbortSignal): Promise<void> {
    if (this.validated) return
    let declaredImage: boolean
    try {
      const info = await this.llmCtx.llm.resolveModelInfo(this.config.provider, this.config.model, signal)
      declaredImage = info.inputModalities?.includes('image') === true
    } catch (error: unknown) {
      throw new VisionError(
        `vision-llm: cannot resolve vision route "${this.config.provider}/${this.config.model}": ${(error as Error).message}`
        + '; load @deepseek-ai/dsh-llm-pi-ai (or another adapter) with that route before this plugin',
        'VISION_UNCONFIGURED',
        { cause: error },
      )
    }
    if (!declaredImage) {
      throw new VisionError(
        `vision-llm: model "${this.config.model}" on route "${this.config.provider}" does not declare image input; `
        + 'declare `input: [text, image]` for it in the route profile (llm-pi-ai config)',
        'VISION_UNCONFIGURED',
      )
    }
    this.validated = true
  }

  async observe(request: VisionObserveRequest, signal?: AbortSignal): Promise<VisionObservation> {
    await this.ensureRoute(signal)
    if (request.attachments.length === 0) {
      throw new VisionError('vision observation requires at least one image', 'VISION_EMPTY_REQUEST')
    }
    if (request.attachments.length > this.config.maxImagesPerRequest) {
      throw new VisionError(
        `vision observation accepts at most ${this.config.maxImagesPerRequest} images per request`,
        'VISION_TOO_MANY_IMAGES',
      )
    }
    signal?.throwIfAborted()
    const content: ContentBlock[] = []
    if (request.question !== undefined && request.question.length > 0) {
      content.push({ type: 'text', text: request.question })
    }
    for (const attachment of request.attachments) {
      content.push({ type: 'image', attachment })
    }
    const message = createUserMessage({
      content,
      source: { kind: 'plugin', plugin: 'vision-llm' },
    })
    const chunks: string[] = []
    let usage: TokenUsage | undefined
    const maxTokens = request.maxEvidenceTokens === undefined
      ? this.config.maxTokens
      : Math.min(request.maxEvidenceTokens, this.config.maxTokens ?? request.maxEvidenceTokens)
    try {
      for await (const chunk of this.llmCtx.llm.stream({
        provider: this.config.provider,
        model: this.config.model,
        system: this.config.prompt,
        messages: [message],
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(signal === undefined ? {} : { signal }),
      })) {
        if (chunk.type === 'text-delta') chunks.push(chunk.text)
        else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') streamFailure(chunk.reason.failure)
        }
      }
    } catch (error: unknown) {
      if (signal?.aborted) throw signal.reason
      if (error instanceof LlmError || error instanceof VisionError) throw error
      throw new LlmError(
        `vision observation failed: ${(error as Error).message}`,
        'VISION_OBSERVE_FAILED',
        { cause: error },
      )
    }
    const evidence = chunks.join('')
    if (evidence.length === 0) {
      throw new LlmError('vision observation produced no text', 'VISION_OBSERVE_FAILED')
    }
    return {
      evidence,
      ...(usage === undefined ? {} : { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }),
    }
  }
}
