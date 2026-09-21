/** Host-owned default LLM route for delegation children. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User preference sampled by a delegation tool that advertises the setting. */
    subagentWorkerRoute: SubagentWorkerRouteConfig
  }
}

/** User-settings section for the default delegation child route. */
export const SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE = 'subagent-worker-route'

/** Stored child route; a tool instance without the opt-in ignores it. */
export interface SubagentWorkerRouteSettings {
  /** Registered LLM provider id for the child. */
  provider: string
  /** Provider-owned exact model id for the child. */
  model: string
  /** Adapter-owned reasoning effort for that child route. */
  reasoningEffort: ReturnType<typeof ReasoningEffortId>
}

/** Schema served to settings clients for the default child route. */
export const SUBAGENT_WORKER_ROUTE_SETTINGS_SCHEMA: z<SubagentWorkerRouteSettings> = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
  reasoningEffort: z.string().min(1).required() as z<ReturnType<typeof ReasoningEffortId>>,
})

/** Deployment base for the preference; every field is required. */
export interface Config {
  /** Initial provider inherited when the user document does not override it. */
  provider: string
  /** Initial model inherited when the user document does not override it. */
  model: string
  /** Initial reasoning effort inherited when the user document does not override it. */
  reasoningEffort: string
}

/**
 * Reject a stored route the delegation path could not use.
 * @param value - the resolved section.
 * @throws when any field is empty.
 */
function assertWorkerRoute(value: SubagentWorkerRouteSettings): void {
  for (const field of ['provider', 'model', 'reasoningEffort'] as const) {
    if (value[field].length === 0) {
      throw new Error(`subagent worker route requires a non-empty \`${field}\``)
    }
  }
}

/**
 * Singleton settings owner read when a delegation tool resolves its child
 * default route. The route reaches the LLM adapter only through the delegation
 * preflight, which validates the provider, model, and effort together.
 */
export class SubagentWorkerRouteConfig extends Service {
  static Config: z<Config> = z.object({
    provider: z.string().min(1).required(),
    model: z.string().min(1).required(),
    reasoningEffort: z.string().min(1).required(),
  })

  private source: () => SubagentWorkerRouteSettings

  constructor(ctx: Context, config: Config) {
    super(ctx, 'subagentWorkerRoute')
    const entry: SubagentWorkerRouteSettings = {
      provider: config.provider,
      model: config.model,
      reasoningEffort: ReasoningEffortId(config.reasoningEffort),
    }
    this.validate(entry)
    this.source = () => entry
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(
        ctx,
        SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE,
        SUBAGENT_WORKER_ROUTE_SETTINGS_SCHEMA,
        entry,
        {
          setSource: (source) => { this.source = source },
          validate: (value) => { this.validate(value) },
          // The delegation tool reads this per call, so a settings update never
          // needs to rebuild a definition.
          onChange: () => {},
        },
      )
    })
  }

  /**
   * Read the current default child route.
   * @returns the configured route as a detached value.
   */
  current(): SubagentWorkerRouteSettings {
    return { ...this.source() }
  }

  private validate(value: SubagentWorkerRouteSettings): void {
    assertWorkerRoute(value)
  }
}

export const name = 'subagent-worker-route-settings'
export default SubagentWorkerRouteConfig
