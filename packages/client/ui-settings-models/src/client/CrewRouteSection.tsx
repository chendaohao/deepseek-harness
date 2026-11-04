/**
 * Crew route block on the Models page: one row per delegation role, each with
 * the default LLM route that role's delegation tool hands its children.
 *
 * A route is a Host setting sampled when a delegation tool resolves a child, so
 * a change reaches the next delegation rather than rebuilding anything already
 * composed. Provider, model, and reasoning effort come from the Host model
 * catalog, so the pickers offer the routes the Host can actually serve.
 *
 * The block renders only the roles whose namespace the Host serves. A web
 * deployment without the crew bundle serves none of them, so the block draws
 * nothing at all; that is what makes it follow the bundle rather than the page.
 */

import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import type { ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import type { en } from './locales.ts'
import type { CrewRoute, CrewRouteBlock } from './crew-routes.ts'
import type { RouteCatalogState, RouteSettings } from './route-settings.ts'
import styles from './ModelsSection.module.css'

/** Block copy: page copy plus the role name interpolated into each control. */
export interface CrewRouteCopy {
  /** Block heading. */
  title: string
  /** One-line explanation of what the routes drive. */
  intro: string
  /** Provider picker template carrying `{role}`. */
  provider: string
  /** Model picker template carrying `{role}`. */
  model: string
  /** Reasoning-effort picker template carrying `{role}`. */
  effort: string
  /** Why the controls are disabled while that role runs. */
  locked: string
  /** A refused write. */
  refused: string
  /** A stale page that reloaded. */
  conflict: string
  /** A route the provider or model change reset. */
  reset: string
}

/** Props of the crew route block. */
export interface CrewRouteSectionProps {
  /** The role rows and the shared catalog. */
  block: CrewRouteBlock
  /** Block copy. */
  copy: CrewRouteCopy
  /** The `t` seat, used for the per-role name and its interpolation. */
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string
}

/**
 * Fill one role template with the role name.
 *
 * The block keeps one copy of each control name per language rather than one per
 * role, so the role reaches the control through a `{role}` placeholder. The
 * accessible name stays unique per row, which is what tells three otherwise
 * identical pickers apart.
 * @param template - a copy string carrying `{role}`.
 * @param role - the localized role name.
 * @returns the copy with every placeholder replaced.
 */
export function roleCopy(template: string, role: string): string {
  return template.replaceAll('{role}', role)
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
 * The reasoning effort to store for one model.
 *
 * The effort vocabulary is model-owned, so a model change can strand the stored
 * effort. A stored value the new model still advertises survives; a model that
 * advertises none keeps it too, because the row then offers a text field that
 * can express values the catalog does not list.
 * @param model - the model the route now names, when the catalog advertises it.
 * @param stored - the effort currently stored.
 * @returns the effort to store alongside that model.
 */
export function effortFor(model: ModelCatalogModel | undefined, stored: string): string {
  const reasoning = model?.reasoning
  const efforts = reasoning?.efforts ?? []
  if (efforts.some(effort => effort.id === stored)) return stored
  const [first] = efforts
  // A model that advertises no levels keeps whatever is stored: its row offers
  // a text field that can express values the catalog does not list.
  if (first === undefined) return stored
  return reasoning?.defaultEffort ?? first.id
}

/**
 * The model a route carries after its provider changes.
 *
 * A stored model belongs to the previous provider, so switching provider
 * strands it. The catalog decides the replacement: a model the new provider
 * also advertises stays, otherwise its first entry does. A provider the catalog
 * does not advertise keeps the stored model, which the picker shows as a
 * fallback option, so a route the catalog cannot describe is never rewritten to
 * a value the user did not choose.
 * @param groups - the catalog's provider groups.
 * @param provider - the provider the route now names.
 * @param stored - the model currently stored.
 * @returns the model to store alongside that provider.
 */
export function modelForProvider(
  groups: readonly ModelProviderGroup[],
  provider: string,
  stored: string,
): string {
  const models = groupFor(groups, provider)?.models ?? []
  if (models.some(model => model.id === stored)) return stored
  const [first] = models
  // A provider the catalog does not advertise keeps the stored model, which the
  // picker shows as a fallback option.
  return first?.id ?? stored
}

/**
 * One route picker: a label plus the catalog entries for its dimension.
 * @param props - picker name, current value, selectable entries, and disabled state.
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
    <label className={styles['field']}>
      <span className={styles['fieldLabel']}>{label}</span>
      <select
        className={`${styles['input']} ${styles['selectInput']}`}
        value={value}
        disabled={disabled}
        onChange={(event) => { onChange(event.target.value) }}
      >
        {!stored && value !== '' ? <option value={value}>{value}</option> : null}
        {entries.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select>
    </label>
  )
}

/**
 * The reasoning-effort control: a picker while the model advertises levels, a
 * text field otherwise.
 * @param props - control name, stored value, advertised efforts, and disabled state.
 * @returns the labelled control.
 */
function EffortPicker({ label, value, efforts, disabled, onChange }: {
  label: string
  value: string
  efforts: readonly { readonly id: string; readonly name: string }[]
  disabled: boolean
  onChange: (next: string) => void
}) {
  // With the catalog loaded the known levels are a picker; without one the
  // stored id stays editable rather than being dropped by a list that cannot
  // name it.
  return (
    <label className={styles['field']}>
      <span className={styles['fieldLabel']}>{label}</span>
      {efforts.length === 0
        ? (
          <input
            className={styles['input']}
            type="text"
            value={value}
            disabled={disabled}
            onChange={(event) => { onChange(event.target.value) }}
          />
        )
        : (
          <select
            className={`${styles['input']} ${styles['selectInput']}`}
            value={value}
            disabled={disabled}
            onChange={(event) => { onChange(event.target.value) }}
          >
            {efforts.some(effort => effort.id === value) ? null : <option value={value}>{value}</option>}
            {efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
          </select>
        )}
    </label>
  )
}

/**
 * One role's row: the role name, its three pickers, and the notices its own
 * writes produce.
 * @param props - the role handle, the shared catalog state, and the block copy.
 * @returns the row, or null when the Host does not serve this role's namespace.
 */
function CrewRouteRow({ route, catalog, copy, t }: {
  route: CrewRoute
  catalog: RouteCatalogState
  copy: CrewRouteCopy
  t: CrewRouteSectionProps['t']
}) {
  const state = useSyncExternalStore(
    fn => route.scope.subscribe(fn),
    () => route.scope.getSnapshot(),
  )
  const [resetNotice, setResetNotice] = useState<string | undefined>(undefined)
  const fieldId = useId()

  if (state.status === 'unavailable') return null
  const role = t(route.nameKey)
  const label = (template: string): string => roleCopy(template, role)
  const value = state.value
  const groups = catalog.value?.groups ?? []
  const group = value === undefined ? undefined : groupFor(groups, value.provider)
  const model = modelFor(group, value?.model ?? '')
  const efforts = model?.reasoning?.efforts ?? []
  // The Host publishes why it would refuse the next write, so the controls are
  // disabled by that answer rather than by a client-side re-derivation of it.
  const locked = state.writeRefusal !== undefined
  const disabled = !state.writable || value === undefined || locked

  /**
   * Write one route, carrying the fields the edit strands.
   * @param next - the field the user just picked.
   */
  const commit = (next: Partial<RouteSettings>): void => {
    if (value === undefined) return
    const provider = next.provider ?? value.provider
    const providerChanged = provider !== value.provider
    // The catalog answers what the new provider or model can serve. Until it
    // has, the edited field is written alone and nothing is guessed.
    const providerGroup = providerChanged ? groupFor(groups, provider) : group
    const model = next.model ?? (providerChanged ? modelForProvider(groups, provider, value.model) : value.model)
    const effort = effortFor(modelFor(providerGroup, model), next.reasoningEffort ?? value.reasoningEffort)
    const ops = [
      ...provider === value.provider ? [] : [{ op: 'set' as const, path: ['provider'], value: provider }],
      ...model === value.model ? [] : [{ op: 'set' as const, path: ['model'], value: model }],
      ...effort === value.reasoningEffort ? [] : [{ op: 'set' as const, path: ['reasoningEffort'], value: effort }],
    ]
    const cascaded = model !== value.model || effort !== value.reasoningEffort
    setResetNotice(undefined)
    if (ops.length === 0) return
    void route.scope.mutate(ops).then((accepted) => {
      if (accepted && cascaded) setResetNotice(copy.reset)
    })
  }

  return (
    <div className={styles['crewRow']} role="group" aria-labelledby={`${fieldId}-role`}>
      <h4 id={`${fieldId}-role`} className={styles['crewRole']}>{role}</h4>
      {/* The Host's own refusal reason explains the disabled controls below. */}
      {locked && <p className={styles['notice']} role="status">{label(copy.locked)}</p>}
      {/* A rejected write must never read as a silent revert. */}
      {state.writeFailure !== undefined && (
        <p className={styles['error']} role="alert">
          {state.writeFailure === 'conflict' ? copy.conflict : label(copy.refused)}
        </p>
      )}
      {resetNotice !== undefined && <p className={styles['savedNotice']} role="status">{resetNotice}</p>}
      <div className={styles['crewFields']}>
        <RouteSelect
          label={label(copy.provider)}
          value={value?.provider ?? ''}
          entries={groups}
          disabled={disabled}
          onChange={(provider) => { commit({ provider }) }}
        />
        <RouteSelect
          label={label(copy.model)}
          value={value?.model ?? ''}
          entries={group?.models ?? []}
          disabled={disabled || group === undefined}
          onChange={(model) => { commit({ model }) }}
        />
        <EffortPicker
          label={label(copy.effort)}
          value={value?.reasoningEffort ?? ''}
          efforts={efforts}
          disabled={disabled}
          onChange={(reasoningEffort) => { commit({ reasoningEffort }) }}
        />
      </div>
    </div>
  )
}

/**
 * Render the crew route block.
 * @param props - the role rows, the shared catalog, block copy, and the `t` seat.
 * @returns the block, or null while the Host serves none of its namespaces.
 */
export function CrewRouteSection({ block, copy, t }: CrewRouteSectionProps) {
  const catalog = useSyncExternalStore(
    fn => block.catalog.subscribe(fn),
    () => block.catalog.getSnapshot(),
  )
  const fieldId = useId()

  useEffect(() => { block.loadCatalog() }, [block.loadCatalog])

  // The page filters the rows down to the namespaces the Host serves, so an
  // empty list means this deployment composed no crew role: the block leaves no
  // heading, intro, or empty container behind.
  if (block.routes.length === 0) return null
  return (
    <section className={styles['section']} aria-labelledby={`${fieldId}-title`}>
      <h3 id={`${fieldId}-title`} className={styles['title']}>{copy.title}</h3>
      <p className={styles['intro']}>{copy.intro}</p>
      <div className={styles['crewRows']}>
        {block.routes.map(route => (
          <CrewRouteRow key={route.namespace} route={route} catalog={catalog} copy={copy} t={t} />
        ))}
      </div>
    </section>
  )
}
