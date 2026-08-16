/**
 * The hero-chip seat's apply machinery: single-flight coalescing (session
 * creation publishes several list updates in one tick), the send-path
 * pendingApply gate that keeps a first prompt behind a staged pick, and the
 * stage lifecycle the two share.
 */

import { describe, expect, it } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { AgentPresetSeatController } from '../src/client/seat-store.ts'
import type { SeatSessionSummary } from '../src/client/seat-store.ts'

/** One dispatched select RPC whose settlement the test controls. */
interface PendingSelect {
  payload: { sessionId: string; agentPreset: string }
  resolve(envelope: unknown): void
  reject(error: unknown): void
}

/** A select double: records every dispatched RPC and settles it on demand. */
function selectRig(): { pending: PendingSelect[]; api: IApiClient } {
  const pending: PendingSelect[] = []
  const api = {
    agentPresets: {
      list: () => Promise.resolve({
        rpcId: 'r',
        result: {
          ok: true as const,
          value: { presets: [{ id: 'standard', trust: 'system' as const, isDefault: true }] },
        },
      }),
      select: (payload: { sessionId: string; agentPreset: string }) => new Promise((resolve, reject) => {
        pending.push({
          payload,
          resolve,
          reject: reject as (error: unknown) => void,
        })
      }),
    },
  } as unknown as IApiClient
  return { pending, api }
}

function okEnvelope(agentPreset: string): unknown {
  return { rpcId: 'r', result: { ok: true, value: { agentPreset } } }
}

function errEnvelope(message: string): unknown {
  return { rpcId: 'r', result: { ok: false, error: { code: 'agent-preset-locked', message, details: {} } } }
}

/** A seat over the rig, reading the given current-session thunk. */
function seat(
  rig: { pending: PendingSelect[]; api: IApiClient },
  currentSession: () => SeatSessionSummary | undefined,
  onApplied?: (sessionId: string, agentPreset: string) => void,
): AgentPresetSeatController {
  return new AgentPresetSeatController(rig.api, currentSession, onApplied)
}

const BLANK_S1: SeatSessionSummary = { id: 's1' as never, blank: true, agentPreset: 'standard' }

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
    rig.pending[0]!.resolve(okEnvelope('minimal'))
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
    rig.pending[0]!.resolve(okEnvelope('minimal'))
    await gate
    expect(settled).toBe(true)
  })

  it('applies an unserved stage itself instead of waiting for a list change', async () => {
    const rig = selectRig()
    const controller = seat(rig, () => ({ id: 's1' as never, blank: true }))
    controller.stage('minimal')
    const gate = controller.pendingApply()
    expect(rig.pending).toHaveLength(1)
    expect(rig.pending[0]!.payload).toEqual({ sessionId: 's1', agentPreset: 'minimal' })
    rig.pending[0]!.resolve(okEnvelope('minimal'))
    await gate
    // The stage is spent: the next gate settles without a second RPC.
    await controller.pendingApply()
    expect(rig.pending).toHaveLength(1)
  })

  it('terminates when no session can serve the stage and keeps it for the applier', async () => {
    const rig = selectRig()
    const holder: { current?: SeatSessionSummary } = {}
    const controller = seat(rig, () => holder.current)
    controller.stage('minimal')
    await controller.pendingApply()
    expect(rig.pending).toHaveLength(0)
    // The unservable stage survives for the list-change applier.
    holder.current = { id: 's1' as never, blank: true }
    const applying = controller.apply()
    expect(rig.pending).toHaveLength(1)
    expect(rig.pending[0]!.payload.agentPreset).toBe('minimal')
    rig.pending[0]!.resolve(okEnvelope('minimal'))
    await applying
  })

  it('re-checks a stage set while an apply is in flight', async () => {
    const rig = selectRig()
    const controller = seat(rig, () => BLANK_S1)
    controller.stage('minimal')
    const first = controller.apply()
    // The user re-picks mid-flight: the newer stage must survive the first
    // apply's completion and land through the waiting call.
    controller.stage('cordis')
    const second = controller.apply()
    rig.pending[0]!.resolve(okEnvelope('minimal'))
    await first
    expect(rig.pending).toHaveLength(2)
    expect(rig.pending[1]!.payload.agentPreset).toBe('cordis')
    rig.pending[1]!.resolve(okEnvelope('cordis'))
    await second
    expect(controller.store.getSnapshot().current).toBe('cordis')
  })

  it('a refused apply surfaces the host message and drops the stage', async () => {
    const rig = selectRig()
    const controller = seat(rig, () => BLANK_S1)
    controller.stage('minimal')
    const gate = controller.pendingApply()
    rig.pending[0]!.resolve(errEnvelope('session has already started'))
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
    expect(rig.pending[1]!.payload.agentPreset).toBe('cordis')
    rig.pending[1]!.resolve(okEnvelope('cordis'))
    await second
    expect(controller.store.getSnapshot().current).toBe('cordis')
  })

  it('reports the applied composition through onApplied', async () => {
    const rig = selectRig()
    const seen: string[][] = []
    const controller = seat(rig, () => BLANK_S1, (sessionId, agentPreset) => {
      seen.push([sessionId, agentPreset])
    })
    controller.stage('minimal')
    const applying = controller.apply()
    rig.pending[0]!.resolve(okEnvelope('minimal'))
    await applying
    expect(seen).toEqual([['s1', 'minimal']])
  })
})
