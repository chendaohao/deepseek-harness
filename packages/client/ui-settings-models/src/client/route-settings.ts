/**
 * The model catalog the crew-route pickers are drawn from, plus the route value
 * those pickers edit. The routes themselves are named by `./crew-routes.ts`.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Stored default child route, mirroring the Host section. */
export interface RouteSettings {
  /** Registered LLM provider id for the child. */
  provider: string
  /** Provider-owned exact model id for the child. */
  model: string
  /** Adapter-owned reasoning effort for that child route. */
  reasoningEffort: string
}

/** Observable lifecycle of the shared model catalog. */
export interface RouteCatalogState {
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
export class RouteCatalog {
  /** Current catalog value and load lifecycle. */
  readonly store: SnapshotStore<RouteCatalogState> = createSnapshotStore({
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
