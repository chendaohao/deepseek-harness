/**
 * What a running crew session recorded as its model combination.
 *
 * The combination picker names a template; this reads the session's own record,
 * so a header never shows a combination the session is not running. The five
 * readings are distinct states rather than one nullable value: "no combination
 * recorded", "this deployment serves no crew formation", and "the read failed"
 * each get their own face, because a label that painted any of them as the
 * combination would be claiming more than the Host reported.
 *
 * The read is the crew formation's `view` Remote, which answers from the
 * session's recorded routes. Editing the combination library afterwards, or
 * another session picking a different combination, leaves this reading as it
 * was.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge and the crew formation namespace into
// this program.
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CrewRoleRouteView } from '@deepseek-ai/dsh-crew/types'

/** What the header label can say about one session's recorded combination. */
export type CrewRoutesState =
  /** The read is in flight, or has not started yet. */
  | { readonly status: 'loading' }
  /** The session recorded a complete set: three role routes copied from one combination. */
  | {
    readonly status: 'ready-with-routes'
    /** Name the source combination carried when the routes were recorded. */
    readonly presetName: string | null
    /** Every role's recorded route, in the formation's role order. */
    readonly routes: readonly CrewRoleRouteView[]
  }
  /** The session recorded no combination, so its roles run their own defaults. */
  | { readonly status: 'ready-without-routes' }
  /** This deployment mounts no crew formation, so there is nothing to read. */
  | { readonly status: 'unavailable' }
  /** The Host refused or failed the read; its message is what the label reports. */
  | { readonly status: 'error'; readonly message: string }

const UNSERVED: CrewRoutesState = { status: 'unavailable' }
const LOADING: CrewRoutesState = { status: 'loading' }

/**
 * Reads one session's recorded combination, for the header label.
 *
 * An instance belongs to one Provider binding, and the owner stops it when that
 * binding or the plugin itself goes away — a late answer from a read started
 * before then must not revive a surface that is already gone.
 */
export class CrewRoutesViewController {
  /** Snapshot the renderer subscribes to through the label's hooks compartment. */
  readonly store: SnapshotStore<CrewRoutesState>
  /** Only the newest read may publish; every start invalidates the previous one. */
  private generation = 0
  /** Set once the owner is gone. */
  private stopped = false

  /**
   * @param ctx - apply-side context the optional Remote is read from; the
   * component never sees it.
   */
  constructor(private readonly ctx: ClientContext) {
    // A deployment without the crew bundle has no namespace to read, and the
    // label says so from the start instead of leaving a spinner the deployment
    // can never resolve.
    this.store = createSnapshotStore<CrewRoutesState>(
      ctx.get('remote.crewFormation') === undefined ? UNSERVED : LOADING,
    )
  }

  /**
   * Read the combination this session recorded.
   * @param sessionId - the session whose header is showing.
   * @returns once the snapshot reflects the Host, or immediately after stopping.
   */
  async load(sessionId: SessionId): Promise<void> {
    if (this.stopped) return
    const generation = ++this.generation
    const formation = this.ctx.get('remote.crewFormation') as
      ClientRemote['crewFormation'] | undefined
    if (formation === undefined) {
      this.publish(generation, UNSERVED)
      return
    }
    // A retry reads again from scratch, so the failure it replaces stops
    // showing before the answer arrives.
    this.publish(generation, LOADING)
    const result = await formation.view(sessionId)
    if (!result.ok) {
      this.publish(generation, { status: 'error', message: result.error.message })
      return
    }
    const view = result.value
    this.publish(generation, view.routes === null
      ? { status: 'ready-without-routes' }
      : { status: 'ready-with-routes', presetName: view.presetName, routes: view.routes })
  }

  /** Stop publishing: the owning binding or plugin is gone. */
  stop(): void {
    this.stopped = true
    this.generation++
  }

  /**
   * Publish unless a newer read or a stop superseded this one.
   * @param generation - the read that produced the state.
   * @param state - what that read observed.
   */
  private publish(generation: number, state: CrewRoutesState): void {
    if (this.stopped || generation !== this.generation) return
    this.store.set(state)
  }
}
