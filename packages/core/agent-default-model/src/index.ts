/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-config-editor'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Default model selection supplied by plugin configuration. */
export interface Config {
  /** Registered provider route. */
  provider: Volatile<string>
  /** Provider-owned model id. */
  model: Volatile<string>
  /** Adapter-owned reasoning effort; omission follows the provider default. */
  reasoningEffort: Volatile<string | undefined>
  /**
   * Reasoning efforts the user chose explicitly, keyed by `${provider}/${model}`
   * for the exact model route the choice was made on. A model switch back to
   * that route restores its choice instead of falling back to the model
   * default; picking the provider default clears it.
   */
  reasoningEfforts: Volatile<Record<string, string> | undefined>
}

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: { provider: string; model: string; reasoningEffort?: string }): ModelSelection {
  return {
    provider: settings.provider,
    model: settings.model,
    ...settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
  }
}

/** The settings key remembering one exact model route's reasoning effort. */
function effortKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/**
 * Owns the default model selection independently of any Host or transport.
 * Each operation reads the owning Config references.
 */
export class AgentDefaultModelConfig extends Service {
  static Config = z.object({
    provider: z.string().required().volatile(),
    model: z.string().required().volatile(),
    reasoningEffort: z.string().volatile(),
    reasoningEfforts: z.dict(z.string()).volatile(),
  })

  constructor(private readonly ownerContext: Context, private readonly config: Config) {
    super(ownerContext, 'agentDefaultModel')

    ownerContext.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ownerContext.fiber)) })
  }

  /**
   * Read the current default model selection.
   * @returns a detached provider, model, and optional reasoning selection.
   */
  currentSelection(): ModelSelection {
    const reasoningEffort = this.config.reasoningEffort.get()
    return selection({
      provider: this.config.provider.get(), model: this.config.model.get(),
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    })
  }

  /**
   * Save the complete default model selection. The per-model memory is
   * independent of it, so a selection write restates the remembered choices
   * rather than dropping them. A deployment without a configuration editor
   * keeps its composition entry.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional profile write settles.
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    await this.editConfig((current) => {
      // The per-model memory is independent of the default selection and
      // survives the write; the default effort is exactly what the caller sent,
      // so an omitted one clears whatever was stored.
      const { reasoningEffort: _cleared, ...rest } = current
      return {
        ...rest,
        provider: next.provider,
        model: next.model,
        ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
      }
    })
  }

  /**
   * One model route's explicitly chosen reasoning effort, or `undefined` when
   * the user never chose one (the model default applies).
   * @param provider - the route the choice was made on.
   * @param model - the provider-owned model id the choice was made for.
   * @returns the remembered effort identifier.
   */
  rememberedEffort(provider: string, model: string): string | undefined {
    return this.config.reasoningEfforts.get()?.[effortKey(provider, model)]
  }

  /**
   * Record an explicitly chosen reasoning effort for one model route. A
   * deployment without a configuration editor keeps the composition entry,
   * which carries no memory; the write is then a no-op.
   * @param provider - the route the user chose on.
   * @param model - the provider-owned model id the user chose for.
   * @param effort - the adapter-owned effort identifier that was validated.
   * @returns fulfillment after the optional profile write settles.
   */
  async rememberEffort(provider: string, model: string, effort: string): Promise<void> {
    await this.editEfforts(efforts => ({ ...efforts, [effortKey(provider, model)]: effort }))
  }

  /**
   * Clear one model route's remembered effort, for an explicit provider-default
   * choice. A deployment without a configuration editor keeps the composition
   * entry, which carries no memory; the write is then a no-op.
   * @param provider - the route whose choice is being cleared.
   * @param model - the provider-owned model id whose choice is being cleared.
   * @returns fulfillment after the optional profile write settles.
   */
  async forgetEffort(provider: string, model: string): Promise<void> {
    await this.editEfforts((efforts) => {
      const next = { ...efforts }
      Reflect.deleteProperty(next, effortKey(provider, model))
      return next
    })
  }

  /** Persist one change to the per-model effort memory beside the selection. */
  private async editEfforts(change: (efforts: Record<string, string>) => Record<string, string>): Promise<void> {
    await this.editConfig(current => ({
      ...current,
      reasoningEfforts: change({ ...(this.config.reasoningEfforts.get() ?? {}) }),
    }))
  }

  /** Write one profile-backed Config change; without an editor the composition entry stands. */
  private async editConfig(change: (current: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) return
    await this.ctx.get('configEditor')?.edit(entry, change)
  }
}

export default AgentDefaultModelConfig
