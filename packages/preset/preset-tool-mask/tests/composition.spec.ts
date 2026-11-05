/**
 * Real-composition coverage for @deepseek-ai/dsh-preset-tool-mask: a Loader
 * tree mounts the mask as a preset row beside a row that registers a tool, and
 * an Agent composed under that preset sees only what the mask keeps.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentPresets, { type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import * as PresetRow from '@deepseek-ai/dsh-agent-preset'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

const pluginUrl = (name: string): string => new URL(`./fixtures/${name}.js`, import.meta.url).href

/** Mount the registry stack a preset composition needs. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = new URL('./fixtures/', import.meta.url).href
  await ctx.plugin(Loader)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'masked' })
  return ctx
}

/** Register one preset definition through the preset row plugin. */
async function declare(ctx: Context, config: PresetDefinition): Promise<void> {
  await ctx.plugin(PresetRow.default, config)
}

/** Create an Agent running the given preset. */
async function agentOn(ctx: Context, id: string, presetId?: string) {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx: Context) => { await ctx.agentPresets.mount(agentCtx, presetId) },
  })
  return handle.agent
}

describe('preset tool mask through the Loader', () => {
  it('narrows the preset catalog while leaving the host catalog intact', async () => {
    const ctx = await harness()
    const keep = { name: pluginUrl('contribute'), config: { tool: 'kept_tool' } }
    const drop = { name: pluginUrl('contribute'), config: { tool: 'dropped_tool' } }
    // The host registers both; only the preset's own row survives the mask.
    ctx.tools.register({
      name: 'host_tool',
      description: 'host',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: () => [] },
      execute: () => Promise.resolve('host'),
    } as never)
    await declare(ctx, {
      id: 'masked',
      plugins: [
        { id: 'mask', name: '@deepseek-ai/dsh-preset-tool-mask', config: { allow: ['kept_tool'] } },
        keep,
        drop,
      ],
    })
    const agent = await agentOn(ctx, 'masked-agent')
    const names = ctx.tools.schemas(agent).map(row => row.name).sort()
    // The preset's own rows stay visible; the host tool is masked out.
    expect(names).toEqual(['dropped_tool', 'kept_tool'])
    expect(ctx.tools.schemas().map(row => row.name)).toContain('host_tool')
    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(prompt.tools.map(row => row.name)).not.toContain('host_tool')
  })
})
