/**
 * Inert crew-route injected face for specs that exercise the provider
 * directory. The block itself is covered by crew-route.client.spec.tsx; here it
 * only has to exist so {@link ModelsSection} renders.
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelsSectionInjected } from '../src/client/ModelsSection.tsx'
import type { CrewRoute } from '../src/client/crew-routes.ts'
import type { RoutePresetsSettings } from '../src/client/crew-presets.ts'
import type { RouteCatalogState, RouteSettings } from '../src/client/route-settings.ts'

/** One route value the stub section displays. */
export const STUB_ROUTE: RouteSettings = {
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
  value: STUB_ROUTE,
  base: undefined,
  user: undefined,
  revision: 1,
  writable: true,
  writeRefusal: undefined,
  writeFailure: undefined,
  mode: 'host' as const,
}

/** One inert role handle whose writes are no-ops that settle. */
export function stubCrewRoute(
  namespace = 'subagent-worker-route-settings',
  nameKey: CrewRoute['nameKey'] = 'crewRoleWorker',
): CrewRoute {
  const scope: ConfigForm<RouteSettings> = {
    getSnapshot: () => SNAPSHOT,
    subscribe: () => () => {},
    mutate: () => Promise.resolve(true),
    set: () => Promise.resolve(true),
    unset: () => Promise.resolve(true),
  }
  return { namespace, nameKey, scope }
}

/** One inert combination handle whose writes are no-ops that settle. */
export function stubCrewPresets(): ConfigForm<RoutePresetsSettings> {
  const snapshot = {
    status: 'ready' as const,
    value: { presets: [] },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    writeRefusal: undefined,
    writeFailure: undefined,
    mode: 'host' as const,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: () => Promise.resolve(true),
    set: () => Promise.resolve(true),
    unset: () => Promise.resolve(true),
  }
}

/** Build the stub injected face for the Models page's crew block. */
export function stubCrewRoutes(): ModelsSectionInjected['crewRoutes'] {
  return {
    routes: [stubCrewRoute()],
    catalog: createSnapshotStore<RouteCatalogState>({ value: null, status: 'idle' }),
    presets: stubCrewPresets(),
    loadCatalog: () => {},
  }
}
