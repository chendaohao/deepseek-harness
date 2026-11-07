/**
 * The crew model-combination picker for a new session, and the stage it hands
 * the composition flow.
 *
 * The picker appears beside the preset chip only while that chip is staged on
 * `crew`: a combination names the three delegation roles, which no other preset
 * has. The choice is staged rather than applied, because the pick is made on a
 * screen that may have no session yet — the seat applies it to the session that
 * becomes current and is still blank, through the preset apply's companion hook.
 *
 * The routes reach the Host as the crew formation's `selectRoutes`, which
 * records them on that session alone. Editing a combination afterwards, or
 * another session picking a different one, leaves this session's routes as they
 * were.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge and the crew formation namespace into
// this program.
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Settings namespace the crew bundle's combination row serves. */
export const CREW_ROUTE_PRESETS_NAMESPACE = 'subagent-route-presets'

/** One stored combination as the picker renders it. */
export interface CrewPresetOption {
  /** Combination identity the formation service records. */
  id: string
  /** Combination name shown in the picker. */
  name: string
}

/** One combination's routes, keyed by role. */
interface StoredRoutes {
  worker: RouteValues
  planner: RouteValues
  reviewer: RouteValues
}

interface RouteValues {
  provider: string
  model: string
  reasoningEffort: string
}

/** Why a combination could not reach the session. */
export type CrewChoiceFailure =
  /** The library no longer stores the staged combination. */
  | { readonly reason: 'gone' }
  /** The stored combination omits at least one delegation role. */
  | { readonly reason: 'incomplete' }
  /** This deployment mounts no crew formation, so there is nowhere to record it. */
  | { readonly reason: 'unserved' }
  /** The Host rejected the routes; its own message is the report. */
  | { readonly reason: 'host'; readonly message: string }

/** What the combination picker renders. */
export interface CrewChoiceState {
  /** Every stored combination, in stored order; empty means nothing to pick. */
  options: readonly CrewPresetOption[]
  /** The staged combination id, or the one the picker would open on. */
  selected: string
  /** The localized report of the last failed apply, or null. */
  error: string | null
}

/** Turns a failure into the one line this plugin's surfaces show. */
export type CrewChoiceDescribe = (failure: CrewChoiceFailure) => string

const INITIAL: CrewChoiceState = { options: [], selected: '', error: null }

/** The shape this module reads off the Host's combination settings namespace. */
interface StoredPreset {
  id: string
  name: string
  routes: readonly ({ namespace: string } & RouteValues)[]
}

interface PresetsValue {
  presets: readonly StoredPreset[]
  lastUsedPresetId?: string
}

/** The role name a route's settings namespace carries, as the crew bundle spells it. */
const ROLE_SUFFIX = /-(\w+)-route-settings$/

/**
 * Stages the next crew session's model combination.
 *
 * Nothing here writes until a session exists: `applyToSession` is called by the
 * preset apply once the composition is on the session, so the routes and the
 * composition land together and the first turn sees both.
 */
export class CrewChoiceController {
  /** Picker snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<CrewChoiceState> = createSnapshotStore(INITIAL)

  /** The combination staged for the next crew session. */
  private staged: string | undefined
  /** Only the newest library read may publish after overlapping refreshes. */
  private generation = 0

  constructor(
    private readonly ctx: ClientContext,
    /** The party's combination library, or undefined when the Host serves none. */
    private readonly presets: ConfigForm<PresetsValue> | undefined,
    /** Localizes a failure into the line every surface reports. */
    private readonly describe: CrewChoiceDescribe,
  ) {}

  /**
   * Read the stored combinations and stage the one the picker opens on.
   *
   * The opened combination is the staged one, so a session started without
   * touching the picker still records the routes that picker names. Staging
   * nothing while the control showed a combination is what let a crew session
   * run the role defaults under a picker that said otherwise.
   * @returns once the snapshot reflects the Host.
   */
  load(): Promise<void> {
    const generation = ++this.generation
    const snapshot = this.presets?.getSnapshot()
    if (generation !== this.generation || snapshot === undefined) return Promise.resolve()
    const value = snapshot.status === 'ready' ? snapshot.value : undefined
    const options = (value?.presets ?? []).map(preset => ({ id: preset.id, name: preset.name }))
    // A stage that survived a refresh stays: a stale id is refused by
    // `applyToSession` rather than silently replaced by the library default.
    const opening = this.staged ?? openingOf(value)
    this.staged = opening
    this.set({ options, selected: opening ?? '' })
    return Promise.resolve()
  }

  /**
   * Stage one combination for the next crew session.
   * @param id - combination identity to record.
   */
  select(id: string): void {
    this.staged = id
    this.set({ selected: id, error: null })
  }

  /** @returns the staged combination id, or undefined when none is staged. */
  stage(): string | undefined {
    return this.staged
  }

  /**
   * Record the staged combination on one session.
   *
   * The Host decides whether the routes exist, so its refusal is what the
   * picker shows. A stage is cleared only on success: dropping it on failure
   * would leave the session without routes and the next session silently
   * inheriting the pick instead.
   * @param sessionId - the blank session that just adopted the crew preset.
   * @returns the localized report, or undefined once the routes are recorded.
   */
  async applyToSession(sessionId: SessionId): Promise<string | undefined> {
    const staged = this.staged
    if (staged === undefined) return undefined
    const stored = this.stored().find(preset => preset.id === staged)
    if (stored === undefined) {
      this.staged = undefined
      return this.fail({ reason: 'gone' }, '')
    }
    const routes = routesOf(stored)
    if (routes === undefined) return this.fail({ reason: 'incomplete' })
    const formation = this.ctx.get('remote.crewFormation') as
      ClientRemote['crewFormation'] | undefined
    if (formation === undefined) {
      // The crew bundle is what mounts this namespace. Reading it through
      // `ctx.get` rather than `inject` keeps a deployment without that bundle
      // serving this plugin normally instead of parking it forever.
      return this.fail({ reason: 'unserved' })
    }
    const result = await formation.selectRoutes(sessionId, {
      presetId: stored.id,
      presetName: stored.name,
      routes,
    })
    if (!result.ok) return this.fail({ reason: 'host', message: result.error.message })
    this.staged = undefined
    this.set({ error: null })
    return undefined
  }

  /**
   * Publish one localized failure.
   * @param failure - what went wrong, in the form the reporter localizes.
   * @param selected - replacement for the displayed pick, when the entry is gone.
   * @returns the same localized line, for the caller that reports it.
   */
  private fail(failure: CrewChoiceFailure, selected?: string): string {
    const error = this.describe(failure)
    this.set(selected === undefined ? { error } : { error, selected })
    return error
  }

  /** The stored combinations behind the current snapshot. */
  private stored(): readonly StoredPreset[] {
    return this.presets?.getSnapshot().value?.presets ?? []
  }

  private set(patch: Partial<CrewChoiceState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }
}

/**
 * The combination the picker opens on.
 * @param value - the stored combination list and its last-used pointer.
 * @returns the last-used id, else the first stored id, else undefined.
 */
export function openingOf(value: PresetsValue | undefined): string | undefined {
  const presets = value?.presets ?? []
  const last = value?.lastUsedPresetId === undefined
    ? undefined
    : presets.find(preset => preset.id === value.lastUsedPresetId)
  return last?.id ?? presets[0]?.id
}

/**
 * One combination's routes keyed by role.
 * @param preset - stored combination.
 * @returns the three role routes, or undefined when the combination omits one.
 */
export function routesOf(preset: StoredPreset): StoredRoutes | undefined {
  const byRole = new Map<string, RouteValues>()
  for (const route of preset.routes) {
    const role = ROLE_SUFFIX.exec(route.namespace)?.[1]
    if (role === undefined) continue
    byRole.set(role, { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort })
  }
  const worker = byRole.get('worker')
  const planner = byRole.get('planner')
  const reviewer = byRole.get('reviewer')
  if (worker === undefined || planner === undefined || reviewer === undefined) return undefined
  return { worker, planner, reviewer }
}
