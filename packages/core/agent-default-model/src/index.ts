/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Settings namespace carrying the default model selection for future Agents. */
export const AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = settingsNamespace('agent-default-model')

/** Stored and composed default model selection. */
export interface AgentDefaultModelSettings {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string
  /**
   * Reasoning efforts the user chose explicitly, keyed by
   * `${provider}/${model}` for the exact model route the choice was made on.
   * A model switch back to that route restores its choice instead of falling
   * back to the model default; picking the provider default clears it.
   */
  reasoningEfforts?: Record<string, string>
}

/** Schema of the default Agent model settings section. */
export const AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA: z<AgentDefaultModelSettings> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
  reasoningEfforts: z.dict(z.string()),
})

/** Composition entry for the default model selection. */
export interface Config {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: AgentDefaultModelSettings): ModelSelection {
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
 * The composition entry remains usable without a settings provider; when one
 * is mounted, its user layer is read live.
 */
export class AgentDefaultModelConfig extends Service {
  static Config: z<Config> = z.object({
    provider: z.string().required(),
    model: z.string().required(),
  })

  private source: () => AgentDefaultModelSettings

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentDefaultModel')
    const entry: AgentDefaultModelSettings = { provider: config.provider, model: config.model }
    this.source = () => entry
    installSettingsSection(ctx, AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA, entry, {
      setSource: (current) => { this.source = current },
      // Every consumer reads through currentSelection(), so no registration-level fact
      // needs rebuilding when the settings document changes.
      onChange: () => {},
    })
  }

  /**
   * Read the current default model selection.
   * @returns a detached provider, model, and optional reasoning selection.
   */
  currentSelection(): ModelSelection {
    return selection(this.source())
  }

  /**
   * Save the complete default model selection. A deployment without a settings
   * provider keeps its composition entry.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional settings write settles.
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    const current = this.source()
    await this.ctx.get('settings')?.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
      provider: next.provider,
      model: next.model,
      ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
      // The per-model memory is independent of the default selection: a
      // selection write must not drop the choices other models remember.
      ...current.reasoningEfforts === undefined ? {} : { reasoningEfforts: current.reasoningEfforts },
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
    return this.source().reasoningEfforts?.[effortKey(provider, model)]
  }

  /**
   * Record an explicitly chosen reasoning effort for one model route. A
   * deployment without a settings provider keeps the composition entry, which
   * carries no memory; the write is then a no-op.
   * @param provider - the route the user chose on.
   * @param model - the provider-owned model id the user chose for.
   * @param effort - the adapter-owned effort identifier that was validated.
   * @returns fulfillment after the optional settings write settles.
   */
  async rememberEffort(provider: string, model: string, effort: string): Promise<void> {
    await this.ctx.get('settings')?.mutate(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, [
      { op: 'set', path: ['reasoningEfforts', effortKey(provider, model)], value: effort },
    ])
  }

  /**
   * Clear one model route's remembered effort, for an explicit provider-default
   * choice. A deployment without a settings provider keeps the composition
   * entry, which carries no memory; the write is then a no-op.
   * @param provider - the route whose choice is being cleared.
   * @param model - the provider-owned model id whose choice is being cleared.
   * @returns fulfillment after the optional settings write settles.
   */
  async forgetEffort(provider: string, model: string): Promise<void> {
    await this.ctx.get('settings')?.mutate(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, [
      { op: 'unset', path: ['reasoningEfforts', effortKey(provider, model)] },
    ])
  }
}

export default AgentDefaultModelConfig
