/** Staged Crew turn budgets backed by the Host's crew-formation settings. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

const MILLISECONDS_PER_MINUTE = 60_000
const MAX_WALL_TIME_MS = 2_147_483_647

/** Per-turn limits shared by every Crew worker, planner, and reviewer. */
export interface CrewBudgetSettings {
  maxStepsPerTurn: number
  maxWallTimeMsPerTurn: number
  maxTotalTokensPerTurn: number
  maxConsecutiveIdenticalFailures: number
}

/** The crew-formation value this card reads; other formation fields stay untouched. */
export interface CrewFormationSettings {
  budget: CrewBudgetSettings
}

/** Effective values and drafts presented by the Crew budget section. */
export interface CrewBudgetCardState extends SettingsFormShell {
  maxStepsPerTurn: SettingsFieldState
  maxWallTimeMsPerTurn: SettingsFieldState
  maxTotalTokensPerTurn: SettingsFieldState
  maxConsecutiveIdenticalFailures: SettingsFieldState
}

/** Actions and observable state bound by the slot renderer. */
export interface CrewBudgetCardFace extends SettingsFormActions {
  hooks: {
    crewBudgetCard: SnapshotStore<CrewBudgetCardState>
  }
}

function budgetOf(value: unknown): CrewBudgetSettings | undefined {
  return (value as { budget?: CrewBudgetSettings } | undefined)?.budget
}

/**
 * Present only crew-formation's budget object to a form model and prefix its writes back to that object.
 * @param scope - The root crew-formation settings scope.
 * @returns An independent budget scope retaining the root status, writability, and revision fence.
 */
export function crewBudgetScope(scope: SettingsFormScope<CrewFormationSettings>): SettingsFormScope<CrewBudgetSettings> {
  return {
    getSnapshot: () => {
      const snapshot = scope.getSnapshot()
      return {
        ...snapshot,
        value: snapshot.value?.budget,
        base: budgetOf(snapshot.base),
        user: budgetOf(snapshot.user),
      }
    },
    subscribe: listener => scope.subscribe(listener),
    mutate: (ops, expectedRevision) => scope.mutate(
      ops.map(op => ({ ...op, path: ['budget', ...op.path] })),
      expectedRevision,
    ),
  }
}

function budgetNumberField(
  field: keyof CrewBudgetSettings,
  fallback: number,
  accept: (value: number) => boolean,
): SettingsFieldSpec {
  const numeric = settingsNumberField(field)
  return {
    field,
    format: value => typeof value === 'number' ? String(value) : String(fallback),
    parse: (text) => {
      const write = numeric.parse(text)
      if (write?.kind !== 'set') return write
      const value = write.value as number
      return accept(value) ? write : undefined
    },
  }
}

function wallTimeField(): SettingsFieldSpec {
  const field = 'maxWallTimeMsPerTurn' as const
  const numeric = settingsNumberField(field)
  return {
    field,
    format: value => typeof value === 'number'
      ? String(value / MILLISECONDS_PER_MINUTE)
      : String(60),
    parse: (text) => {
      const write = numeric.parse(text)
      if (write?.kind !== 'set') return write
      const minutes = write.value as number
      if (minutes <= 0) return undefined
      const milliseconds = minutes * MILLISECONDS_PER_MINUTE
      return Number.isSafeInteger(milliseconds) && milliseconds <= MAX_WALL_TIME_MS
        ? { kind: 'set', value: milliseconds }
        : undefined
    },
  }
}

/** Bind four independently resettable Crew turn budgets to one staged settings form. */
export class CrewBudgetCardController {
  private readonly form: SettingsFormModel<CrewBudgetSettings>
  private readonly store: SnapshotStore<CrewBudgetCardState>

  /** @param scope - The budget child of the Host's crew-formation settings section. */
  constructor(scope: SettingsFormScope<CrewBudgetSettings>) {
    this.form = new SettingsFormModel(scope, [
      budgetNumberField('maxStepsPerTurn', 300, value => Number.isSafeInteger(value) && value >= 1),
      wallTimeField(),
      budgetNumberField('maxTotalTokensPerTurn', 50_000_000, value => Number.isSafeInteger(value) && value >= 1),
      budgetNumberField('maxConsecutiveIdenticalFailures', 6, value => Number.isInteger(value) && value >= 2),
    ])
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      maxStepsPerTurn: this.form.field('maxStepsPerTurn'),
      maxWallTimeMsPerTurn: this.form.field('maxWallTimeMsPerTurn'),
      maxTotalTokensPerTurn: this.form.field('maxTotalTokensPerTurn'),
      maxConsecutiveIdenticalFailures: this.form.field('maxConsecutiveIdenticalFailures'),
    }))
  }

  /** @returns The Crew budget snapshot and staged write actions. */
  inject(): CrewBudgetCardFace {
    return { hooks: { crewBudgetCard: this.store }, ...this.form.actions() }
  }

  /** Release accepted-value subscriptions. */
  dispose(): void { this.form.dispose() }
}
