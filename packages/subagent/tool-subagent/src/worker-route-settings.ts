/** Host-owned default LLM route for delegation children. */

import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User preference sampled by a delegation tool that advertises the setting. */
    subagentWorkerRoute: SubagentWorkerRouteConfig
  }
}

/** User-settings namespace for the default delegation child route. */
export const SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE = 'subagent-worker-route-settings'

/** Stored child route; a tool instance without the opt-in ignores it. */
export interface SubagentWorkerRouteSettings {
  /** Registered LLM provider id for the child. */
  provider: string
  /** Provider-owned exact model id for the child. */
  model: string
  /** Adapter-owned reasoning effort for that child route. */
  reasoningEffort: ReturnType<typeof ReasoningEffortId>
}

/** Deployment base for the preference; every field is required. */
export interface Config {
  /** Initial provider inherited when the user document does not override it. */
  provider: Volatile<string>
  /** Initial model inherited when the user document does not override it. */
  model: Volatile<string>
  /** Initial reasoning effort inherited when the user document does not override it. */
  reasoningEffort: Volatile<string>
}

/**
 * Reject a stored route the delegation path could not use.
 * @param value - the resolved route.
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
  static Config = z.object({
    provider: z.string().min(1).required().volatile(),
    model: z.string().min(1).required().volatile(),
    reasoningEffort: z.string().min(1).required().volatile(),
  })

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'subagentWorkerRoute')
  }

  /**
   * Read the current default child route.
   * @returns the configured route as a detached value.
   */
  current(): SubagentWorkerRouteSettings {
    const route: SubagentWorkerRouteSettings = {
      provider: this.config.provider.get(),
      model: this.config.model.get(),
      reasoningEffort: ReasoningEffortId(this.config.reasoningEffort.get()),
    }
    assertWorkerRoute(route)
    return route
  }
}

export const name = 'subagent-worker-route-settings'
export default SubagentWorkerRouteConfig
