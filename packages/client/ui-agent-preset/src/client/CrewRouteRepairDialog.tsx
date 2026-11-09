/** Manual single-role route repair for one running Crew session. */

import { useEffect, useRef, useState } from 'react'
import type { ModelCatalog, ModelCatalogModel } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CrewRole, CrewRoleRoute, CrewRoleRouteView } from '@deepseek-ai/dsh-crew/types'
import css from './CrewRouteRepairDialog.module.css'

/** Result of reading the Host model catalog. */
export type CrewRouteCatalogOutcome =
  | { readonly ok: true; readonly value: ModelCatalog }
  | { readonly ok: false; readonly message: string }

/** Result of replacing one role route. */
export type CrewRouteRepairOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string }

/** Remote actions bound to the session owning the dialog. */
export interface CrewRouteRepairActions {
  /** Read provider, model, and effort choices from the live Host. */
  readonly loadCrewRouteCatalog: () => Promise<CrewRouteCatalogOutcome>
  /** Replace exactly one role, without retrying its failed work. */
  readonly replaceCrewRole: (role: CrewRole, route: CrewRoleRoute) => Promise<CrewRouteRepairOutcome>
}

interface Props extends CrewRouteRepairActions {
  readonly routes: readonly CrewRoleRouteView[]
  readonly onClose: () => void
  readonly t: TranslateNS<'settings.agentPreset'>
}

type CatalogState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly catalog: ModelCatalog }
  | { readonly status: 'error'; readonly message: string }

function routeFor(routes: readonly CrewRoleRouteView[], role: CrewRole): CrewRoleRoute | undefined {
  const route = routes.find(candidate => candidate.role === role)
  return route === undefined ? undefined : { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort }
}

function effortFor(model: ModelCatalogModel | undefined, stored: string): string {
  const efforts = model?.reasoning?.efforts ?? []
  if (efforts.some(effort => effort.id === stored)) return stored
  const [first] = efforts
  return first === undefined ? stored : model?.reasoning?.defaultEffort ?? first.id
}

function withCurrent(entries: readonly { readonly id: string; readonly name: string }[], current: string) {
  if (entries.some(entry => entry.id === current)) return entries
  return [{ id: current, name: current }, ...entries]
}

/** Fold case and separator differences so two spellings of one identifier compare equal. */
function comparableText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * One picker entry's label. The catalog id appears only where it names
 * something the display name does not, so a provider whose name repeats its id
 * and a model whose name differs from its id only in case and separators each
 * read once.
 */
function entryLabel(entry: { readonly id: string; readonly name: string }): string {
  return comparableText(entry.name) === comparableText(entry.id) ? entry.name : `${entry.name} · ${entry.id}`
}

const CREW_ROLES = ['worker', 'planner', 'reviewer'] as const satisfies readonly CrewRole[]

const ROLE_KEYS = {
  worker: 'crewRoutesWorker',
  planner: 'crewRoutesPlanner',
  reviewer: 'crewRoutesReviewer',
} as const

function sameRoute(left: CrewRoleRoute | undefined, right: CrewRoleRoute | undefined): boolean {
  return left !== undefined && right !== undefined
    && left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

/** Let the user select a replacement while keeping a failed write's draft intact. */
export function CrewRouteRepairDialog(props: Props) {
  const { t } = props
  const [role, setRole] = useState<CrewRole>('worker')
  const [draft, setDraft] = useState<CrewRoleRoute | undefined>(() => routeFor(props.routes, 'worker'))
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = async (): Promise<void> => {
    setCatalog({ status: 'loading' })
    const result = await props.loadCrewRouteCatalog()
    if (!mounted.current) return
    setCatalog(result.ok ? { status: 'ready', catalog: result.value } : { status: 'error', message: result.message })
  }
  useEffect(() => { void load() }, [props.loadCrewRouteCatalog])

  const current = routeFor(props.routes, role)
  const groups = catalog.status === 'ready' ? catalog.catalog.groups : []
  const group = draft === undefined ? undefined : groups.find(candidate => candidate.id === draft.provider)
  const model = group?.models.find(candidate => candidate.id === draft?.model)
  const efforts = model?.reasoning?.efforts ?? []
  const unchanged = sameRoute(current, draft)
  const incomplete = draft === undefined || !draft.provider || !draft.model || !draft.reasoningEffort

  const selectRole = (next: CrewRole): void => {
    setRole(next)
    setDraft(routeFor(props.routes, next))
    setFailure(undefined)
  }
  const selectProvider = (provider: string): void => {
    if (draft === undefined) return
    const nextGroup = groups.find(candidate => candidate.id === provider)
    const nextModel = nextGroup?.models.find(candidate => candidate.id === draft.model)
      ?? nextGroup?.models[0]
    setDraft({
      provider,
      model: nextModel?.id ?? '',
      reasoningEffort: effortFor(nextModel, draft.reasoningEffort),
    })
  }
  const selectModel = (next: string): void => {
    if (draft === undefined) return
    const nextModel = group?.models.find(candidate => candidate.id === next)
    setDraft({ ...draft, model: next, reasoningEffort: effortFor(nextModel, draft.reasoningEffort) })
  }
  const save = async (): Promise<void> => {
    if (draft === undefined || unchanged || incomplete || busy) return
    setBusy(true)
    setFailure(undefined)
    const result = await props.replaceCrewRole(role, { ...draft })
    if (!mounted.current) return
    if (result.ok) {
      props.onClose()
      return
    }
    setBusy(false)
    setFailure(result.message)
  }

  return (
    <Modal
      open
      onClose={props.onClose}
      title={t('crewRouteRepairTitle')}
      closeLabel={t('crewRouteRepairCancel')}
      description={t('crewRouteRepairDescription')}
      className={css.dialog ?? ''}
      footer={(
        <div className={css.actions}>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>{t('crewRouteRepairCancel')}</Button>
          <Button variant="primary" disabled={busy || unchanged || incomplete || catalog.status !== 'ready'} onClick={() => { void save() }}>
            {t('crewRouteRepairConfirm')}
          </Button>
        </div>
      )}
    >
      <div className={css.form}>
        <label className={css.field}>
          <span>{t('crewRouteRepairRole')}</span>
          <select className={css.control} value={role} disabled={busy} onChange={(event) => { selectRole(event.target.value as CrewRole) }}>
            {CREW_ROLES.map(value => <option key={value} value={value}>{t(ROLE_KEYS[value])}</option>)}
          </select>
        </label>
        {catalog.status === 'loading' ? <p className={css.notice} role="status">{t('crewRouteRepairLoading')}</p> : null}
        {catalog.status === 'error'
          ? (
            <div className={css.error} role="alert">
              <span>{t('crewRouteRepairCatalogFailed', { message: catalog.message })}</span>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { void load() }}>{t('crewRoutesRetry')}</Button>
            </div>
          )
          : null}
        {catalog.status === 'ready' && catalog.catalog.failures.length > 0
          ? <p className={css.notice}>{t('crewRouteRepairPartial')}</p>
          : null}
        {draft !== undefined && catalog.status === 'ready'
          ? (
            <>
              <label className={css.field}>
                <span>{t('crewRouteRepairProvider')}</span>
                <select
                  className={css.control}
                  value={draft.provider}
                  disabled={busy}
                  onChange={(event) => { selectProvider(event.target.value) }}
                >
                  {withCurrent(groups, draft.provider).map(entry => (
                    <option key={entry.id} value={entry.id}>{entryLabel(entry)}</option>
                  ))}
                </select>
              </label>
              <label className={css.field}>
                <span>{t('crewRouteRepairModel')}</span>
                <select
                  className={css.control}
                  value={draft.model}
                  disabled={busy || group === undefined}
                  onChange={(event) => { selectModel(event.target.value) }}
                >
                  {withCurrent(group?.models ?? [], draft.model).map(entry => (
                    <option key={entry.id} value={entry.id}>{entryLabel(entry)}</option>
                  ))}
                </select>
              </label>
              <label className={css.field}>
                <span>{t('crewRouteRepairEffort')}</span>
                {efforts.length === 0
                  ? (
                    <Input
                      value={draft.reasoningEffort}
                      disabled={busy}
                      onChange={(event) => { setDraft({ ...draft, reasoningEffort: event.target.value }) }}
                    />
                  )
                  : (
                    <select
                      className={css.control}
                      value={draft.reasoningEffort}
                      disabled={busy}
                      onChange={(event) => { setDraft({ ...draft, reasoningEffort: event.target.value }) }}
                    >
                      {withCurrent(efforts, draft.reasoningEffort).map(entry => (
                        <option key={entry.id} value={entry.id}>{entryLabel(entry)}</option>
                      ))}
                    </select>
                  )}
              </label>
            </>
          )
          : null}
        {failure !== undefined ? <p className={css.error} role="alert">{t('crewRouteRepairFailed', { message: failure })}</p> : null}
      </div>
    </Modal>
  )
}
