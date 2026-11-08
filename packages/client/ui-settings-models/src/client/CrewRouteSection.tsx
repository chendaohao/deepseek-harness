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

import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react'
import type { ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import type { en } from './locales.ts'
import type { CrewRouteBlock } from './crew-routes.ts'

import {
  createServedRouteSet, defaultPreset, draftComplete, draftFromPreset, emptyPresets, newPresetId,
  removePreset, routesFromDraft, upsertPreset,
} from './crew-presets.ts'
import type {
  CrewRoleRef, RoleDraft, RoutePreset, RoutePresetsSettings, ServedRouteSet,
} from './crew-presets.ts'
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
  /** Combination picker name. */
  presetLabel: string
  /** The picker entry that starts a new combination. */
  presetNew: string
  /** Start a new combination from the roles' current routes. */
  presetSave: string
  /** Role picker name. */
  presetRole: string
  /** Accessible name of the naming field. */
  presetName: string
  /** Placeholder of the naming field. */
  presetNamePlaceholder: string
  /** Confirm the naming field. */
  presetConfirm: string
  /** Delete the combination being edited. */
  presetDelete: string
  /** A stored combination that was just written. */
  presetSaved: string
  /** A stored combination that was just dropped. */
  presetDeleted: string
  /** Why a combination cannot be saved yet. */
  presetIncomplete: string
  /** The combination list is not writable. */
  presetReadOnly: string
  /** A rejected combination write. */
  presetRefused: string
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

/** The combination an edit started from, and the drafts being edited. */
interface EditState {
  /** Combination id being edited, or a freshly minted one for a new combination. */
  id: string
  /** Name shown in the name field; the stored name until the user changes it. */
  name: string
  /** One draft per role, keyed by namespace. */
  drafts: Map<string, RoleDraft>
}

/**
 * The combination editor: pick a combination, pick a role, edit that role.
 *
 * The three roles share one draft, so choosing which role to edit is a view
 * switch rather than three independent editors. Saving writes the whole
 * combination at once, requiring every role, so a stored set is never partial.
 * @param props - the role handles, the preset handle, the served routes, block
 *   copy, and the `t` seat.
 * @returns the editor, or null while the Host serves no preset namespace.
 */
function CrewPresetRow({ block, served, copy, t }: {
  block: CrewRouteBlock
  served: ServedRouteSet
  copy: CrewRouteCopy
  t: CrewRouteSectionProps['t']
}) {
  const presets = useSyncExternalStore(
    fn => block.presets.subscribe(fn),
    () => block.presets.getSnapshot(),
  )
  const [editing, setEditing] = useState<EditState | undefined>(undefined)
  const [selectedRole, setSelectedRole] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const catalog = useSyncExternalStore(
    fn => block.catalog.subscribe(fn),
    () => block.catalog.getSnapshot(),
  )

  const stored = presets.value?.presets ?? []
  const servedRoutes = useMemo(
    () => new Map(served.routes.map(route => [route.namespace, route.value])),
    [served.routes],
  )
  const roles = useMemo<CrewRoleRef[]>(
    () => block.routes.map(route => ({ namespace: route.namespace, nameKey: route.nameKey })),
    [block.routes],
  )
  const groups = catalog.value?.groups ?? []

  // The editor opens on the combination the last new session used, so the page
  // and the picker agree on which set is the current one.
  const openingId = defaultPreset(presets.value ?? emptyPresets())?.id
  useEffect(() => {
    if (presets.status !== 'ready') return
    setEditing((current) => {
      // A draft the user is editing survives a refresh; only the opening state
      // and a draft whose combination disappeared are recomputed.
      if (current !== undefined && stored.some(preset => preset.id === current.id)) return current
      const target = stored.find(preset => preset.id === openingId)
      // A list with nothing selected still edits a real draft: minting the id
      // here is what makes the first save an insert rather than an overwrite of
      // whatever id the form happened to carry.
      return {
        id: target?.id ?? newPresetId(stored),
        name: target?.name ?? '',
        drafts: draftFromPreset(target, roles, servedRoutes),
      }
    })
  }, [presets.status, openingId, stored, roles, servedRoutes])

  useEffect(() => {
    if (selectedRole !== undefined && roles.some(role => role.namespace === selectedRole)) return
    setSelectedRole(roles[0]?.namespace)
  }, [roles, selectedRole])

  if (presets.status === 'unavailable') return null

  const disabled = !presets.writable || busy
  const current = stored.find(preset => preset.id === editing?.id)
  const role = roles.find(candidate => candidate.namespace === selectedRole)
  const draft = role === undefined ? undefined : editing?.drafts.get(role.namespace)
  const complete = editing !== undefined && draftComplete(editing.drafts, roles)

  /** Persist the combination list and report what happened. */
  const writePresets = async (next: RoutePresetsSettings): Promise<boolean> => {
    setBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    const accepted = await block.presets.mutate([
      {
        op: 'set',
        path: ['presets'],
        value: next.presets.map(preset => ({ ...preset, routes: preset.routes.map(route => ({ ...route })) })),
      },
      ...next.lastUsedPresetId === undefined
        ? presets.value?.lastUsedPresetId === undefined
          ? []
          : [{ op: 'unset' as const, path: ['lastUsedPresetId'] }]
        : [{ op: 'set' as const, path: ['lastUsedPresetId'], value: next.lastUsedPresetId }],
    ])
    setBusy(false)
    if (!accepted) {
      setFailure(presets.writeFailure === 'conflict' ? copy.conflict : copy.presetRefused)
      return false
    }
    return true
  }

  /** Open one stored combination for editing. */
  const open = (id: string): void => {
    const preset = stored.find(candidate => candidate.id === id)
    setFailure(undefined)
    setNotice(undefined)
    if (preset === undefined) {
      // A new combination starts from what the roles carry now, so "new" is
      // never a blank page that requires re-picking a working route.
      setEditing({ id: newPresetId(stored), name: '', drafts: draftFromPreset(undefined, roles, servedRoutes) })
      return
    }
    setEditing({ id: preset.id, name: preset.name, drafts: draftFromPreset(preset, roles, servedRoutes) })
  }

  /** Store the draft under its name. */
  const save = async (): Promise<void> => {
    if (editing === undefined) return
    const name = editing.name.trim()
    if (name.length === 0 || !complete) return
    const preset: RoutePreset = { id: editing.id, name, routes: routesFromDraft(editing.drafts, roles) }
    const next = {
      presets: upsertPreset(stored, preset),
      ...presets.value?.lastUsedPresetId === undefined ? {} : { lastUsedPresetId: presets.value.lastUsedPresetId },
    }
    if (await writePresets(next)) setNotice(copy.presetSaved)
  }

  /** Drop the combination being edited. */
  const remove = async (): Promise<void> => {
    if (current === undefined) return
    const remaining = removePreset(stored, current.id)
    // The last-used pointer must not keep naming a combination nobody can pick.
    const lastUsed = presets.value?.lastUsedPresetId === current.id ? undefined : presets.value?.lastUsedPresetId
    if (!await writePresets({ presets: remaining, ...lastUsed === undefined ? {} : { lastUsedPresetId: lastUsed } })) return
    setNotice(copy.presetDeleted)
    setEditing({
      id: remaining[0]?.id ?? newPresetId(remaining),
      name: remaining[0]?.name ?? '',
      drafts: draftFromPreset(remaining[0], roles, servedRoutes),
    })
  }

  /** Edit one field of the selected role's draft, carrying what it strands. */
  const commit = (next: Partial<RoleDraft>): void => {
    if (editing === undefined || role === undefined || draft === undefined) return
    const provider = next.provider ?? draft.provider
    const providerChanged = provider !== draft.provider
    const providerGroup = providerChanged
      ? groups.find(group => group.id === provider)
      : groups.find(group => group.id === draft.provider)
    const model = next.model
      ?? (providerChanged ? modelForProvider(groups, provider, draft.model) : draft.model)
    const effort = effortFor(modelFor(providerGroup, model), next.reasoningEffort ?? draft.reasoningEffort)
    const drafts = new Map(editing.drafts)
    drafts.set(role.namespace, { provider, model, reasoningEffort: effort })
    setEditing({ ...editing, drafts })
  }

  // The pickers name the role being edited rather than the one whose route was
  // read: with one role on screen, "{role} provider" would otherwise render its
  // placeholder literally and leave three-way labels on a single control.
  const roleChanged = role === undefined ? undefined : t(role.nameKey)
  const controlLabel = (template: string): string => roleCopy(template, roleChanged ?? '')
  const providerGroup = draft === undefined ? undefined : groups.find(group => group.id === draft.provider)
  const model = modelFor(providerGroup, draft?.model ?? '')
  const efforts = model?.reasoning?.efforts ?? []

  return (
    <div className={styles['crewPresets']}>
      <div className={styles['crewPresetControls']}>
        <label className={styles['field']}>
          <span className={styles['fieldLabel']}>{copy.presetLabel}</span>
          <select
            className={`${styles['input']} ${styles['selectInput']}`}
            aria-label={copy.presetLabel}
            value={editing?.id ?? ''}
            disabled={disabled}
            onChange={(event) => { open(event.target.value) }}
          >
            {stored.length === 0 && current === undefined
              ? <option value="">{copy.presetNew}</option>
              : null}
            {stored.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
        </label>
        <label className={styles['field']}>
          <span className={styles['fieldLabel']}>{copy.presetName}</span>
          <input
            className={styles['input']}
            type="text"
            aria-label={copy.presetName}
            placeholder={copy.presetNamePlaceholder}
            value={editing?.name ?? ''}
            disabled={disabled}
            onChange={(event) => {
              if (editing === undefined) return
              setEditing({ ...editing, name: event.target.value })
            }}
          />
        </label>
      </div>
      <div className={styles['crewPresetActions']}>
        <button
          type="button"
          className={styles['primaryButton']}
          disabled={disabled || editing === undefined || editing.name.trim().length === 0 || !complete}
          onClick={() => { void save() }}
        >
          {copy.presetConfirm}
        </button>
        <button
          type="button"
          className={styles['secondaryButton']}
          disabled={disabled}
          onClick={() => { open('') }}
        >
          {copy.presetSave}
        </button>
        {current === undefined
          ? null
          : (
            <button
              type="button"
              className={`${styles['dangerButton']} ${styles['crewPresetDelete']}`}
              disabled={disabled}
              onClick={() => { void remove() }}
            >
              {copy.presetDelete}
            </button>
          )}
      </div>
      <div className={styles['crewRoleEditor']}>
        <label className={styles['field']}>
          <span className={styles['fieldLabel']}>{copy.presetRole}</span>
          <select
            className={`${styles['input']} ${styles['selectInput']}`}
            aria-label={copy.presetRole}
            value={selectedRole ?? ''}
            disabled={disabled || roles.length === 0}
            onChange={(event) => { setSelectedRole(event.target.value) }}
          >
            {roles.map(candidate => (
              <option key={candidate.namespace} value={candidate.namespace}>{t(candidate.nameKey)}</option>
            ))}
          </select>
        </label>
        {role === undefined || draft === undefined
          ? null
          : (
            <div className={styles['crewFields']} role="group" aria-label={roleChanged}>
              <RouteSelect
                label={controlLabel(copy.provider)}
                value={draft.provider}
                entries={groups}
                disabled={disabled}
                onChange={(provider) => { commit({ provider }) }}
              />
              <RouteSelect
                label={controlLabel(copy.model)}
                value={draft.model}
                entries={providerGroup?.models ?? []}
                disabled={disabled || providerGroup === undefined}
                onChange={(next) => { commit({ model: next }) }}
              />
              <EffortPicker
                label={controlLabel(copy.effort)}
                value={draft.reasoningEffort}
                efforts={efforts}
                disabled={disabled}
                onChange={(reasoningEffort) => { commit({ reasoningEffort }) }}
              />
            </div>
          )}
      </div>
      {!complete && editing !== undefined
        ? <p className={styles['notice']} role="status">{copy.presetIncomplete}</p>
        : null}
      {presets.writable ? null : <p className={styles['notice']} role="status">{copy.presetReadOnly}</p>}
      {failure !== undefined && <p className={styles['error']} role="alert">{failure}</p>}
      {notice !== undefined && <p className={styles['savedNotice']} role="status">{notice}</p>}
    </div>
  )
}

/**
 * Render the crew route block.
 * @param props - the role rows, the shared catalog, block copy, and the `t` seat.
 * @returns the block, or null while the Host serves none of its namespaces.
 */
export function CrewRouteSection({ block, copy, t }: CrewRouteSectionProps) {
  // One fold over every role handle: the combination editor needs them together,
  // and each role's own picker reads its draft instead of the handle.
  const servedSource = useMemo(() => createServedRouteSet(block.routes), [block.routes])
  const served = useSyncExternalStore(servedSource.subscribe, servedSource.getSnapshot)
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
      <CrewPresetRow block={block} served={served} copy={copy} t={t} />
    </section>
  )
}
