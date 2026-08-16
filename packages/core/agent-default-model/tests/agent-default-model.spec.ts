/** Default Agent model settings layered over a real settings provider. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig, { AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE } from '../src/index.ts'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function boot(): Promise<{
  ctx: Context
  settingsFiber: Context['fiber']
  defaultModel: AgentDefaultModelConfig
}> {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  await ctx.plugin(AgentDefaultModelConfig, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  return { ctx, settingsFiber, defaultModel: ctx.agentDefaultModel }
}

describe('AgentDefaultModelConfig', () => {
  it('resolves the user layer over the composition entry', async () => {
    const bench = await boot()
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })

    await bench.defaultModel.saveSelection({
      provider: 'acme-gateway', model: 'acme-large', reasoningEffort: ReasoningEffortId('high'),
    })
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'acme-gateway', model: 'acme-large', reasoningEffort: 'high',
    })
    await bench.ctx.fiber.dispose()
  })

  it('clears a stored effort when the saved selection has none', async () => {
    const bench = await boot()
    await bench.defaultModel.saveSelection({
      provider: 'acme-gateway', model: 'acme-large', reasoningEffort: ReasoningEffortId('high'),
    })
    await bench.defaultModel.saveSelection({ provider: 'acme-gateway', model: 'acme-plain' })
    expect(bench.defaultModel.currentSelection()).toEqual({ provider: 'acme-gateway', model: 'acme-plain' })
    await bench.ctx.fiber.dispose()
  })

  it('layers a hand-written partial section over the entry', async () => {
    const bench = await boot()
    await bench.settingsFiber.ctx.settings.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
      model: 'deepseek-reasoner',
    })
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-reasoner',
    })
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await boot()
    await bench.defaultModel.saveSelection({ provider: 'acme-gateway', model: 'acme-large' })
    expect(bench.defaultModel.currentSelection().provider).toBe('acme-gateway')
    await bench.settingsFiber.dispose()
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    await bench.ctx.fiber.dispose()
  })

  it('keeps the composition entry when no settings provider is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'p', model: 'm' })
    await ctx.agentDefaultModel.saveSelection({ provider: 'other', model: 'other' })
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'p', model: 'm' })
    await ctx.fiber.dispose()
  })

  it('remembers and forgets one model route effort without disturbing the default', async () => {
    const bench = await boot()
    await bench.defaultModel.rememberEffort('acme-gateway', 'acme-large', 'max')
    expect(bench.defaultModel.rememberedEffort('acme-gateway', 'acme-large')).toBe('max')
    expect(bench.defaultModel.rememberedEffort('acme-gateway', 'acme-small')).toBeUndefined()
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })

    await bench.defaultModel.forgetEffort('acme-gateway', 'acme-large')
    expect(bench.defaultModel.rememberedEffort('acme-gateway', 'acme-large')).toBeUndefined()
    // Unsetting an absent route is already satisfied, not an error.
    await bench.defaultModel.forgetEffort('acme-gateway', 'acme-small')
    await bench.ctx.fiber.dispose()
  })

  it('keeps each model route memory across a default-selection save', async () => {
    const bench = await boot()
    await bench.defaultModel.rememberEffort('acme-gateway', 'acme-large', 'max')
    await bench.defaultModel.rememberEffort('acme-gateway', 'acme-small', 'high')

    // The default write replaces the whole section; the per-model memory has
    // to survive it, and a selection carrying no effort must not wipe it.
    await bench.defaultModel.saveSelection({ provider: 'acme-gateway', model: 'acme-plain' })
    expect(bench.defaultModel.rememberedEffort('acme-gateway', 'acme-large')).toBe('max')
    expect(bench.defaultModel.rememberedEffort('acme-gateway', 'acme-small')).toBe('high')

    // An explicit level re-keys the route it was chosen on.
    await bench.defaultModel.rememberEffort('acme-gateway', 'acme-large', 'off')
    expect(bench.defaultModel.rememberedEffort('acme-gateway', 'acme-large')).toBe('off')
    await bench.ctx.fiber.dispose()
  })

  it('reads a hand-written reasoningEfforts section from the settings document', async () => {
    const bench = await boot()
    await bench.settingsFiber.ctx.settings.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEfforts: { 'acme-gateway/acme-large': 'max' },
    })
    expect(bench.defaultModel.rememberedEffort('acme-gateway', 'acme-large')).toBe('max')
    await bench.ctx.fiber.dispose()
  })

  it('keeps no memory when no settings provider is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'p', model: 'm' })
    await ctx.agentDefaultModel.rememberEffort('p', 'm', 'max')
    expect(ctx.agentDefaultModel.rememberedEffort('p', 'm')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
