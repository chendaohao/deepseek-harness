/**
 * Worker-route settings slice for the Models page: the default LLM route an
 * opted-in delegation tool gives its children, plus the model catalog the
 * route's provider, model, and reasoning-effort pickers are drawn from.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/**
 * Settings namespace owned by the Host worker-route settings plugin. Spelled
 * here rather than imported: a client package must not depend on a Host
 * package, and the namespace is the profile entry id that mounts it.
 */
export const WORKER_ROUTE_SETTINGS_NAMESPACE = 'subagent-worker-route-settings'

/** Stored default child route, mirroring the Host section. */
export interface WorkerRouteSettings {
  /** Registered LLM provider id for the child. */
  provider: string
  /** Provider-owned exact model id for the child. */
  model: string
  /** Adapter-owned reasoning effort for that child route. */
  reasoningEffort: string
}

/** Observable lifecycle of the shared model catalog. */
export interface WorkerRouteCatalogState {
  /** Loaded catalog, or null before the first accepted load. */
  value: ModelCatalog | null
  /** Load lifecycle; `error` keeps the last accepted value cleared. */
  status: 'idle' | 'loading' | 'ready' | 'error'
}

/**
 * Loads the Host-generation model catalog once per browser session.
 *
 * The catalog is the same advisory provider/model/effort directory the
 * composer's model menu reads, so the picker offers exactly the routes the
 * Host can serve rather than a client-owned vocabulary.
 */
export class WorkerRouteCatalog {
  /** Current catalog value and load lifecycle. */
  readonly store: SnapshotStore<WorkerRouteCatalogState> = createSnapshotStore({
    value: null,
    status: 'idle',
  })

  private inflight: Promise<void> | undefined

  /**
   * @param ctx - the page plugin's context, whose `remote.session` carries the catalog.
   */
  constructor(private readonly ctx: ClientContext) {}

  /** Ensure the catalog is loaded, sharing one in-flight request. */
  load(): void {
    if (this.store.getSnapshot().status === 'ready' || this.inflight !== undefined) return
    this.store.update((draft) => { draft.status = 'loading' })
    this.inflight = this.ctx.remote.session.modelCatalog()
      .then((response) => {
        this.store.set(response.ok
          ? { value: response.value, status: 'ready' }
          : { value: null, status: 'error' })
      })
      .catch(() => { this.store.set({ value: null, status: 'error' }) })
      .finally(() => { this.inflight = undefined })
  }

  /**
   * Drop the accepted catalog so the next {@link load} refetches it. A
   * reconnected client is talking to a Host generation that may advertise a
   * different provider or effort set.
   */
  reset(): void {
    this.store.set({ value: null, status: 'idle' })
  }
}
