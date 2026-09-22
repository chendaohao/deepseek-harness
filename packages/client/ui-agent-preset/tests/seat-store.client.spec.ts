/**
 * The hero-chip seat's apply machinery: single-flight coalescing (session
 * creation publishes several list updates in one tick), the send-path
 * pendingApply gate that keeps a first prompt behind a staged pick, and the
 * stage lifecycle the two share.
 */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { AgentPresetSeatController } from '../src/client/seat-store.ts'

/** One dispatched select RPC whose settlement the test controls. */
interface PendingSelect {
  sessionId: SessionId
  agentPreset: string
  resolve(result: unknown): void
  reject(error: unknown): void
}

/** A select double: records every dispatched RPC and settles it on demand. */
function selectRig(): { pending: PendingSelect[]; remote: Pick<ClientRemote, 'agentPresets'> } {
  const pending: PendingSelect[] = []
  const remote = {
    agentPresets: {
      select: (sessionId: SessionId, agentPreset: string) => new Promise((resolve, reject) => {
        pending.push({ sessionId, agentPreset, resolve, reject: reject as (error: unknown) => void })
      }),
    },
  } as unknown as Pick<ClientRemote, 'agentPresets'>
  return { pending, remote }
}

function ok(value: string): unknown {
  return { ok: true as const, value }
}

function err(message: string): unknown {
  return { ok: false as const, error: { code: 'agent-preset-locked', message, details: {} } }
}

type CurrentSession = Pick<SessionSummary, 'id' | 'blank' | 'projectionValues'> | undefined

/** A seat over the rig, reading the given current-session thunk. */
function seat(
  rig: { pending: PendingSelect[]; remote: Pick<ClientRemote, 'agentPresets'> },
  currentSession: () => CurrentSession,
): AgentPresetSeatController {
  const ctx = { remote: rig.remote } as unknown as ClientContext
  return new AgentPresetSeatController(ctx, currentSession)
}

const BLANK_S1: CurrentSession = {
  id: 's1' as SessionId,
  blank: true,
  projectionValues: { agentPreset: 'standard' },
}

describe('the agent-preset seat apply machinery', () => {
  it('coalesces concurrent applies onto one select RPC', async () => {
    const rig = selectRig()
    const controller = seat(rig, () => BLANK_S1)
    controller.stage('minimal')
    const first = controller.apply()
    // The session list publishes several updates in one tick; each fired the
    // list-change applier, and each of those calls must coalesce.
    const second = controller.apply()
    const third = controller.apply()
    expect(rig.pending).toHaveLength(1)
    rig.pending[0]!.resolve(ok('minimal'))
    await Promise.all([first, second, third])
    expect(rig.pending).toHaveLength(1)
  })

  it('pendingApply resolves only after the in-flight apply settles', async () => {
    const rig = selectRig()
    const controller = seat(rig, () => BLANK_S1)
    controller.stage('minimal')
    void controller.apply()
    let settled = false
    const gate = controller.pendingApply().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    rig.pending[0]!.resolve(ok('minimal'))
    await gate
    expect(settled).toBe(true)
  })

  it('applies an unserved stage itself instead of waiting for a list change', async () => {
    const rig = selectRig()
    const controller = seat(rig, () => ({ id: 's1' as SessionId, blank: true }))
    controller.stage('minimal')
    const gate = controller.pendingApply()
    expect(rig.pending).toHaveLength(1)
    expect(rig.pending[0]!.sessionId).toBe('s1')
    expect(rig.pending[0]!.agentPreset).toBe('minimal')
    rig.pending[0]!.resolve(ok('minimal'))
    await gate
    // The stage is spent: the next gate settles without a second RPC.
    await controller.pendingApply()
    expect(rig.pending).toHaveLength(1)
  })

  it('terminates when no session can serve the stage and keeps it for the applier', async () => {
    const rig = selectRig()
    const holder: { current?: CurrentSession } = {}
    const controller = seat(rig, () => holder.current)
    controller.stage('minimal')
    await controller.pendingApply()
    expect(rig.pending).toHaveLength(0)
    // The unservable stage survives for the list-change applier.
    holder.current = { id: 's1' as SessionId, blank: true }
    const applying = controller.apply()
    expect(rig.pending).toHaveLength(1)
    expect(rig.pending[0]!.agentPreset).toBe('minimal')
    rig.pending[0]!.resolve(ok('minimal'))
    await applying
  })

  it('re-checks a stage set while an apply is in flight', async () => {
    const rig = selectRig()
    const controller = seat(rig, () => BLANK_S1)
    controller.stage('minimal')
    const first = controller.apply()
    // The user re-picks mid-flight: the newer stage must survive the first
    // apply's completion and land through the call that waits for it.
    controller.stage('cordis')
    const second = controller.pendingApply()
    rig.pending[0]!.resolve(ok('minimal'))
    await first
    expect(rig.pending).toHaveLength(2)
    expect(rig.pending[1]!.agentPreset).toBe('cordis')
    rig.pending[1]!.resolve(ok('cordis'))
    await second
    expect(controller.store.getSnapshot().current).toBe('cordis')
  })

  it('a refused apply surfaces the refusal cause and drops the stage', async () => {
    const rig = selectRig()
    const controller = seat(rig, () => BLANK_S1)
    controller.stage('minimal')
    const gate = controller.pendingApply()
    rig.pending[0]!.resolve(err('session has already started'))
    await gate
    expect(controller.store.getSnapshot().error).toBe('session has already started')
    expect(controller.store.getSnapshot().busy).toBe(false)
    await controller.pendingApply()
    expect(rig.pending).toHaveLength(1)
  })

  it('a transport failure keeps a newer stage for the next apply', async () => {
    const rig = selectRig()
    const controller = seat(rig, () => BLANK_S1)
    controller.stage('minimal')
    const first = controller.apply()
    controller.stage('cordis')
    rig.pending[0]!.reject(new Error('net down'))
    await first
    // The failed pick surfaced its message; the newer stage survived it.
    expect(controller.store.getSnapshot().error).toBe('net down')
    expect(controller.store.getSnapshot().current).toBe('cordis')
    const second = controller.apply()
    expect(rig.pending).toHaveLength(2)
    expect(rig.pending[1]!.agentPreset).toBe('cordis')
    rig.pending[1]!.resolve(ok('cordis'))
    await second
    expect(controller.store.getSnapshot().current).toBe('cordis')
  })
})
