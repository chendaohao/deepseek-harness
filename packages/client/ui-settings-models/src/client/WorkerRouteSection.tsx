/**
 * Worker-route block on the Models page: the default LLM route an opted-in
 * delegation tool hands its children. The route is a Host setting sampled when
 * a delegation tool resolves a child, so a change reaches the next delegation
 * rather than rebuilding anything already composed. Provider, model, and
 * reasoning effort come from the Host model catalog, so the picker offers the
 * routes the Host can actually serve.
 */

import { useEffect, useId, useSyncExternalStore } from 'react'
import type { ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { en } from './locales.ts'
import type { WorkerRouteCatalogState, WorkerRouteSettings } from './worker-route.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link WorkerRouteSection}. */
export interface WorkerRouteSectionProps {
  /** Reactive handle over the Host worker-route namespace. */
  scope: ConfigForm<WorkerRouteSettings>
  /** Shared model catalog the pickers are drawn from. */
  catalog: SnapshotStore<WorkerRouteCatalogState>
  /** Ensure the catalog is loaded. */
  loadCatalog: () => void
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** The provider group carrying one provider id, if the catalog advertises it. */
function groupFor(groups: readonly ModelProviderGroup[], provider: string): ModelProviderGroup | undefined {
  return groups.find(group => group.id === provider)
}

/** The advertised model carrying one id inside its provider group. */
function modelFor(group: ModelProviderGroup | undefined, model: string): ModelCatalogModel | undefined {
  return group?.models.find(candidate => candidate.id === model)
}

/**
 * One route picker row: a label plus the catalog entries for its dimension.
 * @param props - row label, current value, selectable entries, and the disabled state.
 * @returns the labelled select, with the stored value as a fallback entry when
 * the catalog no longer advertises it.
 */
function RouteSelect({ label, value, entries, disabled, onChange }: {
  label: string
  value: string
  entries: readonly { readonly id: string; readonly name: string }[]
  disabled: boolean
  onChange: (next: string) => void
}) {
  // A stored route whose entry the catalog no longer advertises still selects
  // itself, so opening the page never silently rewrites a working route.
  const stored = entries.some(entry => entry.id === value)
  return (
    <div className={styles['field']}>
      <span className={styles['fieldLabel']}>{label}</span>
      <select
        className={`${styles['input']} ${styles['selectInput']}`}
        value={value}
        aria-label={label}
        disabled={disabled}
        onChange={(event) => { onChange(event.target.value) }}
      >
        {!stored && value !== '' ? <option value={value}>{value}</option> : null}
        {entries.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select>
    </div>
  )
}

/**
 * Render the worker-route block.
 * @param props - the settings scope, catalog, and copy.
 * @returns the block, or null while the namespace is not exposed to this client.
 */
export function WorkerRouteSection({ scope, catalog, loadCatalog, t }: WorkerRouteSectionProps) {
  const state = useSyncExternalStore(
    fn => scope.subscribe(fn),
    () => scope.getSnapshot(),
  )
  const catalogState = useSyncExternalStore(
    fn => catalog.subscribe(fn),
    () => catalog.getSnapshot(),
  )
  const fieldId = useId()

  useEffect(() => { loadCatalog() }, [loadCatalog])

  if (state.status === 'unavailable') return null
  const value = state.value
  const groups = catalogState.value?.groups ?? []
  const group = value === undefined ? undefined : groupFor(groups, value.provider)
  const model = modelFor(group, value?.model ?? '')
  const efforts = model?.reasoning?.efforts ?? []
  const disabled = !state.writable || value === undefined

  return (
    <section className={styles['section']} aria-labelledby={`${fieldId}-title`}>
      <h3 id={`${fieldId}-title`} className={styles['title']}>{t('workerRouteTitle')}</h3>
      <p className={styles['intro']}>{t('workerRouteIntro')}</p>
      <div className={styles['rows']}>
        <RouteSelect
          label={t('workerRouteProvider')}
          value={value?.provider ?? ''}
          entries={groups}
          disabled={disabled}
          onChange={(next) => { void scope.set('provider', next) }}
        />
        <RouteSelect
          label={t('workerRouteModel')}
          value={value?.model ?? ''}
          entries={group?.models ?? []}
          disabled={disabled || group === undefined}
          onChange={(next) => { void scope.set('model', next) }}
        />
        <div className={styles['field']}>
          <span className={styles['fieldLabel']}>{t('workerRouteEffort')}</span>
          {/* The effort vocabulary is adapter-owned. With the catalog loaded the
              known levels are a picker; without it the stored id stays editable
              rather than being dropped by a list that cannot name it. */}
          {efforts.length > 0
            ? (
              <select
                className={`${styles['input']} ${styles['selectInput']}`}
                value={value?.reasoningEffort ?? ''}
                aria-label={t('workerRouteEffort')}
                disabled={disabled}
                onChange={(event) => { void scope.set('reasoningEffort', event.target.value) }}
              >
                {efforts.some(effort => effort.id === value?.reasoningEffort)
                  ? null
                  : <option value={value?.reasoningEffort ?? ''}>{value?.reasoningEffort ?? ''}</option>}
                {efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
              </select>
            )
            : (
              <input
                className={styles['input']}
                type="text"
                value={value?.reasoningEffort ?? ''}
                aria-label={t('workerRouteEffort')}
                disabled={disabled}
                onChange={(event) => { void scope.set('reasoningEffort', event.target.value) }}
              />
            )}
        </div>
      </div>
    </section>
  )
}
