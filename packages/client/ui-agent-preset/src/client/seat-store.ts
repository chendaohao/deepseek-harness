/**
 * Hero-chip controller: which preset the NEXT session gets.
 *
 * The new-session screen has no session, so a pick is staged rather than
 * applied. It reaches a session when one becomes current and is still blank —
 * whether the workspace connect created it or reused an existing blank one,
 * which is why staging cannot simply ride along on `sessions.create`.
 *
 * The stage is forgotten once applied: the next new session starts from the
 * deployment default again, matching the workspace picker beside it.
 */

import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore, type SessionId, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import { messageOf, presetOptions } from './settings-store.ts'
import type { AgentPresetOption } from './settings-store.ts'

/** Hero-chip snapshot. */
export interface AgentPresetSeatState {
  /** Presets the deployment supplies; empty means the chip renders nothing. */
  options: readonly AgentPresetOption[]
  /** The staged choice, empty until the roster loads. */
  current: string
  /** A rejected apply's message, cleared by the next attempt. */
  error: string | null
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

/** One session's identity and whether it has started. */
export interface SeatSessionSummary {
  /** The session the chip would apply its staged choice to. */
  id: SessionId
  /** False once a turn has run — applying is refused from then on. */
  blank: boolean
  /** The preset the session already runs, when the summary reports one. */
  agentPreset?: string
}

/** Stages the next session's preset and applies it when one appears. */
export class AgentPresetSeatController {
  /** Chip snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<AgentPresetSeatState> = createSnapshotStore(INITIAL)

  /**
   * The deployment default, so a consumed stage can fall back to it without
   * re-reading the roster.
   */
  private fallback = ''

  /** Set while a pick is waiting for a session; cleared once applied. */
  private staged: string | undefined

  /**
   * Single-flight apply: the session list publishes several updates in one
   * tick (creation, projection, title), and each fires the list-change
   * applier — coalescing onto one in-flight RPC keeps a blank-session apply
   * to exactly one select instead of one per list update.
   */
  private applying: Promise<void> | null = null

  constructor(
    private readonly api: Pick<IApiClient, 'agentPresets'>,
    /** The session the hero is about to hand over to, when there is one. */
    private readonly currentSession: () => SeatSessionSummary | undefined,
    /**
     * Publish an applied switch into the session list, so the header label
     * moves with the composition instead of waiting for the next full list
     * refresh. Optional: a harness that renders no list omits it.
     */
    private readonly onApplied?: (sessionId: string, agentPreset: string) => void,
  ) {}

  private set(patch: Partial<AgentPresetSeatState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /**
   * Read the roster and open the chip on the deployment default.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    try {
      const response = await this.api.agentPresets.list({})
      if (!response.result.ok) {
        this.set({ error: response.result.error.message })
        return
      }
      const { presets } = response.result.value
      this.fallback = presets.find(preset => preset.isDefault)?.id ?? presets[0]?.id ?? ''
      this.set({
        options: presetOptions(presets),
        // Staged pick first, then the composition the current session
        // already carries, then the deployment default. The middle term is
        // what keeps a late-landing load from regressing the display after
        // an applied stage was consumed — the chip mounts (and loads) only
        // once the flow's session is current, so the reply can arrive after
        // apply() already composed it.
        current: this.staged ?? this.currentSession()?.agentPreset ?? this.fallback,
        error: null,
      })
    } catch (error) {
      this.set({ error: messageOf(error) })
    }
  }

  /**
   * Stage one preset for the next session, applying it immediately when a
   * blank session is already current.
   * @param id - the preset to stage.
   * @returns once the stage settled, and the apply too when one happened.
   */
  async select(id: string): Promise<void> {
    if (this.store.getSnapshot().busy) return
    this.stage(id)
    await this.apply()
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
    this.staged = id
    this.set({ current: id, error: null, introduce })
  }

  /** Acknowledge the introduction cue once the chip has played it. */
  introduced(): void {
    if (!this.store.getSnapshot().introduce) return
    this.set({ introduce: false })
  }

  /**
   * Hand the staged choice to the current session, if there is one to take it.
   *
   * Called both by `select()` and by whoever observes the current session
   * changing, because the session may appear either before or after the pick.
   * Calls made while an apply is in flight coalesce onto it and re-check the
   * stage afterward, so a pick staged mid-flight still lands.
   * @returns once the switch settled, or immediately when there is nothing to do.
   */
  async apply(): Promise<void> {
    while (this.applying !== null) await this.applying
    const staged = this.staged
    const session = this.currentSession()
    if (staged === undefined || session === undefined) return
    // A started session's history was produced under its own composition; the
    // host refuses the swap, so the stage is no longer meaningful.
    if (!session.blank || session.agentPreset === staged) {
      this.staged = undefined
      return
    }
    this.set({ busy: true, error: null })
    const run = this.runApply(staged, session)
    this.applying = run
    try {
      await run
    } finally {
      // Single-flight: no other apply can have started while this one owned
      // the flag (the while-loop gate above admits exactly one), so the flag
      // always belongs to this run at settlement.
      this.applying = null
    }
  }

  /**
   * Resolve once no staged pick awaits application: the in-flight apply (if
   * any) has settled, and a stage that survived it has been applied or found
   * unservable. The conversation send path awaits this before dispatching a
   * prompt, so a pick made just before the first send composes the session
   * before its first turn instead of racing it (the host locks a started
   * session's preset). Terminates even when no session exists to apply to —
   * the stage then stays for the list-change applier.
   * @returns once the staged pick is applied, dropped, or unservable.
   */
  async pendingApply(): Promise<void> {
    for (;;) {
      if (this.applying !== null) {
        await this.applying
        continue
      }
      if (this.staged === undefined) return
      const before = this.staged
      await this.apply()
      // apply() consumes a stage it serves (applied or dropped); a stage that
      // survived means no session exists to serve it yet, so the caller may
      // proceed — the list-change applier owns that case.
      if (this.staged === before) return
    }
  }

  /** Dispatch and settle one select RPC for the staged preset. */
  private async runApply(staged: string, session: SeatSessionSummary): Promise<void> {
    try {
      const response = await this.api.agentPresets.select({ sessionId: session.id, agentPreset: staged })
      // Only this pick is spent: a newer stage set while the RPC was in
      // flight belongs to the next apply and must survive this completion.
      if (this.staged === staged) this.staged = undefined
      if (!response.result.ok) {
        this.set({ busy: false, error: response.result.error.message, current: this.staged ?? this.fallback })
        return
      }
      // Consumed: the next new session opens on the deployment default again.
      this.set({ busy: false, current: this.staged ?? response.result.value.agentPreset })
      this.onApplied?.(session.id, response.result.value.agentPreset)
    } catch (error) {
      if (this.staged === staged) this.staged = undefined
      this.set({ busy: false, error: messageOf(error), current: this.staged ?? this.fallback })
    }
  }
}
