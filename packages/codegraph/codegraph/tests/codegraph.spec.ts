import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION, type UserMessage } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as codegraph from '@deepseek-ai/dsh-codegraph'

const mcpMocks = vi.hoisted(() => {
  type FakeHandle = {
    ready: Promise<{ error?: unknown }>
    dispose: () => Promise<void>
  }
  type Connection = {
    config: unknown
    handle: FakeHandle
    resolveReady: (outcome: { error?: unknown }) => void
    rejectReady: (error: unknown) => void
  }
  const connections: Connection[] = []
  return {
    connections,
    /** When set, every handle's dispose rejects; read at call time. */
    failDispose: false,
    startConnection: vi.fn((_ctx: unknown, config: unknown): FakeHandle => {
      let resolveReady!: (outcome: { error?: unknown }) => void
      let rejectReady!: (error: unknown) => void
      const ready = new Promise<{ error?: unknown }>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const handle: FakeHandle = {
        ready,
        dispose: vi.fn(async () => {
          if (mcpMocks.failDispose) throw new Error('dispose failed')
        }),
      }
      connections.push({ config, handle, resolveReady, rejectReady })
      return handle
    }),
    resolveReconnectPolicy: vi.fn(() => ({ enabled: false, initialDelayMs: 0, maxDelayMs: 0, maxAttempts: 1 })),
  }
})

vi.mock('@deepseek-ai/dsh-mcp-client', () => mcpMocks)
vi.mock('@deepseek-ai/dsh-mcp-client/src/connection.ts', () => mcpMocks)

beforeEach(() => {
  mcpMocks.connections.length = 0
  mcpMocks.failDispose = false
  mcpMocks.startConnection.mockClear()
  mcpMocks.resolveReconnectPolicy.mockClear()
})

const testToolSignal = new AbortController().signal

async function tempWorkspace(withIndex: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-codegraph-'))
  if (withIndex) await mkdir(join(dir, '.codegraph'), { recursive: true })
  return dir
}

function stubAgent(cwd: string | undefined): Agent {
  const id = SessionId('s1')
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    ...cwd === undefined ? {} : { cwd },
    isSeeded: false,
  })
  return {
    ctx: new Context(),
    id: SessionId('a1'),
    options: {},
    session,
    inbox: {
      nextTurn: [], nextStep: [], clear: () => {}, append: () => {},
      prepend: () => {}, replace: () => false, remove: () => false, splice: () => [],
    },
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

type EnteredPreStep = { kind: 'enter'; messages: UserMessage[] }

async function mount(ctx: Context): Promise<void> {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(codegraph, {})
}

async function drivePreStep(ctx: Context, agent: Agent, claimed: UserMessage[] = []): Promise<EnteredPreStep> {
  const decision = await driveDecision(ctx, agent, claimed, { kind: 'enter' as const, messages: [] })
  if (decision.kind !== 'enter') throw new Error('unexpected non-enter pre-step decision')
  return decision
}

/** Run the real pre-step waterfall with a scripted decision from the listeners below this plugin. */
async function driveDecision(
  ctx: Context,
  agent: Agent,
  claimed: UserMessage[],
  proposed: PreStepDecision,
): Promise<PreStepDecision> {
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: claimed, turn: 1, step: 1, signal: testToolSignal },
    async () => proposed,
  )
}

function textOf(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')
}

describe('dsh-codegraph', () => {
  it('defers activation until the context provides a tools registry', async () => {
    const cwd = await tempWorkspace(true)
    const ctx = new Context()
    await ctx.plugin(codegraph, {})
    const agent = stubAgent(cwd)
    const decision = await drivePreStep(ctx, agent)

    expect(decision.messages.some(message => message.source.kind === codegraph.INSTRUCTION_SOURCE_KIND)).toBe(false)
    expect(mcpMocks.connections.length).toBe(0)
    await ctx.fiber.dispose()
  })

  it('injects the checklist and starts the MCP connection for an indexed workspace', async () => {
    const cwd = await tempWorkspace(true)
    const ctx = new Context()
    await mount(ctx)
    const agent = stubAgent(cwd)
    const decision = await drivePreStep(ctx, agent)

    const checklist = decision.messages.find(message => message.source.kind === codegraph.INSTRUCTION_SOURCE_KIND)
    expect(checklist).toBeDefined()
    const text = textOf(checklist!)
    expect(text).toContain('<!-- CODEGRAPH_START -->')
    expect(text).toContain('<!-- CODEGRAPH_END -->')
    expect(text).toContain('projectPath')

    expect(mcpMocks.connections.length).toBe(1)
    const cfg = mcpMocks.connections[0]!.config as Record<string, unknown>
    expect(cfg.serverName).toBe('codegraph')
    expect(cfg.command).toBe('codegraph')
    expect(cfg.args).toEqual(['serve', '--mcp'])
    expect(cfg.failOnStartupError).toBe(false)

    await ctx.fiber.dispose()
    expect(mcpMocks.connections[0]!.handle.dispose).toHaveBeenCalled()
  })

  it('does nothing for a workspace without an index', async () => {
    const cwd = await tempWorkspace(false)
    const ctx = new Context()
    await mount(ctx)
    const agent = stubAgent(cwd)
    const decision = await drivePreStep(ctx, agent)

    expect(decision.messages.some(message => message.source.kind === codegraph.INSTRUCTION_SOURCE_KIND)).toBe(false)
    expect(mcpMocks.connections.length).toBe(0)
    await ctx.fiber.dispose()
  })

  it('injects the checklist only once per session', async () => {
    const cwd = await tempWorkspace(true)
    const ctx = new Context()
    await mount(ctx)
    const agent = stubAgent(cwd)

    const first = await drivePreStep(ctx, agent)
    const checklist = first.messages.find(message => message.source.kind === codegraph.INSTRUCTION_SOURCE_KIND)!
    agent.session.append('user/message', checklist, { surfaceOp: 'append' })

    const second = await drivePreStep(ctx, agent, first.messages)
    const count = second.messages.filter(message => message.source.kind === codegraph.INSTRUCTION_SOURCE_KIND).length
    expect(count).toBe(0)
    expect(mcpMocks.connections.length).toBe(1)
    await ctx.fiber.dispose()
  })

  it('keeps serving when the MCP connection fails and disposes the handle on teardown', async () => {
    const cwd = await tempWorkspace(true)
    const ctx = new Context()
    await mount(ctx)
    const agent = stubAgent(cwd)

    const first = await drivePreStep(ctx, agent)
    const checklist = first.messages.find(message => message.source.kind === codegraph.INSTRUCTION_SOURCE_KIND)!
    agent.session.append('user/message', checklist, { surfaceOp: 'append' })
    mcpMocks.connections[0]!.resolveReady({ error: new Error('boom') })
    await new Promise(resolve => setTimeout(resolve, 10))

    const second = await drivePreStep(ctx, agent)
    expect(second.messages.some(message => message.source.kind === codegraph.INSTRUCTION_SOURCE_KIND)).toBe(false)
    expect(mcpMocks.connections.length).toBe(1)

    await ctx.fiber.dispose()
    expect(mcpMocks.connections[0]!.handle.dispose).toHaveBeenCalled()
  })

  it('keeps serving when the connection readiness rejects outright', async () => {
    const cwd = await tempWorkspace(true)
    const ctx = new Context()
    await mount(ctx)
    const firstAgent = stubAgent(cwd)

    const first = await drivePreStep(ctx, firstAgent)
    const checklist = first.messages.find(message => message.source.kind === codegraph.INSTRUCTION_SOURCE_KIND)!
    firstAgent.session.append('user/message', checklist, { surfaceOp: 'append' })
    // A readiness that rejects rather than resolving with an error: the
    // supervisor must record it instead of leaving an unhandled rejection.
    mcpMocks.connections[0]!.rejectReady(new Error('transport down'))
    await new Promise(resolve => setTimeout(resolve, 10))

    const second = await drivePreStep(ctx, firstAgent)
    expect(second.messages.some(message => message.source.kind === codegraph.INSTRUCTION_SOURCE_KIND)).toBe(false)

    // The recorded failure lets the next session's first pre-step restart it.
    await drivePreStep(ctx, stubAgent(cwd))
    expect(mcpMocks.connections.length).toBe(2)
    await ctx.fiber.dispose()
  })

  it('leaves a proposal that already carries the checklist payload alone', async () => {
    const cwd = await tempWorkspace(true)
    const ctx = new Context()
    await mount(ctx)
    const agent = stubAgent(cwd)

    // The checklist is not in this session's history, but a listener below
    // this plugin already proposed exactly that payload for this step. A
    // second copy would duplicate it, so the decision passes through.
    const proposed = await drivePreStep(ctx, agent)
    const checklist = proposed.messages.find(message => message.source.kind === codegraph.INSTRUCTION_SOURCE_KIND)!
    const decision = await driveDecision(ctx, agent, [], { kind: 'enter', messages: [checklist] })

    expect(decision).toEqual({ kind: 'enter', messages: [checklist] })
    await ctx.fiber.dispose()
  })

  it('appends the checklist after the last message the caller already claimed', async () => {
    const cwd = await tempWorkspace(true)
    const ctx = new Context()
    await mount(ctx)
    const agent = stubAgent(cwd)

    const proposed = await drivePreStep(ctx, agent)
    const checklist = proposed.messages.find(message => message.source.kind === codegraph.INSTRUCTION_SOURCE_KIND)!
    // A listener below this plugin proposed other content for the same step.
    const other: UserMessage = { ...checklist, id: MessageId('other-message'), content: [{ type: 'text', text: 'other' }] }
    // The caller already claimed that message, so the checklist lands after it
    // rather than ahead of content belonging to the same step.
    const decision = await driveDecision(ctx, agent, [other], { kind: 'enter', messages: [other] })

    if (decision.kind !== 'enter') throw new Error('unexpected non-enter pre-step decision')
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[0]?.id).toBe('other-message')
    expect(decision.messages[1]).toMatchObject({ source: { kind: codegraph.INSTRUCTION_SOURCE_KIND } })
    await ctx.fiber.dispose()
  })

  it('leaves a rejecting decision alone for an indexed workspace', async () => {
    const cwd = await tempWorkspace(true)
    const ctx = new Context()
    await mount(ctx)
    const agent = stubAgent(cwd)

    const decision = await driveDecision(ctx, agent, [], { kind: 'reject' })

    // The connection still comes up: the checklist gate is about the proposed
    // step, not about whether the server is worth starting.
    expect(decision).toEqual({ kind: 'reject' })
    expect(mcpMocks.connections.length).toBe(1)
    await ctx.fiber.dispose()
  })

  it('throws the abort reason rather than reporting an unindexed workspace', async () => {
    const cwd = await tempWorkspace(true)
    const ctx = new Context()
    await mount(ctx)
    const agent = stubAgent(cwd)
    // The signal aborts while the index probe is in flight, so the failure is
    // an aborted read rather than a missing directory.
    const controller = new AbortController()
    controller.abort(new Error('pre-step aborted'))

    await expect(agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: controller.signal },
      async () => ({ kind: 'enter' as const, messages: [] }),
    )).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it('falls back to the process working directory when the session records none', async () => {
    // The fallback reads process.cwd(), a process-global: point it at an
    // indexed temp workspace for the probe and restore it before returning, so
    // the test does not depend on the checkout carrying an index. Tests in a
    // file run sequentially, so the swap cannot race a sibling.
    const indexed = await tempWorkspace(true)
    const previous = process.cwd()
    process.chdir(indexed)
    try {
      const ctx = new Context()
      await mount(ctx)
      const agent = stubAgent(undefined)

      const decision = await drivePreStep(ctx, agent)

      expect(decision.messages.some(message => message.source.kind === codegraph.INSTRUCTION_SOURCE_KIND)).toBe(true)
      expect(mcpMocks.connections.length).toBe(1)
      await ctx.fiber.dispose()
    } finally {
      process.chdir(previous)
    }
  })

  it('keeps the connection when readiness settles without an error', async () => {
    const cwd = await tempWorkspace(true)
    const ctx = new Context()
    await mount(ctx)
    const agent = stubAgent(cwd)

    await drivePreStep(ctx, agent)
    mcpMocks.connections[0]!.resolveReady({})
    await new Promise(resolve => setTimeout(resolve, 10))

    // A clean readiness records no failure, so the next session's first
    // pre-step reuses this connection instead of restarting it.
    await drivePreStep(ctx, stubAgent(cwd))
    expect(mcpMocks.connections.length).toBe(1)
    await ctx.fiber.dispose()
  })

  it('propagates the probe failure when the signal aborts while it is in flight', async () => {
    const cwd = await tempWorkspace(false)
    const ctx = new Context()
    await mount(ctx)
    const agent = stubAgent(cwd)

    // The signal reports itself aborted once the probe has already failed, the
    // shape a real abort produces when it lands mid-read. The plugin then owes
    // the caller that failure, not a quiet "unindexed workspace" answer.
    // The stub stays typed as its own mutable pair: `AbortSignal.aborted` is
    // readonly, so the handler below has to flip this object, not a signal.
    const signal = { aborted: false, throwIfAborted(): void {} }
    const decision = agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: signal as AbortSignal },
      async () => { signal.aborted = true; return { kind: 'enter' as const, messages: [] } },
    )

    await expect(decision).rejects.toThrow()
    expect(mcpMocks.connections.length).toBe(0)
    await ctx.fiber.dispose()
  })

  it('fills every unset option when apply is called without schema resolution', async () => {
    const cwd = await tempWorkspace(true)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // A direct apply() bypasses Schemastery, so each optional field arrives
    // undefined and the plugin's own defaults have to supply it.
    ctx.inject(['tools'], (toolsCtx: Context) => { codegraph.apply(toolsCtx, {}) })
    await ctx.fiber.await()

    await drivePreStep(ctx, stubAgent(cwd))

    const cfg = mcpMocks.connections[0]!.config as Record<string, unknown>
    expect(cfg.command).toBe('codegraph')
    expect(cfg.args).toEqual(['serve', '--mcp'])
    expect(cfg.toolCallTimeoutMs).toBe(120_000)
    await ctx.fiber.dispose()
  })

  it('ignores a history message from another instructions source', async () => {
    const cwd = await tempWorkspace(true)
    const ctx = new Context()
    await mount(ctx)
    const agent = stubAgent(cwd)

    const proposed = await drivePreStep(ctx, agent)
    const checklist = proposed.messages.find(message => message.source.kind === codegraph.INSTRUCTION_SOURCE_KIND)!
    // Another instruction source already sits in this session's surface. It is
    // not this plugin's checklist, so the checklist is still injected.
    agent.session.append('user/message', {
      ...checklist,
      id: MessageId('other-instructions'),
      source: { kind: 'skill-instructions', form: 'instructions' } as never,
    }, { surfaceOp: 'append' })

    const second = await drivePreStep(ctx, agent)
    expect(second.messages.some(message => message.source.kind === codegraph.INSTRUCTION_SOURCE_KIND)).toBe(true)
    await ctx.fiber.dispose()
  })

  it('swallows a rejected dispose when it restarts a failed connection', async () => {
    const cwd = await tempWorkspace(true)
    const ctx = new Context()
    await mount(ctx)
    const agent = stubAgent(cwd)

    await drivePreStep(ctx, agent)
    const dead = mcpMocks.connections[0]!
    mcpMocks.failDispose = true
    dead.resolveReady({ error: new Error('boom') })
    await new Promise(resolve => setTimeout(resolve, 10))

    // The restart discards the dead handle while its dispose still rejects:
    // that rejection must not become an unhandled one that takes the process
    // down, and the fresh connection still has to come up.
    await drivePreStep(ctx, stubAgent(cwd))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(mcpMocks.connections.length).toBe(2)
    expect(dead.handle.dispose).toHaveBeenCalled()
    mcpMocks.failDispose = false
    await ctx.fiber.dispose()
  })

  it('mounts nothing when the plugin is disabled', async () => {
    const cwd = await tempWorkspace(true)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(codegraph, { enabled: false })
    const agent = stubAgent(cwd)

    const decision = await drivePreStep(ctx, agent)

    expect(decision.messages).toHaveLength(0)
    expect(mcpMocks.connections.length).toBe(0)
    await ctx.fiber.dispose()
  })

  it('restarts a failed connection on the next session\'s first pre-step', async () => {
    const cwd = await tempWorkspace(true)
    const ctx = new Context()
    await mount(ctx)

    const firstAgent = stubAgent(cwd)
    await drivePreStep(ctx, firstAgent)
    mcpMocks.connections[0]!.resolveReady({ error: new Error('boom') })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(mcpMocks.connections.length).toBe(1)

    const secondAgent = stubAgent(cwd)
    await drivePreStep(ctx, secondAgent)
    expect(mcpMocks.connections.length).toBe(2)
    expect(mcpMocks.connections[0]!.handle.dispose).toHaveBeenCalled()
    expect(mcpMocks.connections[1]!.config).toMatchObject({ serverName: 'codegraph' })

    await ctx.fiber.dispose()
    expect(mcpMocks.connections[1]!.handle.dispose).toHaveBeenCalled()
  })
})
