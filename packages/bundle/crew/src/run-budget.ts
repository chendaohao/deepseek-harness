/**
 * Per-turn execution budgets for Crew role children. The formation owns the
 * policy so a cold resume receives the same limits without relying on persona
 * text or a caller remembering to install a guard.
 * @module @deepseek-ai/dsh-crew/run-budget
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter'
import type { PostToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Limits applied independently to each Crew role child's turn. */
export interface CrewRunBudgetConfig {
  /** Maximum model steps admitted in one turn. */
  readonly maxStepsPerTurn?: number
  /** Maximum wall time in milliseconds before the active turn is cancelled. */
  readonly maxWallTimeMsPerTurn?: number
  /** Maximum newly reported token usage, including cache reads and writes, in one turn. */
  readonly maxTotalTokensPerTurn?: number
  /** Maximum consecutive tool failures with the same structured error and message. */
  readonly maxConsecutiveIdenticalFailures?: number
}

/** Validated limits used by the runtime guard. */
export const CrewRunBudgetConfigSchema = z.object({
  maxStepsPerTurn: z.number().step(1).min(1).default(300),
  maxWallTimeMsPerTurn: z.number().step(1).min(1).max(2_147_483_647).default(3_600_000),
  maxTotalTokensPerTurn: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(50_000_000),
  maxConsecutiveIdenticalFailures: z.number().step(1).min(2).default(6),
})

type ResolvedCrewRunBudgetConfig = Required<CrewRunBudgetConfig>
type BudgetReason = 'steps' | 'duration' | 'tokens' | 'repeated-failure'

interface TurnState {
  readonly turn: number
  readonly baseline: TokenUsageProjection
  readonly startedAt: number
  timer: ReturnType<typeof setTimeout>
  failureKey: string | undefined
  failureCount: number
  exhausted?: { readonly reason: BudgetReason; readonly limit: number; readonly observed: number }
}

const ROLE_PRESETS = new Set(['crew-worker', 'crew-planner', 'crew-reviewer'])

function tokenTotal(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A Crew role turn reached an execution limit. Log-only; no model history is added. */
    'crew/run-budget-exceeded': {
      /** Turn whose next work was refused or cancelled. */
      turn: number
      /** Configured budget that was exhausted. */
      reason: BudgetReason
      /** Configured limit in the reason's unit. */
      limit: number
      /** Observed amount in the same unit. */
      observed: number
    }
  }
}

/** Owns the timers, usage baselines, and repeated-failure chains of live Crew role turns. */
export class CrewRunBudget {
  private readonly config: ResolvedCrewRunBudgetConfig
  private readonly states = new WeakMap<Agent, TurnState>()
  private readonly active = new Set<Agent>()
  private stopped = false

  constructor(private readonly ctx: Context, config: CrewRunBudgetConfig = {}) {
    this.config = CrewRunBudgetConfigSchema(config)
  }

  /** Register interception points until the formation unloads. */
  start(): void {
    this.ctx.on('agent/pre-step', async ({ agent, turn, step }, next): Promise<PreStepDecision> => {
      if (!this.isRole(agent)) return next()
      const state = this.stateFor(agent, turn)
      const failure = this.exhaustion(agent, state, step)
      if (failure === undefined) return next()
      this.record(agent, state, failure)
      clearTimeout(state.timer)
      return { kind: 'reject' }
    })
    this.ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
      const agent = exec.agent
      if (agent !== undefined && this.isRole(agent)) this.observeFailure(agent, exec.name, result)
      return next()
    })
    this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const agent = [...this.active].find(candidate => candidate.session === session)
      const state = agent === undefined ? undefined : this.states.get(agent)
      if (agent === undefined || state?.turn !== event.data.turn) return
      clearTimeout(state.timer)
      this.states.delete(agent)
      this.active.delete(agent)
    })
    this.ctx.effect(() => () => { this.stop() }, 'crew: role run budgets')
  }

  private isRole(agent: Agent): boolean {
    return ROLE_PRESETS.has(agent.session.header.agentPreset ?? '')
  }

  private stateFor(agent: Agent, turn: number): TurnState {
    const existing = this.states.get(agent)
    if (existing?.turn === turn) return existing
    if (existing !== undefined) clearTimeout(existing.timer)
    const baseline = this.ctx.tokenMeter.tokenUsage(agent.session)
    const state: TurnState = {
      turn,
      baseline,
      startedAt: Date.now(),
      failureKey: undefined,
      failureCount: 0,
      timer: setTimeout(() => {
        if (this.stopped || this.states.get(agent) !== state) return
        const failure = {
          reason: 'duration' as const,
          limit: this.config.maxWallTimeMsPerTurn,
          observed: Math.max(this.config.maxWallTimeMsPerTurn, Date.now() - state.startedAt),
        }
        this.record(agent, state, failure)
        agent.cancel({ kind: 'hook', reason: 'crew/run-budget-duration' })
      }, this.config.maxWallTimeMsPerTurn),
    }
    state.timer.unref()
    this.states.set(agent, state)
    this.active.add(agent)
    return state
  }

  private exhaustion(agent: Agent, state: TurnState, step: number): TurnState['exhausted'] {
    if (state.exhausted !== undefined) return state.exhausted
    if (step > this.config.maxStepsPerTurn) {
      return { reason: 'steps', limit: this.config.maxStepsPerTurn, observed: step - 1 }
    }
    const observed = Math.max(0, tokenTotal(this.ctx.tokenMeter.tokenUsage(agent.session)) - tokenTotal(state.baseline))
    if (observed >= this.config.maxTotalTokensPerTurn) {
      return { reason: 'tokens', limit: this.config.maxTotalTokensPerTurn, observed }
    }
    return undefined
  }

  private observeFailure(agent: Agent, tool: string, result: ToolExecutionResult): void {
    const state = this.states.get(agent)
    if (state === undefined || state.exhausted !== undefined) return
    const key = result.isError
      ? JSON.stringify([tool, result.error.info?.code ?? '', result.error.message])
      : undefined
    if (key !== undefined && key === state.failureKey) state.failureCount += 1
    else {
      state.failureKey = key
      state.failureCount = key === undefined ? 0 : 1
    }
    if (state.failureCount < this.config.maxConsecutiveIdenticalFailures) return
    this.record(agent, state, {
      reason: 'repeated-failure',
      limit: this.config.maxConsecutiveIdenticalFailures,
      observed: state.failureCount,
    })
  }

  private record(agent: Agent, state: TurnState, failure: NonNullable<TurnState['exhausted']>): void {
    if (state.exhausted !== undefined) return
    state.exhausted = failure
    clearTimeout(state.timer)
    try {
      agent.session.append('crew/run-budget-exceeded', { turn: state.turn, ...failure })
    } catch (error: unknown) {
      // The stop decision remains effective even when its diagnostic cannot be committed.
      this.ctx.logger.warn('crew: failed to record a role run-budget stop: %s', error)
    }
  }

  private stop(): void {
    this.stopped = true
    for (const agent of this.active) {
      const state = this.states.get(agent)
      if (state !== undefined) clearTimeout(state.timer)
      this.states.delete(agent)
    }
    this.active.clear()
  }
}
