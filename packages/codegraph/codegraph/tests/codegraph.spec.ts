import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION, type UserMessage } from '@deepseek-ai/dsh-session'
import { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
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
  }
  const connections: Connection[] = []
  return {
    connections,
    startConnection: vi.fn((_ctx: unknown, config: unknown): FakeHandle => {
      let resolveReady!: (outcome: { error?: unknown }) => void
      const ready = new Promise<{ error?: unknown }>((resolve) => { resolveReady = resolve })
      const handle: FakeHandle = { ready, dispose: vi.fn(async () => {}) }
      connections.push({ config, handle, resolveReady })
      return handle
    }),
    resolveReconnectPolicy: vi.fn(() => ({ enabled: false, initialDelayMs: 0, maxDelayMs: 0, maxAttempts: 1 })),
  }
})

vi.mock('@deepseek-ai/dsh-mcp-client', () => mcpMocks)
vi.mock('@deepseek-ai/dsh-mcp-client/src/connection.ts', () => mcpMocks)

beforeEach(() => {
  mcpMocks.connections.length = 0
  mcpMocks.startConnection.mockClear()
  mcpMocks.resolveReconnectPolicy.mockClear()
})

const testToolSignal = new AbortController().signal

async function tempWorkspace(withIndex: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-codegraph-'))
  if (withIndex) await mkdir(join(dir, '.codegraph'), { recursive: true })
  return dir
}

function stubAgent(cwd: string): Agent {
  const id = SessionId('s1')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd })
  return {
    ctx: new Context(),
    id: SessionId('a1'),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
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
  await ctx.plugin(codegraph, {})
}

async function drivePreStep(ctx: Context, agent: Agent, claimed: UserMessage[] = []): Promise<EnteredPreStep> {
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: claimed, turn: 1, step: 1, signal: testToolSignal },
    async () => ({ kind: 'enter' as const, messages: [] }),
  )
  if (decision.kind !== 'enter') throw new Error('unexpected non-enter pre-step decision')
  return decision
}

function textOf(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')
}

describe('dsh-codegraph', () => {
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
