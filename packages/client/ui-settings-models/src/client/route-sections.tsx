/** Thin per-role wrappers over the shared delegation route block. */

import type { en } from './locales.ts'
import { DelegationRouteSection } from './WorkerRouteSection.tsx'
import type { RouteSectionCopy } from './WorkerRouteSection.tsx'

/** Props every thin wrapper forwards from the page. */
export interface RoleRouteSectionProps {
  /** Reactive handle over the role's Host route namespace. */
  scope: import('@deepseek-ai/dsh-client-ui-settings/client').ConfigForm<import('./worker-route.ts').WorkerRouteSettings>
  /** Shared model catalog the pickers are drawn from. */
  catalog: import('@deepseek-ai/dsh-client-store').SnapshotStore<import('./worker-route.ts').WorkerRouteCatalogState>
  /** Ensure the catalog is loaded. */
  loadCatalog: () => void
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Map the locale keys onto the shared block's copy for one role. */
function copyFor(t: (key: keyof typeof en) => string, prefix: 'workerRoute' | 'plannerRoute' | 'reviewerRoute'): RouteSectionCopy {
  return {
    title: t(prefix + 'Title' as keyof typeof en),
    intro: t(prefix + 'Intro' as keyof typeof en),
    provider: t(prefix + 'Provider' as keyof typeof en),
    model: t(prefix + 'Model' as keyof typeof en),
    effort: t(prefix + 'Effort' as keyof typeof en),
    locked: t(prefix + 'Locked' as keyof typeof en),
    refused: t(prefix + 'Refused' as keyof typeof en),
    conflict: t(prefix + 'Conflict' as keyof typeof en),
  }
}

/** The worker role's route block. */
export function WorkerRouteSection(props: RoleRouteSectionProps) {
  return <DelegationRouteSection {...props} copy={copyFor(props.t, 'workerRoute')} />
}

/** The planner role's route block. */
export function PlannerRouteSection(props: RoleRouteSectionProps) {
  return <DelegationRouteSection {...props} copy={copyFor(props.t, 'plannerRoute')} />
}

/** The reviewer role's route block. */
export function ReviewerRouteSection(props: RoleRouteSectionProps) {
  return <DelegationRouteSection {...props} copy={copyFor(props.t, 'reviewerRoute')} />
}
