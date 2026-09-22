/**
 * Inert worker-route injected face for specs that exercise the provider
 * directory. The block itself is covered by worker-route.client.spec.tsx; here
 * it only has to exist so {@link ModelsSection} renders.
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelsSectionInjected } from '../src/client/ModelsSection.tsx'
import type { WorkerRouteCatalogState, WorkerRouteSettings } from '../src/client/worker-route.ts'

/** One route value the stub section displays. */
export const STUB_WORKER_ROUTE: WorkerRouteSettings = {
  provider: 'stub-provider',
  model: 'stub-model',
  reasoningEffort: 'high',
}

/**
 * The one snapshot this stub returns. `useSyncExternalStore` requires a stable
 * reference between changes, exactly as the real scope contract promises.
 */
const SNAPSHOT = {
  status: 'ready' as const,
  value: STUB_WORKER_ROUTE,
  base: undefined,
  user: undefined,
  revision: 1,
  writable: true,
  mode: 'host' as const,
}

/** Build the stub injected face; every write is a no-op that settles. */
export function stubWorkerRoute(): ModelsSectionInjected['workerRoute'] {
  return {
    scope: {
      getSnapshot: () => SNAPSHOT,
      subscribe: () => () => {},
      mutate: () => Promise.resolve(true),
      set: () => Promise.resolve(true),
      unset: () => Promise.resolve(true),
    },
    catalog: createSnapshotStore<WorkerRouteCatalogState>({ value: null, status: 'idle' }),
    loadCatalog: () => {},
  }
}
