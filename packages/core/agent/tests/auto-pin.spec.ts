import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'

type Note = [SessionId, 'active' | 'idle']

/** Boot the registry with a recording Workspace-registry double and its note log. */
async function composition() {
  const ctx = new Context()
  const notes: Note[] = []
  const noteSessionActivity = vi.fn((sessionId: SessionId, phase: 'active' | 'idle') => {
    notes.push([sessionId, phase])
    return Promise.resolve()
  })
  ctx.provide('workspaceRegistry', { noteSessionActivity } as never)
  await ctx.plugin(AgentRegistry)
  return { ctx, notes, noteSessionActivity }
}

/** A minimal Agent double: the feed reads only the session. */
function stubAgent(rawId: string, session: Session): Agent {
  return { id: SessionId(rawId), session } as never
}

function emitStatus(ctx: Context, agent: Agent, status: AgentStatus): void {
  agentEvents(ctx, agent).emit('agent/status', { status })
}

/** A header-only Session double for lineage walks. */
function stubSession(rawId: string, header: Record<string, unknown> = {}): Session {
  return { id: SessionId(rawId), header: { id: SessionId(rawId), ...header } } as never
}

describe('Activity automatic-pin feed', () => {
  it('notes activity and idle transitions for a plain Session', async () => {
    const { ctx, notes } = await composition()
    const agent = stubAgent('root', Session.create(SessionId('root')))

    emitStatus(ctx, agent, 'running')
    emitStatus(ctx, agent, 'idle')
    expect(notes).toEqual([[SessionId('root'), 'active'], [SessionId('root'), 'idle']])
  })

  it('attributes a subagent transition to its nearest non-subagent ancestor', async () => {
    const { ctx, notes } = await composition()
    const root = stubSession('root')
    const child = stubSession('child', { origin: 'subagent', parentSession: SessionId('root') })
    const grandchild = stubSession('grandchild', { origin: 'subagent', parentSession: SessionId('child') })
    ctx.provide('sessions', {
      get: (id: SessionId) => ({ child, grandchild, root })[id as 'child' | 'grandchild' | 'root'],
    } as never)

    emitStatus(ctx, stubAgent('grandchild', grandchild), 'running')
    expect(notes).toEqual([[SessionId('root'), 'active']])
  })

  it('skips a transition whose lineage or registry is unavailable', async () => {
    const { ctx, notes, noteSessionActivity } = await composition()
    // No sessions store at all: the parent walk cannot resolve.
    const orphan = stubSession('orphan', { origin: 'subagent', parentSession: SessionId('missing') })
    emitStatus(ctx, stubAgent('orphan', orphan), 'running')
    // A subagent header without a parent reference ends the walk immediately.
    const rootless = stubSession('rootless', { origin: 'subagent' })
    emitStatus(ctx, stubAgent('rootless', rootless), 'running')
    // A lineage that cycles exhausts the depth bound.
    const loop = stubSession('loop', { origin: 'subagent', parentSession: SessionId('loop') })
    ctx.provide('sessions', { get: () => loop } as never)
    emitStatus(ctx, stubAgent('loop', loop), 'running')
    expect(notes).toEqual([])

    // Without a Workspace registry the listener is inert.
    const bare = new Context()
    await bare.plugin(AgentRegistry)
    emitStatus(bare, stubAgent('any', Session.create(SessionId('any'))), 'running')
    expect(noteSessionActivity).not.toHaveBeenCalled()
  })

  it('logs a noting failure instead of throwing into the loop', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', {
      noteSessionActivity: () => Promise.reject(new Error('registry write exploded')),
    } as never)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as never
    await ctx.plugin(AgentRegistry)

    emitStatus(ctx, stubAgent('doomed', Session.create(SessionId('doomed'))), 'running')
    await vi.waitFor(() => {
      expect(warnings.some(line => line.includes('registry write exploded'))).toBe(true)
    })
  })
})
