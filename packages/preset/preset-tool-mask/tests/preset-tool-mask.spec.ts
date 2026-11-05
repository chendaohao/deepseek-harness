/**
 * Unit coverage for @deepseek-ai/dsh-preset-tool-mask: the derived mask, inheritance
 * into an Agent scope composed under the preset, re-expansion when a tool
 * arrives later, fail-loud declarations, and teardown that leaves the host
 * unmasked.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { bindScopeParent, createScope, scopeOf, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import * as toolScope from '../src/index.ts'

const contexts: Context[] = []
const scopes: Scope[] = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) await scope.dispose()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** A minimal tool definition the registry accepts. */
function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: () => Promise.resolve(name),
  }
}

/** Mount the registry and register the given global tools. */
async function host(names: readonly string[]): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  for (const name of names) ctx.tools.register(tool(name))
  return ctx
}

/** A scope standing in for a preset mount. */
function presetScope(ctx: Context): Scope {
  const scope = createScope(ctx, {})
  scopes.push(scope)
  return scope
}

/** An Agent scope parented to a preset scope. */
function agentScope(ctx: Context, parent: ScopeKey): Scope {
  const key = {}
  bindScopeParent(key, parent)
  const scope = createScope(ctx, key)
  scopes.push(scope)
  return scope
}

/** Visible tool names in one scope, resolved through that scope's own context. */
async function visible(scope: Scope): Promise<string[]> {
  let names: string[] = []
  await scope.ctx.plugin({
    inject: ['tools'],
    apply(child: Context) {
      const key = scopeOf(child)
      names = child.tools.schemas(key).map(row => row.name).sort()
    },
  })
  return names
}

describe('tool scope', () => {
  it('hides every global tool the declaration does not keep', async () => {
    const ctx = await host(['read', 'write', 'bash', 'task_board_create', 'mcp__codegraph__explore'])
    const preset = presetScope(ctx)
    await preset.ctx.plugin(toolScope, { allow: ['read', 'bash'], allowPrefixes: ['mcp__codegraph__'] })
    const agent = agentScope(ctx, scopeOf(preset.ctx)!)
    expect(await visible(agent)).toEqual(['bash', 'mcp__codegraph__explore', 'read'])
  })

  it('leaves the host catalog unmasked', async () => {
    const ctx = await host(['read', 'write'])
    const preset = presetScope(ctx)
    await preset.ctx.plugin(toolScope, { allow: ['read'] })
    expect(ctx.tools.schemas().map(row => row.name).sort()).toEqual(['read', 'write'])
  })

  it('masks a tool registered after the preset mounted', async () => {
    const ctx = await host(['read'])
    const preset = presetScope(ctx)
    await preset.ctx.plugin(toolScope, { allow: ['read'] })
    const agent = agentScope(ctx, scopeOf(preset.ctx)!)
    expect(await visible(agent)).toEqual(['read'])
    ctx.tools.register(tool('late-arrival'))
    expect(await visible(agent)).toEqual(['read'])
  })

  it('lifts the mask when the preset unmounts', async () => {
    const ctx = await host(['read', 'write'])
    const preset = presetScope(ctx)
    await preset.ctx.plugin(toolScope, { allow: ['read'] })
    const agent = agentScope(ctx, scopeOf(preset.ctx)!)
    expect(await visible(agent)).toEqual(['read'])
    await preset.dispose()
    expect(await visible(agent)).toEqual(['read', 'write'])
  })

  it('refuses to mount outside a preset scope', async () => {
    const ctx = await host(['read'])
    await expect(ctx.plugin(toolScope, { allow: ['read'] })).rejects.toThrow(/mount inside an Agent Preset/)
  })

  it('refuses an empty list entry', async () => {
    const ctx = await host(['read'])
    const preset = presetScope(ctx)
    await expect(preset.ctx.plugin(toolScope, { allow: [''] })).rejects.toThrow(/must not contain an empty string/)
  })

  it('drops a name that its own allow list also keeps', async () => {
    const ctx = await host(['read', 'write', 'bash'])
    const preset = presetScope(ctx)
    await preset.ctx.plugin(toolScope, { allow: ['read', 'write', 'bash'], deny: ['write'] })
    const agent = agentScope(ctx, scopeOf(preset.ctx)!)
    expect(await visible(agent)).toEqual(['bash', 'read'])
  })

  it('warns about an allow name this deployment does not register', async () => {
    const ctx = await host(['read'])
    const warnings: string[] = []
    ctx.logger.warn = (message: string) => { warnings.push(message) }
    const preset = presetScope(ctx)
    await preset.ctx.plugin(toolScope, { allow: ['read', 'absent'] })
    expect(warnings.join('\n')).toMatch(/allow names "absent"/)
  })

  it('refuses overlapping prefix lists', async () => {
    const ctx = await host(['read'])
    const preset = presetScope(ctx)
    await expect(preset.ctx.plugin(toolScope, { allowPrefixes: ['mcp__'], denyPrefixes: ['mcp__fs'] }))
      .rejects.toThrow(/overlaps an allowPrefix/)
  })
})
