/**
 * The hero-chip seat's apply machinery: single-flight coalescing (session
 * creation publishes several list updates in one tick), the send-path
 * pendingApply gate that keeps a first prompt behind a staged pick, and the
 * stage lifecycle the two share.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { AgentPresetSeatController, type PresetCompanion } from '../src/client/seat-store.ts'

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
  } as Pick<ClientRemote, 'agentPresets'>
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
  // The controller reads the shared Developer-tools preference to decide
  // whether a stage is still servable; these cases all run with it enabled.
  const configForms = { developerTools: { enabled: { getSnapshot: () => true } } }
  const ctx = { remote: rig.remote, configForms } as object as ClientContext
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

  it('keeps the flight closed while the prior selection publishes its final busy state', async () => {
    const rig = selectRig()
    const controller = seat(rig, () => BLANK_S1)
    controller.stage('minimal')
    let reentered: ReturnType<AgentPresetSeatController['apply']> | undefined
    const stop = controller.store.subscribe(() => {
      if (rig.pending.length !== 1 || controller.store.getSnapshot().busy || reentered !== undefined) return
      controller.stage('cordis')
      reentered = controller.apply()
    })

    const first = controller.apply()
    rig.pending[0]!.resolve(ok('minimal'))
    await expect(first).resolves.toEqual({ kind: 'applied' })

    expect(rig.pending).toHaveLength(1)
    await expect(reentered).resolves.toEqual({ kind: 'unchanged' })
    stop()
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

  it('the gate reports the settled apply outcome instead of only resolving', async () => {
    const rig = selectRig()
    const controller = seat(rig, () => BLANK_S1)
    controller.stage('minimal')
    const applied = controller.pendingApply()
    rig.pending[0]!.resolve(ok('minimal'))
    await expect(applied).resolves.toEqual({ kind: 'applied' })
    // With no stage left, the gate settles on the last outcome it observed.
    await expect(controller.pendingApply()).resolves.toEqual({ kind: 'applied' })
  })

  it('the gate reports a refused apply so the send path can stop', async () => {
    const rig = selectRig()
    const controller = seat(rig, () => BLANK_S1)
    controller.stage('minimal')
    const refused = controller.pendingApply()
    rig.pending[0]!.resolve(err('session has already started'))
    await expect(refused).resolves.toEqual({ kind: 'refused', reason: 'session has already started' })
  })

  it('the gate retains a refusal from an apply that no gate caller awaited', async () => {
    const rig = selectRig()
    const controller = seat(rig, () => BLANK_S1)
    controller.stage('minimal')
    const applying = controller.apply()
    rig.pending[0]!.resolve(err('session has already started'))
    await expect(applying).resolves.toEqual({ kind: 'refused', reason: 'session has already started' })

    await expect(controller.pendingApply()).resolves.toEqual({ kind: 'refused', reason: 'session has already started' })
  })

  it('a successful replacement clears the refusal an earlier gate observed', async () => {
    const rig = selectRig()
    const controller = seat(rig, () => BLANK_S1)
    controller.stage('minimal')
    const refused = controller.pendingApply()
    rig.pending[0]!.resolve(err('selection refused'))
    await expect(refused).resolves.toEqual({ kind: 'refused', reason: 'selection refused' })

    const replacing = controller.select('cordis')
    rig.pending[1]!.resolve(ok('cordis'))
    await expect(replacing).resolves.toEqual({ kind: 'applied' })
    await expect(controller.pendingApply()).resolves.toEqual({ kind: 'applied' })
  })

  it('the gate of an idle seat reports unchanged', async () => {
    const rig = selectRig()
    const controller = seat(rig, () => undefined)
    await expect(controller.pendingApply()).resolves.toEqual({ kind: 'unchanged' })
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
    // The refusal carries the rejected preset so the chip's Toast can name it.
    expect(controller.store.getSnapshot().error).toEqual({
      preset: { id: 'minimal' }, reason: 'session has already started',
    })
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
    // The failed pick surfaced its message against the preset it named; the
    // newer stage survived it.
    expect(controller.store.getSnapshot().error).toEqual({ preset: { id: 'minimal' }, reason: 'net down' })
    expect(controller.store.getSnapshot().current).toBe('cordis')
    const second = controller.apply()
    expect(rig.pending).toHaveLength(2)
    expect(rig.pending[1]!.agentPreset).toBe('cordis')
    rig.pending[1]!.resolve(ok('cordis'))
    await second
    expect(controller.store.getSnapshot().current).toBe('cordis')
  })
})

/**
 * The companion hook: a plugin whose per-session choice has to land alongside
 * the composition. The crew model combination rides it.
 */
describe('the preset companion hook', () => {
  /** A seat whose single companion records every composition it is handed. */
  function companionSeat(currentSession: () => CurrentSession, companion: PresetCompanion, others: readonly PresetCompanion[] = []) {
    const rig = selectRig()
    const configForms = { developerTools: { enabled: { getSnapshot: () => true } } }
    const ctx = { remote: rig.remote, configForms } as object as ClientContext
    const controller = new AgentPresetSeatController(ctx, currentSession, undefined, [companion, ...others])
    return { controller, rig }
  }

  it('records the companion choice after the composition lands', async () => {
    const seen: string[] = []
    const { controller, rig } = companionSeat(() => BLANK_S1, {
      afterApply: async (_sessionId, presetId) => { seen.push(presetId); return undefined },
    })
    controller.stage('crew')
    const applying = controller.apply()
    rig.pending[0]!.resolve(ok('crew'))
    expect(await applying).toEqual({ kind: 'applied' })
    expect(seen).toEqual(['crew'])
  })

  it('records the companion choice on a blank session already running that composition', async () => {
    const seen: string[] = []
    const alreadyCrew: CurrentSession = {
      id: 's1' as SessionId, blank: true, projectionValues: { agentPreset: 'crew' },
    }
    const { controller, rig } = companionSeat(() => alreadyCrew, {
      afterApply: async (_sessionId, presetId) => { seen.push(presetId); return undefined },
    })
    controller.stage('crew')
    // No select is needed — the session already runs crew — but the companion
    // still has to record its own choice, or the session keeps the role defaults.
    expect(await controller.apply()).toEqual({ kind: 'applied' })
    expect(rig.pending).toHaveLength(0)
    expect(seen).toEqual(['crew'])
  })

  it('single-flights the companion on a blank session already running that composition', async () => {
    const companionGate = Promise.withResolvers<undefined>()
    const afterApply = vi.fn(async () => {
      await companionGate.promise
      return undefined
    })
    const alreadyCrew: CurrentSession = {
      id: 's1' as SessionId, blank: true, projectionValues: { agentPreset: 'crew' },
    }
    const { controller, rig } = companionSeat(() => alreadyCrew, { afterApply })
    controller.stage('crew')

    const first = controller.apply()
    const second = controller.apply()

    expect(afterApply).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().busy).toBe(true)
    expect(rig.pending).toHaveLength(0)
    companionGate.resolve(undefined)
    await expect(first).resolves.toEqual({ kind: 'applied' })
    await expect(second).resolves.toEqual({ kind: 'unchanged' })
    expect(controller.store.getSnapshot().busy).toBe(false)
    await expect(controller.pendingApply()).resolves.toEqual({ kind: 'applied' })
    expect(afterApply).toHaveBeenCalledOnce()
  })

  it('runs send preparation on the current blank composition without replaying afterApply', async () => {
    const alreadyCrew: CurrentSession = {
      id: 's1' as SessionId, blank: true, projectionValues: { agentPreset: 'crew' },
    }
    const afterApply = vi.fn(async (): Promise<string | undefined> => undefined)
    const beforeSend = vi.fn(async (): Promise<string | undefined> => undefined)
    const { controller, rig } = companionSeat(() => alreadyCrew, { afterApply, beforeSend }, [
      { afterApply: async () => undefined },
    ])

    await expect(controller.pendingApply()).resolves.toEqual({ kind: 'applied' })

    expect(beforeSend).toHaveBeenCalledExactlyOnceWith('s1', 'crew')
    expect(afterApply).not.toHaveBeenCalled()
    expect(rig.pending).toHaveLength(0)
    expect(controller.store.getSnapshot().busy).toBe(false)
  })

  it('returns a send-preparation refusal and does not retry it behind the next send', async () => {
    const alreadyCrew: CurrentSession = {
      id: 's1' as SessionId, blank: true, projectionValues: { agentPreset: 'crew' },
    }
    const beforeSend = vi.fn(async (): Promise<string | undefined> => 'routes refused')
    const { controller } = companionSeat(() => alreadyCrew, {
      afterApply: async () => undefined, beforeSend,
    })

    await expect(controller.pendingApply()).resolves.toEqual({ kind: 'refused', reason: 'routes refused' })
    await expect(controller.pendingApply()).resolves.toEqual({ kind: 'refused', reason: 'routes refused' })
    expect(beforeSend).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot()).toMatchObject({
      busy: false, error: { preset: { id: 'crew' }, reason: 'routes refused' },
    })
  })

  it('does not send-prepare over an existing companion refusal', async () => {
    const alreadyCrew: CurrentSession = {
      id: 's1' as SessionId, blank: true, projectionValues: { agentPreset: 'crew' },
    }
    const beforeSend = vi.fn(async (): Promise<string | undefined> => undefined)
    const { controller } = companionSeat(() => alreadyCrew, {
      afterApply: async () => 'unknown model', beforeSend,
    })

    await expect(controller.select('crew')).resolves.toEqual({ kind: 'refused', reason: 'unknown model' })
    await expect(controller.pendingApply()).resolves.toEqual({ kind: 'refused', reason: 'unknown model' })
    expect(beforeSend).not.toHaveBeenCalled()
  })

  it('keeps the send gate open when a companion reports a notice without refusing', async () => {
    // The crew combination picker reports a session that already runs another
    // combination in its own store and resolves without a refusal: the session
    // holds a valid route set, so the first prompt must still leave.
    const alreadyCrew: CurrentSession = {
      id: 's1' as SessionId, blank: true, projectionValues: { agentPreset: 'crew' },
    }
    const notice = vi.fn()
    const { controller } = companionSeat(() => alreadyCrew, {
      afterApply: async () => { notice(); return undefined },
      beforeSend: async () => { notice(); return undefined },
    })

    await expect(controller.select('crew')).resolves.toEqual({ kind: 'applied' })
    await expect(controller.pendingApply()).resolves.toEqual({ kind: 'applied' })
    expect(notice).toHaveBeenCalledTimes(2)
  })

  it('holds the send gate open until the companion choice lands', async () => {
    const landed = Promise.withResolvers<undefined>()
    let recorded = false
    const { controller, rig } = companionSeat(() => BLANK_S1, {
      afterApply: async () => { await landed.promise; recorded = true; return undefined },
    })
    controller.stage('crew')
    const applying = controller.apply()
    rig.pending[0]!.resolve(ok('crew'))
    let gateSettled = false
    const gate = controller.pendingApply().then(() => { gateSettled = true })
    await Promise.resolve()
    // The first prompt must not leave before the routes are on the session.
    expect(gateSettled).toBe(false)
    landed.resolve(undefined)
    await gate
    await applying
    expect(recorded).toBe(true)
    expect(gateSettled).toBe(true)
  })

  it('surfaces a companion refusal against the composition', async () => {
    const { controller, rig } = companionSeat(() => BLANK_S1, {
      afterApply: async () => 'unknown model',
    })
    controller.stage('crew')
    const applying = controller.apply()
    rig.pending[0]!.resolve(ok('crew'))
    expect(await applying).toEqual({ kind: 'refused', reason: 'unknown model' })
    expect(controller.store.getSnapshot().error).toEqual({ preset: { id: 'crew' }, reason: 'unknown model' })
  })

  it('lets one successful companion retry replace its earlier refusal', async () => {
    const alreadyCrew: CurrentSession = {
      id: 's1' as SessionId, blank: true, projectionValues: { agentPreset: 'crew' },
    }
    const afterApply = vi.fn(async (): Promise<string | undefined> => undefined)
      .mockResolvedValueOnce('unknown model')
      .mockResolvedValueOnce(undefined)
    const { controller } = companionSeat(() => alreadyCrew, { afterApply })

    await expect(controller.select('crew')).resolves.toEqual({ kind: 'refused', reason: 'unknown model' })
    await expect(controller.select('crew')).resolves.toEqual({ kind: 'applied' })
    await expect(controller.pendingApply()).resolves.toEqual({ kind: 'applied' })
    expect(afterApply).toHaveBeenCalledTimes(2)
  })
})
