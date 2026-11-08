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
import type { CrewRoleRouteView } from '@deepseek-ai/dsh-crew/types'

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
  /** The session already records another combination; the attempt changed nothing. */
  | { readonly reason: 'conflict'; readonly recorded?: string }
  /** The Host rejected the routes; its own message is the report. */
  | { readonly reason: 'host'; readonly message: string }

/** What the combination picker renders. */
export interface CrewChoiceState {
  /** Every stored combination, in stored order; empty means nothing to pick. */
  options: readonly CrewPresetOption[]
  /** The explicit stage, last successful choice, or entry the picker opens on. */
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
  /** Only the newest selection or displayed fallback may publish a response. */
  private selectionGeneration = 0
  /** The session and combination already recorded, so send preparation does not repeat them. */
  private recorded: { readonly sessionId: SessionId; readonly id: string } | undefined

  constructor(
    private readonly ctx: ClientContext,
    /** The party's combination library, or undefined when the Host serves none. */
    private readonly presets: ConfigForm<PresetsValue> | undefined,
    /** Localizes a failure into the line every surface reports. */
    private readonly describe: CrewChoiceDescribe,
  ) {
    ctx.effect(() => {
      if (presets === undefined) return () => {}
      return presets.subscribe(() => { void this.load() })
    }, 'ui-agent-preset: Crew combination settings')
  }

  /**
   * Read the stored combinations and open on the last-used or first entry.
   *
   * The opening entry is display state and the send-time fallback, not an
   * immediate selection: choosing Crew alone must not record it.
   * @returns once the snapshot reflects the Host.
   */
  load(): Promise<void> {
    const generation = ++this.generation
    const presets = this.presets
    if (generation !== this.generation || presets === undefined) return Promise.resolve()
    const snapshot = presets.getSnapshot()
    const value = snapshot.status === 'ready' ? snapshot.value : undefined
    const options = (value?.presets ?? []).map(preset => ({ id: preset.id, name: preset.name }))
    // An explicit stage survives a refresh: a stale id is refused by
    // `applyToSession` rather than silently replaced by the library default.
    const opening = this.staged ?? openingOf(value)
    const selected = opening ?? ''
    if (this.staged === undefined && selected !== this.store.getSnapshot().selected) {
      this.selectionGeneration += 1
    }
    this.set({ options, selected })
    const lastUsed = value?.lastUsedPresetId
    if (lastUsed !== undefined && !(value?.presets ?? []).some(preset => preset.id === lastUsed)) {
      this.forgetLastUsed(presets)
    }
    return Promise.resolve()
  }

  /**
   * Stage one combination for the next crew session.
   * @param id - combination identity to record.
   */
  select(id: string): void {
    this.selectionGeneration += 1
    this.staged = id
    this.set({ selected: id, error: null })
  }

  /** Read the currently staged combination id.
   * @returns the staged combination id, or undefined when none is staged. */
  stage(): string | undefined {
    return this.staged
  }

  /**
   * Record the staged combination on one session.
   *
   * The Host decides whether the routes exist, so its refusal is what the
   * picker shows. Confirmed success consumes the current stage; a refusal keeps
   * it for a retry, and a conflict keeps it for the next crew session. A
   * response superseded by a newer selection changes neither the stage nor its
   * report.
   * @param sessionId - the blank session that just adopted the crew preset.
   * @returns the localized refusal; undefined when applied, absent, already
   *   recorded, superseded, or in conflict — a conflict is a picker notice, not a
   *   refused prompt.
   */
  applyToSession(sessionId: SessionId): Promise<string | undefined> {
    return this.apply(sessionId, false)
  }

  /**
   * Record the explicit stage, or the displayed opening entry when nothing was staged.
   * The send path uses this after the Crew preset has settled, so merely choosing
   * Crew does not commit the opening entry before the user can change it.
   * @param sessionId - current blank Crew session preparing its first prompt.
   * @returns the localized refusal; undefined when applied, absent, already
   *   recorded, superseded, or in conflict — a conflict is a picker notice, not a
   *   refused prompt.
   */
  applyDisplayedToSession(sessionId: SessionId): Promise<string | undefined> {
    return this.apply(sessionId, true)
  }

  private async apply(sessionId: SessionId, displayFallback: boolean): Promise<string | undefined> {
    const staged = this.staged ?? (displayFallback ? this.store.getSnapshot().selected : undefined)
    if (staged === undefined || staged === '') return undefined
    if (this.recorded?.sessionId === sessionId && (this.staged === undefined || this.recorded.id === staged)) {
      if (this.staged === staged) this.staged = undefined
      return undefined
    }
    const generation = this.selectionGeneration
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
    if (generation !== this.selectionGeneration) return undefined
    if (!result.ok) {
      // The Host reports a lost combination by code; everything else keeps its
      // own message as the report.
      if (result.error.code === 'crew/conflict') {
        const recordedId = result.error.details.recordedPresetId
        const recorded = recordedId === null ? undefined : this.stored().find(preset => preset.id === recordedId)?.name
        this.conflict(recorded)
        return undefined
      }
      return this.fail({ reason: 'host', message: result.error.message })
    }
    if (!result.value) {
      // Another call recorded its set between this call's guard and write. The
      // session's final view says which combination won; a same-combination
      // loser is the combination already being in place, not a conflict.
      const view = await formation.view(sessionId)
      if (generation !== this.selectionGeneration) return undefined
      if (view.ok && view.value.presetId === stored.id && sameRoutes(view.value.routes, routes)) {
        await this.succeed(sessionId, stored.id, generation)
        return undefined
      }
      this.conflict(view.ok ? view.value.presetName ?? undefined : undefined)
      return undefined
    }
    await this.succeed(sessionId, stored.id, generation)
    return undefined
  }

  /** Consume the successful selection and remember it for the next picker. */
  private async succeed(sessionId: SessionId, id: string, generation: number): Promise<void> {
    this.staged = undefined
    this.recorded = { sessionId, id }
    await this.presets?.set('lastUsedPresetId', id)
    // A selection made while the convenience write settled owns the report now.
    if (generation === this.selectionGeneration) this.set({ error: null })
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

  /**
   * Report a combination the session already runs, keeping the stage.
   *
   * The session keeps a valid route set, so this is a statement about the
   * pick rather than a failed session operation: the picker shows the line and
   * the stage survives for the next crew session, while the caller receives
   * nothing to refuse a first prompt over.
   * @param recorded - the name of the combination the session runs, when known.
   */
  private conflict(recorded: string | undefined): void {
    this.fail(recorded === undefined ? { reason: 'conflict' } : { reason: 'conflict', recorded })
  }

  /** Clear a last-used pointer whose combination disappeared from the library. */
  private forgetLastUsed(presets: ConfigForm<PresetsValue>): void {
    void presets.unset('lastUsedPresetId').catch((error: unknown) => {
      this.fail({ reason: 'host', message: error instanceof Error ? error.message : String(error) })
    })
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
 * Whether a session's recorded view carries exactly the routes one combination
 * names: every reported role's provider, model, and effort must agree with the
 * combination's route for that role.
 * @param recorded - the session's recorded routes as the view reports them.
 * @param routes - the combination's three role routes.
 * @returns whether the recorded set equals the combination's set.
 */
function sameRoutes(recorded: readonly CrewRoleRouteView[] | null, routes: StoredRoutes): boolean {
  if (recorded === null || recorded.length !== 3) return false
  return recorded.every((view) => {
    const route = routes[view.role]
    return view.provider === route.provider
      && view.model === route.model
      && view.reasoningEffort === route.reasoningEffort
  })
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
