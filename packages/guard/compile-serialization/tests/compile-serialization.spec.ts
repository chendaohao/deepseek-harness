/**
 * Unit coverage for @deepseek-ai/dsh-compile-serialization: the default pattern
 * table, the denial a concurrent compile command receives, the release points
 * that clear the in-flight registration, fail-loud configuration, and
 * cross-session serialization through the process-global table.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as compileSerialization from '@deepseek-ai/dsh-compile-serialization'

const testSignal = new AbortController().signal

/**
 * Drop the process-global in-flight table between tests. The table is keyed by
 * `Symbol.for` on purpose (copies share it), so a test that leaves a
 * registration behind would deny the next test's first compile command. Each
 * test mounts fresh contexts, which re-read the global on apply.
 */
afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('dsh.guard.compile-serialization.in-flight'))
})

/** Mount the registry plus the guard on a fresh context. */
async function setup(config: Parameters<typeof compileSerialization.apply>[1] = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(compileSerialization, config)
  return ctx
}

/**
 * A `command` tool that blocks only its FIRST selected command, so the one
 * compile command under test stays in flight while every later call — the
 * denied concurrent attempt, a call admitted after a release, and a non-compile
 * command — settles at once.
 * @param block - selects the commands eligible to be the single blocked call.
 * @param name - registered tool name.
 * @returns The definition plus the release and first-blocked-call signals.
 */
function commandTool(block: (command: string) => boolean, name = 'bash'): {
  definition: ToolDefinition
  release: () => void
  started: Promise<void>
} {
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  let blocked = false
  return {
    release: () => { releaseGate() },
    started,
    definition: {
      name,
      description: `command tool ${name}`,
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      async execute(args): Promise<string> {
        const command: unknown = typeof args === 'object' && args !== null ? Reflect.get(args, 'command') : undefined
        if (!blocked && typeof command === 'string' && block(command)) {
          blocked = true
          markStarted()
          await gate
        }
        return 'done'
      },
    },
  }
}

/** A tool that settles immediately. */
function instantTool(name = 'bash'): ToolDefinition {
  return {
    name,
    description: `instant ${name}`,
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
    execute: (): Promise<string> => Promise.resolve('done'),
  }
}

/** Run one call and return its first text block. */
async function run(ctx: Context, name: string, command: unknown, agent?: Agent, signal = testSignal): Promise<string> {
  const result = await ctx.tools.execute({
    callId: ToolCallId('c1'),
    name,
    arguments: { command },
    signal,
    ...agent !== undefined ? { agent } : {},
  })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

/** A minimal agent identity; the guard reads only its id. */
function agentOf(id: string): Agent {
  return { id: id as SessionId } as Agent
}

/** Run one call with raw arguments (not wrapped in a `command` property). */
async function runRaw(ctx: Context, name: string, args: unknown): Promise<string> {
  const result = await ctx.tools.execute({
    callId: ToolCallId('c1'),
    name,
    arguments: args,
    signal: testSignal,
  })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

describe('compile-serialization default pattern table', () => {
  it.each([
    'pnpm install',
    'pnpm run build',
    'npm ci',
    'yarn add lodash',
    'pnpm typecheck',
    'pnpm run test:coverage',
    'tsc -b tsconfig.host.json',
    'vitest run --coverage',
    'vite build',
  ])('treats %s as compile-class and denies it while another runs', async (command) => {
    const ctx = await setup()
    const holder = commandTool(text => text === 'pnpm install')
    ctx.tools.register(holder.definition)
    const first = run(ctx, 'bash', 'pnpm install')
    await holder.started
    expect(await run(ctx, 'bash', command)).toContain('another compile-class command is still running')
    holder.release()
    await first
  })

  it.each([
    'git status',
    'ls packages',
    'pnpm test',
    'pnpm lint',
    'vitest run',
    'tsc --noEmit',
    'echo install',
  ])('leaves %s alone while a compile command is in flight', async (command) => {
    const ctx = await setup()
    const holder = commandTool(text => text === 'pnpm install')
    ctx.tools.register(holder.definition)
    const first = run(ctx, 'bash', 'pnpm install')
    await holder.started
    expect(await run(ctx, 'bash', command)).toBe('done')
    holder.release()
    await first
  })

  it('ignores a call whose arguments carry no command string', async () => {
    const ctx = await setup()
    const holder = commandTool(text => text === 'pnpm install')
    ctx.tools.register(holder.definition)
    const first = run(ctx, 'bash', 'pnpm install')
    await holder.started
    expect(await run(ctx, 'bash', { nested: 'pnpm install' })).toBe('done')
    expect(await run(ctx, 'bash', '')).toBe('done')
    holder.release()
    await first
  })

  it('ignores a call whose arguments are not an object at all', async () => {
    const ctx = await setup()
    ctx.tools.register(instantTool())
    expect(await runRaw(ctx, 'bash', null)).toBe('done')
    expect(await runRaw(ctx, 'bash', 'pnpm install')).toBe('done')
    expect(await run(ctx, 'bash', 'pnpm install')).toBe('done')
  })

  it('releases nothing when a result arrives with no in-flight registration', async () => {
    const ctx = await setup()
    ctx.tools.register(instantTool())
    expect(await run(ctx, 'bash', 'git status')).toBe('done')
  })

  it('replaces an unrelated value left on the process-global key', async () => {
    Reflect.set(globalThis, Symbol.for('dsh.guard.compile-serialization.in-flight'), {})
    const ctx = await setup()
    const holder = commandTool(text => text === 'pnpm install')
    ctx.tools.register(holder.definition)
    const first = run(ctx, 'bash', 'pnpm install')
    await holder.started
    expect(await run(ctx, 'bash', 'pnpm install')).toContain('another compile-class command')
    holder.release()
    await first
  })

  it('ignores a tool outside the configured toolNames', async () => {
    const ctx = await setup()
    const holder = commandTool(text => text === 'pnpm install')
    ctx.tools.register(holder.definition)
    ctx.tools.register(instantTool('other'))
    const first = run(ctx, 'bash', 'pnpm install')
    await holder.started
    expect(await run(ctx, 'other', 'pnpm install')).toBe('done')
    holder.release()
    await first
  })
})

describe('compile-serialization denial and release', () => {
  it('names the running tool, its session, and its command in the denial', async () => {
    const ctx = await setup()
    const holder = commandTool(text => text === 'pnpm run build')
    ctx.tools.register(holder.definition)
    const first = run(ctx, 'bash', 'pnpm run build', agentOf('parent'))
    await holder.started
    const denial = await run(ctx, 'bash', 'pnpm install', agentOf('child'))
    expect(denial).toContain('another compile-class command is still running')
    expect(denial).toContain('bash in session parent')
    expect(denial).toContain('pnpm run build')
    expect(denial).toContain('retry this command after that one finishes')
    holder.release()
    await first
  })

  it('truncates the quoted command to commandPreviewChars without affecting matching', async () => {
    const ctx = await setup({ commandPreviewChars: 8 })
    const holder = commandTool(text => text === 'pnpm run build --verbose')
    ctx.tools.register(holder.definition)
    const first = run(ctx, 'bash', 'pnpm run build --verbose')
    await holder.started
    const denial = await run(ctx, 'bash', 'pnpm install')
    expect(denial).toContain('"pnpm run… (+16 more chars)"')
    holder.release()
    await first
  })

  it('clears the registration when the admitted command finishes', async () => {
    const ctx = await setup()
    const holder = commandTool(text => text === 'pnpm install')
    ctx.tools.register(holder.definition)
    const first = run(ctx, 'bash', 'pnpm install')
    await holder.started
    expect(await run(ctx, 'bash', 'pnpm install')).toContain('another compile-class command')
    holder.release()
    expect(await first).toBe('done')
    expect(await run(ctx, 'bash', 'pnpm install')).toBe('done')
  })

  it('clears the registration when the admitted command throws', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...instantTool(),
      execute: (): Promise<string> => Promise.reject(new Error('build failed')),
    })
    expect(await run(ctx, 'bash', 'pnpm install')).toContain('build failed')
    expect(await run(ctx, 'bash', 'pnpm install')).toContain('build failed')
  })

  it('releases the slot when the caller signal aborts instead of leaking it', async () => {
    const ctx = await setup()
    const holder = commandTool(text => text === 'pnpm install')
    ctx.tools.register(holder.definition)
    const controller = new AbortController()
    const first = run(ctx, 'bash', 'pnpm install', undefined, controller.signal)
    await holder.started
    expect(await run(ctx, 'bash', 'pnpm install')).toContain('another compile-class command')
    controller.abort()
    holder.release()
    await first
    // The aborted holder is reclaimable at once, and its own result also releases.
    expect(await run(ctx, 'bash', 'pnpm install')).toBe('done')
  })

  it('releases a registration that outlived the lease timeout', async () => {
    const ctx = await setup({ leaseTimeoutMs: 1 })
    const holder = commandTool(text => text === 'pnpm install')
    ctx.tools.register(holder.definition)
    const first = run(ctx, 'bash', 'pnpm install')
    await holder.started
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(await run(ctx, 'bash', 'pnpm install')).toBe('done')
    holder.release()
    await first
  })

  it('releases the slot when the plugin fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const holder = commandTool(text => text === 'pnpm install')
    ctx.tools.register(holder.definition)
    const fiber = await ctx.plugin(compileSerialization, {})
    const first = run(ctx, 'bash', 'pnpm install')
    await holder.started
    await fiber.dispose()
    expect(await run(ctx, 'bash', 'pnpm install')).toBe('done')
    holder.release()
    await first
  })
})

describe('compile-serialization across sessions', () => {
  it('serializes two independent Context roots through the process-global table', async () => {
    const parentCtx = await setup()
    const childCtx = await setup()
    const holder = commandTool(text => text === 'pnpm run build')
    parentCtx.tools.register(holder.definition)
    childCtx.tools.register(holder.definition)
    const first = run(parentCtx, 'bash', 'pnpm run build', agentOf('parent'))
    await holder.started
    const denial = await run(childCtx, 'bash', 'pnpm install', agentOf('child'))
    expect(denial).toContain('another compile-class command is still running')
    expect(denial).toContain('bash in session parent')
    holder.release()
    await first
    expect(await run(childCtx, 'bash', 'pnpm install', agentOf('child'))).toBe('done')
  })

  it('serializes two agents on one context (a parent and its delegated child)', async () => {
    const ctx = await setup()
    const holder = commandTool(text => text === 'pnpm install')
    ctx.tools.register(holder.definition)
    const first = run(ctx, 'bash', 'pnpm install', agentOf('parent'))
    await holder.started
    expect(await run(ctx, 'bash', 'pnpm run build', agentOf('child'))).toContain('session parent')
    holder.release()
    await first
  })
})

describe('compile-serialization configuration (fail loud)', () => {
  it('rejects an empty toolNames list', async () => {
    await expect(setup({ toolNames: [] })).rejects.toThrow(/toolNames/)
  })

  it('rejects an empty command pattern', async () => {
    await expect(setup({ commandPatterns: [''] })).rejects.toThrow(/empty pattern/)
  })

  it('rejects an uncompilable command pattern', async () => {
    await expect(setup({ commandPatterns: ['['] })).rejects.toThrow(/invalid commandPatterns entry/)
  })

  it('rejects a non-positive commandPreviewChars', async () => {
    await expect(setup({ commandPreviewChars: 0 })).rejects.toThrow()
  })

  it('rejects a non-positive leaseTimeoutMs', async () => {
    await expect(setup({ leaseTimeoutMs: 0 })).rejects.toThrow()
  })

  it('honors a custom pattern and tool list instead of the defaults', async () => {
    const ctx = await setup({ commandPatterns: ['make\\b'], toolNames: ['make'] })
    const holder = commandTool(text => text === 'make all', 'make')
    ctx.tools.register(holder.definition)
    ctx.tools.register(instantTool('bash'))
    const first = run(ctx, 'make', 'make all')
    await holder.started
    expect(await run(ctx, 'make', 'make test')).toContain('another compile-class command')
    // The default table no longer applies to a tool outside toolNames.
    expect(await run(ctx, 'bash', 'pnpm install')).toBe('done')
    holder.release()
    await first
  })
})

describe('dsh-compile-serialization real-load-path guard', () => {
  it('has no default export and keeps name/inject through unwrapExports', () => {
    expect('default' in compileSerialization).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(compileSerialization) as Record<string, unknown>
    expect(unwrapped).toBe(compileSerialization)
    expect(unwrapped.name).toBe('compile-serialization')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over ctx.tools through the unwrapped module and denies a concurrent command', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const holder = commandTool(text => text === 'pnpm install')
    ctx.tools.register(holder.definition)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(compileSerialization) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped, {})
    const first = run(ctx, 'bash', 'pnpm install')
    await holder.started
    expect(await run(ctx, 'bash', 'pnpm install')).toContain('another compile-class command is still running')
    holder.release()
    await first
    await fiber.dispose()
  })
})

describe('compile-serialization call shape', () => {
  it('accepts a caller-owned execution input without an agent', async () => {
    const ctx = await setup()
    ctx.tools.register(instantTool())
    const input: ToolExecutionInput = {
      callId: ToolCallId('c1'),
      name: 'bash',
      arguments: { command: 'pnpm install' },
      signal: testSignal,
    }
    expect((await ctx.tools.execute(input)).isError).toBe(false)
  })
})
