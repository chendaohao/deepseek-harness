/**
 * Hero-chip controller: which preset the NEXT session gets.
 *
 * The new-session screen has no session, so a pick is staged rather than
 * applied. It reaches a session when one becomes current and is still blank —
 * whether the workspace connect created it or reused an existing blank one. A
 * flow that knows its preset before it starts (the settings section's creator
 * entry) passes it to session creation instead, and its stage only drives the
 * chip's display.
 *
 * The stage is forgotten once applied. The next new session starts from the
 * Host-effective default again.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { messageOf, presetOptions, readRoster } from './settings-store.ts'
import type { AgentPresetOption } from './settings-store.ts'

/** Hero-chip snapshot. */
export interface AgentPresetSeatState {
  /** Presets the deployment supplies; empty means the chip renders nothing. */
  options: readonly AgentPresetOption[]
  /** The staged choice, empty until the roster loads. */
  current: string
  /** An error message; explicit selection failures also carry the preset for a Toast. */
  error: string | { readonly preset: AgentPresetOption; readonly reason: string } | null
  busy: boolean
  /**
   * One-shot cue that the chip should introduce itself (the creator-draft
   * entry staged the pick from another screen, so the user never touched the
   * chip); the renderer clears it via `introduced()` once played.
   */
  introduce: boolean
}

const INITIAL: AgentPresetSeatState = {
  options: [], current: '', error: null, busy: false, introduce: false,
}

/** Mutable one-shot preset choice shared across Provider-bound seat controllers. */
export interface AgentPresetStage {
  /** Preset awaiting application; absence means no staged choice. */
  id: string | undefined
  /** Whether the receiving chip should announce the applied choice once. */
  introduce: boolean
}

/**
 * Result of one attempt to hand a staged preset to the current Session: the Host applied it,
 * it waits for a Session to appear, nothing changed (busy, already composed, started, or no
 * stage), or the Host refused it.
 */
export type AgentPresetApplyOutcome =
  | { readonly kind: 'applied' | 'staged' | 'unchanged' }
  | { readonly kind: 'refused'; readonly reason: string }

const UNCHANGED: AgentPresetApplyOutcome = { kind: 'unchanged' }

/**
 * A hook another plugin uses to record its own per-session choice once the
 * composition it belongs to is on the session.
 *
 * A crew session picks its model combination beside the preset chip, and the
 * two must land together: the composition decides which roles exist, and the
 * combination decides what they run on. The preset apply is the one point that
 * knows both the session and the moment it became blank under the new
 * composition, so the other plugin registers here rather than racing a second
 * listener. An implementation returns a refusal message to stop the flow.
 */
export interface PresetCompanion {
  /**
   * Record this plugin's per-session choice.
   * @param sessionId - the blank session that just adopted the composition.
   * @param presetId - the composition it adopted.
   * @returns a refusal message, or undefined once the choice landed.
   */
  afterApply(sessionId: SessionId, presetId: string): Promise<string | undefined>
  /**
   * Resolve the companion's remaining displayed choice before the first prompt.
   * This hook runs after the composition and any explicit stage have settled;
   * unlike {@link afterApply}, it may consume a choice that was only displayed.
   * Implementations must make an already-recorded Session a no-op.
   * @param sessionId - current blank Session preparing its first prompt.
   * @param presetId - composition already recorded on that Session.
   * @returns a refusal message, or undefined when the choice landed or nothing remained.
   */
  beforeSend?(sessionId: SessionId, presetId: string): Promise<string | undefined>
}

/** Stages the next session's preset and applies it when one appears. */
export class AgentPresetSeatController {
  /** Chip snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<AgentPresetSeatState> = createSnapshotStore(INITIAL)

  /**
   * The Host-effective default, so a consumed stage can fall back to it without
   * re-reading the roster.
   */
  private fallback = ''

  /** Only the newest roster read may publish after overlapping refreshes. */
  private loadGeneration = 0
  /** Completion of the active Host selection; Settings choices wait before staging. */
  private pendingSelection: Promise<undefined> | undefined

  constructor(
    private readonly ctx: ClientContext,
    /** The session the hero is about to hand over to, when there is one. */
    private readonly currentSession: () => Pick<
      SessionSummary,
      'id' | 'blank' | 'projectionValues'
    > | undefined,
    private readonly staged: AgentPresetStage = { id: undefined, introduce: false },
    /** Companions that record their own choice alongside the composition. */
    private readonly companions: readonly PresetCompanion[] = [],
  ) {}

  private set(patch: Partial<AgentPresetSeatState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  private clearStage(): void {
    this.staged.id = undefined
    this.staged.introduce = false
  }

  /**
   * Read the roster and open the chip on the Host-effective default.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    const generation = ++this.loadGeneration
    const roster = await readRoster(this.ctx)
    if (generation !== this.loadGeneration) return
    // A roster refresh can finish after a selection; leave its announcement for the chip.
    const error = this.store.getSnapshot().error
    if (!roster.ok) {
      if (typeof error !== 'object' || error === null) this.set({ error: roster.error })
      return
    }
    const { presets } = roster.value
    this.fallback = presets.find(preset => preset.isDefault)?.id ?? presets[0]?.id ?? ''
    const session = this.currentSession()
    this.set({
      options: presetOptions(presets),
      // Staged pick first, then the composition the current session
      // already carries, then the Host-effective default. The middle term is
      // what keeps a late-landing load from regressing the display after
      // an applied stage was consumed — the chip mounts (and loads) only
      // once the flow's session is current, so the reply can arrive after
      // apply() already composed it.
      current: this.staged.id ?? (session === undefined ? this.fallback : presetOf(session) ?? ''),
      error: typeof error === 'object' ? error : null,
      introduce: this.staged.introduce,
    })
    await this.apply()
  }

  /**
   * Stage one preset for the next session, applying it immediately when a
   * blank session is already current.
   *
   * The refusal is stored for the chip's announcement and returned to callers
   * such as Settings that also report the result of their own write.
   * @param id - the preset to stage.
   * @returns how the pick settled; a refusal carries its text.
   */
  async select(id: string): Promise<AgentPresetApplyOutcome> {
    if (this.store.getSnapshot().busy) return UNCHANGED
    this.stage(id)
    return await this.apply()
  }

  /**
   * Stage a pick WITHOUT the immediate apply, for a flow that starts the
   * receiving session after the pick (the settings section's creator entry).
   * `select()`'s immediate apply would meet the still-current running session
   * and drop the stage as unservable; staging alone leaves it for the
   * list-change applier, which fires when the started session becomes
   * current.
   * @param id - the preset to stage.
   * @param introduce - true when the stage came from another screen and the
   * chip should announce itself on the session it lands on.
   */
  stage(id: string, introduce = false): void {
    this.staged.id = id
    this.staged.introduce = introduce
    this.set({ current: id, error: null, introduce })
  }

  /** Acknowledge a displayed refusal without dismissing a newer attempt.
   * @param refusal - the selection error whose Toast finished.
   */
  dismissRefusal(refusal: AgentPresetSeatState['error']): void {
    if (refusal !== null && typeof refusal === 'object' && this.store.getSnapshot().error === refusal) {
      this.set({ error: refusal.reason })
    }
  }

  /**
   * Capture the exact blank Session a Settings action may bring along.
   * @returns its id, or undefined outside a blank Session.
   */
  blankSessionId(): SessionSummary['id'] | undefined {
    const session = this.currentSession()
    return session?.blank === true ? session.id : undefined
  }

  /**
   * Apply a Settings choice only if its captured Session is still current and
   * blank after any pending selection settles. The selection uses the existing stage/apply path.
   * @param expectedSessionId - blank Session captured before the Settings write.
   * @param id - the effective default that the write persisted.
   * @returns the Host refusal text, or undefined when applied or no longer relevant.
   */
  async syncBlankSession(
    expectedSessionId: SessionSummary['id'],
    id: string,
  ): Promise<string | undefined> {
    for (;;) {
      const pending = this.pendingSelection
      const applying = this.applying
      if (pending === undefined && applying === null) break
      await (pending ?? applying)
    }
    const session = this.currentSession()
    if (session === undefined || !session.blank || session.id !== expectedSessionId) return undefined
    this.stage(id)
    const outcome = await this.apply()
    return outcome.kind === 'refused' ? outcome.reason : undefined
  }

  /** Acknowledge the introduction cue once the chip has played it. */
  introduced(): void {
    if (!this.store.getSnapshot().introduce) return
    this.staged.introduce = false
    this.set({ introduce: false })
  }

  /**
   * Hand the staged choice to the current session, if there is one to take it.
   *
   * Called both by `select()` and by whoever observes the current session
   * changing, because the session may appear either before or after the pick.
   * List updates do not repeat a selection while its response is pending.
   * @returns how this attempt settled; only a Host commit of the staged preset is applied.
   */
  async apply(): Promise<AgentPresetApplyOutcome> {
    // One in-flight apply owns the stage: a list update arriving while it runs
    // must not start a second select. The reconciliation path awaits
    // pendingSelection, which settles after busy clears, so it still applies a
    // stage made during the flight. `applying` also covers the settlement
    // interval after busy clears.
    if (this.applying !== null || this.store.getSnapshot().busy) return UNCHANGED
    const staged = this.staged.id
    const session = this.currentSession()
    if (staged === undefined) {
      const current = session === undefined ? this.fallback : presetOf(session) ?? ''
      const shown = this.store.getSnapshot()
      if (current !== shown.current) this.set({ current })
      return UNCHANGED
    }
    if (session === undefined) {
      this.lastOutcome = { kind: 'staged' }
      return this.lastOutcome
    }
    // A started session's history was produced under its own composition; the
    // host refuses the swap, so the stage is no longer meaningful.
    if (!session.blank) {
      this.clearStage()
      this.lastOutcome = UNCHANGED
      return this.lastOutcome
    }
    // Both paths are flights: the send path waits on `this.applying`, and a
    // companion's routes must land inside that wait or the first turn runs
    // before them. The already-composed path owns the same busy interval so a
    // concurrent list update cannot enter its companion twice.
    const alreadyComposed = presetOf(session) === staged
    if (alreadyComposed) {
      this.clearStage()
      this.set({ busy: true, error: null })
    }
    const run = alreadyComposed
      // The composition is already on this blank session, so there is no select
      // to make — but a companion still has its own choice to record, and this
      // is the only point that knows both the session and the composition.
      ? this.runCompanions(staged, session, { kind: 'unchanged' })
      : this.runApply(staged, session)
    return await this.track(run, alreadyComposed)
  }

  /**
   * Single-flight apply: the session list publishes several updates in one
   * tick (creation, projection, title), and each fires the list-change
   * applier — coalescing onto one in-flight RPC keeps a blank-session apply
   * to exactly one select instead of one per list update.
   */
  private applying: Promise<AgentPresetApplyOutcome> | null = null

  /** Publish one flight's outcome and release its ownership at the same settlement point. */
  private track(run: Promise<AgentPresetApplyOutcome>, clearBusy: boolean): Promise<AgentPresetApplyOutcome> {
    const flight = (async (): Promise<AgentPresetApplyOutcome> => {
      try {
        const settled = await run
        // Direct callers and later send gates read the same settled outcome.
        this.lastOutcome = settled
        return settled
      } finally {
        this.applying = null
        if (clearBusy) this.set({ busy: false })
      }
    })()
    this.applying = flight
    return flight
  }

  /** Outcome of the most recent settled apply, so the send path reads the result without parsing error text. */
  private lastOutcome: AgentPresetApplyOutcome | undefined

  /**
   * Resolve once no staged pick awaits application: the in-flight apply (if
   * any) has settled, and a stage that survived it has been applied or found
   * unservable. The conversation send path awaits this before dispatching a
   * prompt, so a pick made just before the first send composes the session
   * before its first turn instead of racing it (the host locks a started
   * session's preset). Terminates even when no session exists to apply to —
   * the stage then stays for the list-change applier. Once the stage settles,
   * companion `beforeSend` hooks resolve any displayed choice on the current
   * blank composition before the first prompt.
   * @returns the last settled attempt's outcome, or `unchanged` when no apply
   *   has settled.
   */
  async pendingApply(): Promise<AgentPresetApplyOutcome> {
    for (;;) {
      if (this.applying !== null) {
        await this.applying
        continue
      }
      if (this.staged.id === undefined) {
        const current = this.lastOutcome ?? UNCHANGED
        if (current.kind === 'refused') return current
        const session = this.currentSession()
        if (session === undefined || !session.blank) return current
        const presetId = presetOf(session)
        if (presetId === undefined || !this.companions.some(companion => companion.beforeSend !== undefined)) {
          return current
        }
        this.set({ busy: true, error: null })
        return await this.track(this.runCompanions(presetId, session, current, 'beforeSend'), true)
      }
      const before = this.staged.id
      const settled = await this.apply()
      // apply() consumes a stage it serves (applied or dropped); a stage that
      // survived means no session exists to serve it yet, so the caller may
      // proceed — the list-change applier owns that case.
      if (this.staged.id === before) return settled
    }
  }

  private async runApply(
    staged: string,
    session: Pick<SessionSummary, 'id' | 'blank' | 'projectionValues'>,
  ): Promise<AgentPresetApplyOutcome> {
    const completion = Promise.withResolvers<undefined>()
    this.pendingSelection = completion.promise
    this.clearStage()
    const refuse = (reason: string): AgentPresetApplyOutcome => {
      this.set({
        error: { reason, preset: this.store.getSnapshot().options.find(option => option.id === staged) ?? { id: staged } },
        current: this.staged.id ?? presetOf(session) ?? '',
      })
      return { kind: 'refused', reason }
    }
    try {
      this.set({ busy: true, error: null })
      const result = await this.ctx.remote.agentPresets.select(session.id, staged)
      if (!result.ok) {
        const { error } = result
        // Prefer the bare cause; the Toast already names the rejected preset.
        const refusal = 'reason' in error.details && typeof error.details.reason === 'string'
          ? error.details.reason
          : error.message
        return refuse(refusal)
      }
      // Consumed: the next new session opens on the deployment default again.
      this.set({ current: this.staged.id ?? result.value })
      if (result.value !== staged) return UNCHANGED
      return await this.runCompanions(staged, session, { kind: 'applied' })
    } catch (error) {
      return refuse(messageOf(error))
    } finally {
      this.pendingSelection = undefined
      this.set({ busy: false })
      completion.resolve(undefined)
    }
  }

  /**
   * Run every companion that records its own choice alongside one composition.
   *
   * Both paths reach here: a session that just adopted the composition, and one
   * that already carried it. The second is the case a pick made on the initial
   * screen hits when the blank session was created on `crew` in the first place,
   * and skipping it there left the session on the role defaults.
   * @param presetId - the composition the session now carries.
   * @param session - the blank session the companion records its choice on.
   * @param whenNone - outcome to report when no companion has anything to record.
   * @param phase - whether this is the immediate explicit apply or send preparation.
   * @returns the applied outcome, or the companion's refusal.
   */
  private async runCompanions(
    presetId: string,
    session: Pick<SessionSummary, 'id' | 'blank' | 'projectionValues'>,
    whenNone: AgentPresetApplyOutcome,
    phase: 'afterApply' | 'beforeSend' = 'afterApply',
  ): Promise<AgentPresetApplyOutcome> {
    if (this.companions.length === 0) return whenNone
    const refusalOf = (reason: string): AgentPresetApplyOutcome => {
      this.set({
        error: { reason, preset: this.store.getSnapshot().options.find(option => option.id === presetId) ?? { id: presetId } },
        current: presetOf(session) ?? presetId,
      })
      return { kind: 'refused', reason }
    }
    for (const companion of this.companions) {
      const hook = companion[phase]
      if (hook === undefined) continue
      const refusal = await hook.call(companion, session.id, presetId)
      if (refusal !== undefined) return refusalOf(refusal)
    }
    return { kind: 'applied' }
  }
}

function presetOf(
  session: Pick<SessionSummary, 'projectionValues'> | undefined,
): string | undefined {
  const value = session?.projectionValues?.agentPreset
  return typeof value === 'string' ? value : undefined
}
