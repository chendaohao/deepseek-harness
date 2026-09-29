/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Two-level selection per figma 496:26454's MenuDropdown: the root menu is
 * the Model / Effort row pair (label + current value + a right chevron),
 * each drilling into its own list — the provider-grouped model list over
 * the shared directory, and the effort levels. The trigger (313:14108's
 * ToggleButton) shows both: model name + effort in the caption tone.
 *
 * Model catalogs above four entries show search, which retains focus while
 * ↑/↓ cycle the highlighted result; Enter and Tab accept it. Smaller model
 * catalogs, root panes, and effort panes move focus between rows. Escape and
 * Shift+Tab leave a drilled pane first and otherwise close back to the
 * trigger, and Escape clears a non-empty query before that. A drilled pane
 * focuses the current effort or model search field. Provider headings paint
 * their background only while pinned by scrolling, and each collapses under
 * its own header. Clearing a query restores the full list and search focus.
 * Selecting restores trigger focus without a ring until the trigger loses
 * focus or the menu reopens. Search matches a case-insensitive ordered
 * subsequence of the model name or its provider name, ranked by prefix,
 * alignment score, then catalog order. A pinned recently-used section
 * re-offers the last picks the current catalog still advertises, and provider
 * groups follow the per-device order the Models settings page persists;
 * search, recent, collapse, and that order all live in this seat. Returning to
 * the root pane hands focus back to the cell that opened it. Data and
 * submission ride the same per-session ModelDirectory as the /model popup;
 * exact-model reasoning metadata and the selected effort come from the Host
 * rather than a client-owned vocabulary. A rejected selection announces
 * through the shared transient Toast anchored to the composer card; the
 * in-menu strip with Retry remains the catalog-load surface. While the
 * directory's pending selection is unsettled, the trigger shows a spinner in
 * place of its chevron, and each row whose value that selection carries shows
 * one in place of its check mark. A plain model pick names the route alone so
 * the host restores any remembered effort for it; the effort pane marks its
 * picks explicit.
 */
import { MenuGroup, MenuSurface, observeStickyMenuGroups } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type FocusEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  applyProviderOrder, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular,
  IconCloseFillRegular, IconDataOutlineRegular, IconWarningOutlineRegular, Input, rankByName, readProviderOrder,
  StateDot, Toast, useRecentModels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import { orderModelProviders } from './provider-order.ts'
import css from './ModelSelect.module.css'

/** Which pane the dropdown shows: the two-row root or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort'

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

/** A provider group and one of its models, the pair a row renders from. */
interface ProviderRef {
  readonly id: string
  readonly name: string
}

/** Unplaced portal card: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real (Menu primitive's measure pass). */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect(
  { locked, available, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const [selectionFocus, setSelectionFocus] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const { recent, record } = useRecentModels()
  // The provider order the Models settings page persists, re-read on open so a
  // drag there is what this menu shows next.
  const [providerOrder, setProviderOrder] = useState<readonly string[]>(() => readProviderOrder())
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const groupsRef = useRef<HTMLDivElement | null>(null)
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  // Row refs addressed by highlight index. `itemRefs` cannot serve: the
  // collapsible group headings register there too, so its positions and the
  // flattened row indices diverge.
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  // The account route leads and the official one follows until the Models
  // settings page records a manual order, which then wins for the providers
  // it names.
  const groups = useMemo(
    () => applyProviderOrder(orderModelProviders(state.groups), providerOrder, group => group.id),
    [state.groups, providerOrder],
  )
  // A model pick names the route alone: the host restores the user's
  // remembered effort for it when one exists, or falls back to the model
  // default — naming the default here would overwrite the memory every switch.
  const choices = useMemo(() => groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: { provider: group.id, model: model.id } satisfies ModelSelection,
    }))), [groups])
  const showSearch = choices.length > 4
  const activeQuery = showSearch ? query.trim() : ''
  // The provider name rides as each model's second search key, so a query like
  // a vendor name still reaches that vendor's whole catalog.
  const rankedGroups = useMemo(() => groups.map(group => ({
    ...group,
    models: rankByName(
      group.models.map(model => ({ ...model, label: group.name })),
      activeQuery,
    ),
  })).filter(group => group.models.length > 0), [groups, activeQuery])
  // Recently-used routes the current catalog still advertises, in recency
  // order; stale entries vanish from the display without touching storage. A
  // query hides the section, whose rows would duplicate the matches below it.
  const recentChoices = useMemo(() => activeQuery !== ''
    ? []
    : recent
      .map(entry => choices.find(choice =>
        choice.selection.provider === entry.provider && choice.selection.model === entry.model))
      .filter((choice): choice is NonNullable<typeof choice> => choice !== undefined),
  [recent, choices, activeQuery])
  // The highlight index space, in render order: the recent rows first, then
  // each ranked group's rows.
  const visibleModels = useMemo(() => [
    ...recentChoices.map(choice => ({ provider: choice.group.id, model: choice.model.id })),
    ...rankedGroups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id }))),
  ], [rankedGroups, recentChoices])
  /** Highlight index of each ranked group's first row, parallel to {@link rankedGroups}. */
  const groupStarts = useMemo(() => {
    let at = recentChoices.length
    return rankedGroups.map((group) => {
      const start = at
      at += group.models.length
      return start
    })
  }, [rankedGroups, recentChoices])
  const currentVisibleIndex = visibleModels.findIndex(model =>
    model.provider === state.current?.provider && model.model === state.current.model)
  const activeModelIndex = Math.min(highlightedIndex ?? Math.max(0, currentVisibleIndex), visibleModels.length - 1)
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? state.retainedEffort
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [reasoning, t])
  const { pending } = state
  const busy = pending !== null

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      // The portaled card is outside the trigger subtree; check both.
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  useLayoutEffect(() => {
    if (!showSearch) {
      setQuery('')
      setHighlightedIndex(null)
    }
  }, [showSearch])

  // Pane switches unmount the focused row; restore focus inside the menu so
  // keyboard navigation remains available.
  const paneFocus = useRef<'drill' | 'model' | 'effort' | null>(null)
  const previousShowSearch = useRef(showSearch)
  useEffect(() => {
    const changedSearchMode = previousShowSearch.current !== showSearch
    previousShowSearch.current = showSearch
    const intent = paneFocus.current ?? (changedSearchMode && pane === 'model' ? 'drill' : null)
    paneFocus.current = null
    if (!open || intent === null) return
    if (intent === 'drill') {
      if (pane === 'model' && showSearch) {
        searchRef.current?.focus()
        return
      }
      // The checked row is the value in use; a pane without one opens on its
      // first row. Group headings are collapse toggles, not menu rows, so a
      // keyboard walk stays on the selectable options.
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      const target = checked ?? rowRefs.current.find(row => row !== null && !row.disabled)
      // Rows a selection in flight disabled cannot take the keyboard; the
      // trigger does, so the card's keys still reach the menu.
      ;(target ?? triggerRef.current)?.focus()
      return
    }
    const cell = itemRefs.current[intent === 'effort' ? 1 : 0]
    ;(cell !== null && cell !== undefined && !cell.disabled ? cell : triggerRef.current)?.focus()
  }, [open, pane, showSearch])

  useEffect(() => {
    const viewport = groupsRef.current
    if (viewport === null) return
    return observeStickyMenuGroups(viewport)
  }, [available, open, pane, rankedGroups])

  useLayoutEffect(() => {
    if (open && pane === 'model' && activeModelIndex >= 0) {
      rowRefs.current[activeModelIndex]?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, pane, activeModelIndex, visibleModels])

  // Portaled placement (the Menu primitive's portal rules: fixed from the
  // anchor rect, measured before paint, clamped inside the viewport): above
  // the trigger, right edges aligned. Depends on pane and directory state
  // because pane switches and async catalog loads resize the card.
  /* jscpd:ignore-start -- deliberate mirror of ui-primitives useAnchoredPosition:
     that hook only places from the anchor's LEFT edge, while this card aligns
     right edges (x = rect.right - width), so the measure-and-clamp plumbing repeats. */
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return }
    const place = (): void => {
      /* v8 ignore next 2 -- the trigger ref is attached whenever the menu is open. */
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const MARGIN = 12
      const lw = menuRef.current?.offsetWidth ?? 0
      const lh = menuRef.current?.offsetHeight ?? 0
      let x = rect.right - lw
      let y = rect.top - 8 - lh
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN)
      setMenuPos({ left: x, top: y })
    }
    // First run measures the hidden pre-render (same commit as `open`), so
    // the card lands placed before anything paints.
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, pane, state, query])
  /* jscpd:ignore-end */

  if (!available) return null

  const show = (): void => {
    setSelectionFocus(false)
    triggerRef.current?.focus()
    setQuery('')
    setHighlightedIndex(null)
    setCollapsed(new Set())
    setProviderOrder(readProviderOrder())
    if (state.current === null) paneFocus.current = 'drill'
    setPane(state.current === null ? 'model' : 'root')
    setOpen(true)
    reload()
  }

  const changeQuery = (next: string): void => {
    setQuery(next)
    setHighlightedIndex(0)
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const closeAfterSelection = (): void => {
    setSelectionFocus(true)
    close(true)
  }

  const drill = (next: Pane): void => {
    setQuery('')
    setHighlightedIndex(null)
    paneFocus.current = 'drill'
    setPane(next)
  }

  /** Leave a drilled pane for the root one, handing the keyboard back to its cell. */
  const back = (from: Exclude<Pane, 'root'>): void => {
    paneFocus.current = from
    setPane('root')
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    // Focus outside the rows (the trigger, which keeps it while the menu
    // opens) enters at the end the step comes from: the first row forward,
    // the last row backward.
    const next = active === -1
      ? (offset > 0 ? 0 : items.length - 1)
      : (active + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape clears a model search first, then backs out of a drilled pane,
      // then closes.
      if (pane === 'model' && query !== '') {
        changeQuery('')
        return
      }
      if (pane !== 'root' && state.current !== null) back(pane)
      else close(true)
      return
    }
    if (!open) return
    if (pane === 'model' && showSearch && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      if (!busy && visibleModels.length > 0) {
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setHighlightedIndex((activeModelIndex + direction + visibleModels.length) % visibleModels.length)
        searchRef.current?.focus()
      }
      return
    }
    if (pane === 'model' && showSearch && event.target instanceof HTMLInputElement
      && (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
      if (event.key === 'Tab' && visibleModels.length === 0) return
      event.preventDefault()
      const highlighted = visibleModels[activeModelIndex]
      if (!busy && highlighted !== undefined) choose(highlighted)
      return
    }
    // Tab settles like Enter and Shift+Tab leaves like Escape, so the menu's
    // keys mean what they mean in the composer. Both are consumed: the card
    // keeps the browser's focus traversal out while it is open.
    if (event.key === 'Tab') {
      if (event.shiftKey) {
        event.preventDefault()
        if (pane !== 'root' && state.current !== null) back(pane)
        else close(true)
        return
      }
      // Settling activates the row the keyboard is on; with focus still on the
      // trigger, Tab enters the menu at the value in use instead. Any other
      // control inside the card (a retry button) keeps the browser's traversal,
      // so the keystroke stays unconsumed there.
      const focused = document.activeElement
      const rows = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
      if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
        event.preventDefault()
        focused.click()
        return
      }
      if (focused !== triggerRef.current) return
      event.preventDefault()
      if (pane === 'model' && showSearch) {
        setHighlightedIndex(null)
        searchRef.current?.focus()
        return
      }
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      ;(checked ?? rows.find(item => !item.disabled))?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && (
      rootRef.current?.contains(event.relatedTarget) === true
      || menuRef.current?.contains(event.relatedTarget) === true
    )) return
    close()
  }

  const settleSelection = (result: Awaited<ReturnType<ModelSelectInjected['select']>>): void => {
    if (result === undefined) return
    if (result.ok) {
      if (rootRef.current !== null) closeAfterSelection()
      return
    }
    const { error } = result
    toastSeq.current += 1
    setToast({
      seq: toastSeq.current,
      text: error.code === 'session/writer-held'
        ? t('error.sessionInUse')
        : t('error.action', { message: `${error.code}: ${error.message}` }),
    })
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      closeAfterSelection()
      return
    }
    lastActionRef.current = 'select'
    // Disabled option rows cannot retain focus while a selection is pending.
    setSelectionFocus(true)
    triggerRef.current?.focus()
    void select(selection).then((result) => {
      if (result?.ok === true) record({ provider: selection.provider, model: selection.model })
      settleSelection(result)
    })
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      closeAfterSelection()
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    // Explicit, even for the provider-default row: an omitted effort here
    // must clear the remembered one, not read as a plain model switch.
    lastActionRef.current = 'select'
    setSelectionFocus(true)
    triggerRef.current?.focus()
    void select(selection, true).then((result) => {
      if (result === undefined || !result.ok) {
        settleSelection(result)
        return
      }
      // A pick the model cannot take is normalized by the host to its declared
      // default; surface that so the fallback is not silent.
      const landed = directory.getSnapshot().current?.reasoningEffort
      if (effort !== undefined && landed !== undefined && landed !== effort) {
        const label = reasoning?.efforts.find(level => level.id === landed)?.name ?? landed
        toastSeq.current += 1
        setToast({ seq: toastSeq.current, text: t('effort.normalized', { effort: label }) })
      }
      settleSelection(result)
    })
  }

  const waiting = state.current === null && state.status === 'loading'
  const modelLabel = waiting
    ? t('trigger.loading')
    : currentChoice?.model.name
      ?? (state.current === null ? t('trigger.fallback') : `${state.current.provider}/${state.current.model}`)
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = waiting
    ? t('trigger.loading')
    : state.current === null
      ? t('trigger.selectAria')
      : effortLabel === undefined
        ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  itemRefs.current = []
  rowRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }
  /**
   * Bind one model row to both index spaces: `itemRefs` walks it with the
   * group headings, `rowRefs` addresses it by highlight index.
   * @param at - the row's position in the flattened visible list.
   * @returns the ref callback for that row.
   */
  const bindRow = (at: number) => {
    const setItem = itemRef()
    return (node: HTMLButtonElement | null) => {
      setItem(node)
      rowRefs.current[at] = node
    }
  }

  /** The localized provider name one group heading or secondary row line shows. */
  const providerLabel = (group: ProviderRef): string =>
    group.id === 'deepseek-account' ? t('provider.account') : group.name

  /**
   * One selectable model row. Rows render in the flattened visible-list order,
   * so the caller passes the index search navigation highlights.
   * @param index - the row's position in the flattened visible list.
   * @param group - the owning provider group.
   * @param model - the row's model.
   * @param secondary - provider name to show when the row sits outside its own group.
   * @returns the row button, carrying the highlighted state search navigation reads.
   */
  const renderModelRow = (
    index: number,
    group: ProviderRef,
    model: { id: string; name: string },
    secondary?: string,
  ) => {
    const selected = state.current?.provider === group.id && state.current.model === model.id
    return (
      <button
        ref={bindRow(index)}
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        id={`${id}-model-${index}`}
        tabIndex={showSearch ? -1 : 0}
        onFocus={() => { setHighlightedIndex(index) }}
        data-highlighted={index === activeModelIndex ? '' : undefined}
        className={clsx(
          css.option, css.modelOption, selected && css.selected, index === activeModelIndex && css.optionActive,
        )}
        onMouseMove={busy || index === activeModelIndex ? undefined : () => {
          if (showSearch) setHighlightedIndex(index)
          else rowRefs.current[index]?.focus()
        }}
        key={`${group.id}/${model.id}`}
        title={model.name}
        disabled={busy}
        onClick={() => { choose({ provider: group.id, model: model.id }) }}
      >
        <span className={css.optionCopy}>
          <span className={css.modelName}>{model.name}</span>
          {secondary !== undefined && <span className={css.description}>{secondary}</span>}
        </span>
        <span className={css.check}>
          {pending?.provider === group.id && pending.model === model.id
            ? <StateDot state="ongoing" />
            : selected ? <IconCheckOutlineRegular /> : null}
        </span>
      </button>
    )
  }

  return (
    <div
      ref={rootRef}
      className={css.root}
      onKeyDown={onRootKeyDown}
      onBlur={onBlur}
      onMouseDown={(event) => {
        // WebKit blurs a focused row before click unless the button's mousedown keeps focus.
        if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        aria-busy={busy}
        data-selection-focus={selectionFocus ? '' : undefined}
        onBlur={() => { setSelectionFocus(false) }}
        disabled={locked}
        onClick={() => {
          if (open) {
            close(true)
          } else {
            show()
          }
        }}
      >
        <IconDataOutlineRegular className={css.triggerIcon} size={16} />
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        {busy
          ? <StateDot state="ongoing" />
          : <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />}
      </button>

      {/* Portaled to body (Menu primitive's portal mode) so the sidebar and
          column overflow clips cannot crop the card; synthetic events still
          bubble through this React subtree, keeping onKeyDown/onBlur live. */}
      {open && createPortal(
        <MenuSurface
          ref={menuRef}
          id={`${id}-menu`}
          className={css.menu}
          style={menuPos ?? MEASURE_STYLE}
          role={pane === 'model' ? 'group' : 'menu'}
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {pane === 'root' && (
            <>
              <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('model') }}>
                <span className={css.cellLabel}>{t('menu.model')}</span>
                <span className={css.cellValue}>{modelLabel}</span>
                <IconChevronRightOutlineRegular className={css.cellChevron} />
              </button>
              {reasoning !== undefined && (
                <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('effort') }}>
                  <span className={css.cellLabel}>{t('menu.effort')}</span>
                  <span className={css.cellValue}>{effortLabel}</span>
                  <IconChevronRightOutlineRegular className={css.cellChevron} />
                </button>
              )}
            </>
          )}

          {pane === 'model' && (
            <>
              {showSearch && <div className={css.searchRow}>
                <Input
                  ref={searchRef}
                  className={clsx(css.search, query !== '' && css.searchWithQuery)}
                  type="text"
                  role="searchbox"
                  aria-label={t('search.placeholder')}
                  aria-controls={`${id}-models`}
                  aria-activedescendant={activeModelIndex < 0 ? undefined : `${id}-model-${activeModelIndex}`}
                  placeholder={t('search.placeholder')}
                  value={query}
                  readOnly={busy}
                  onChange={(event) => { changeQuery(event.target.value) }}
                />
                {query !== '' && (
                  <button
                    type="button"
                    className={css.searchClear}
                    aria-label={t('search.clear')}
                    disabled={busy}
                    onClick={() => {
                      changeQuery('')
                      searchRef.current?.focus()
                    }}
                  >
                    <IconCloseFillRegular />
                  </button>
                )}
              </div>}
              {state.status === 'loading' && (
                <div className={css.status}>{t('status.loading')}</div>
              )}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              {state.failures.map(failure => (
                <div className={css.warning} key={failure.id}>
                  <span>{t('warning.groupLoad', { name: failure.id === 'deepseek-account' ? t('provider.account') : failure.name, message: failure.message })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              ))}
              <div
                ref={groupsRef}
                id={`${id}-models`}
                className={clsx(css.groups, 'scrollable')}
                role="menu"
                aria-label={t('menu.model')}
                hidden={rankedGroups.length === 0}
              >
                {recentChoices.length > 0 && (
                  <MenuGroup key="recent" label={t('recent.title')}>
                    {recentChoices.map((choice, at) =>
                      renderModelRow(at, choice.group, choice.model, providerLabel(choice.group)))}
                  </MenuGroup>
                )}
                {rankedGroups.map((group, groupIndex) => {
                  const modelsId = `${id}-${group.id}-models`
                  const isCollapsed = collapsed.has(group.id)
                  const groupStart = groupStarts[groupIndex] ?? recentChoices.length
                  return (
                    <MenuGroup
                      key={group.id}
                      label={
                        <button
                          type="button"
                          className={css.groupToggle}
                          aria-expanded={!isCollapsed}
                          aria-controls={modelsId}
                          onClick={() => {
                            setCollapsed((previous) => {
                              const next = new Set(previous)
                              if (next.has(group.id)) next.delete(group.id)
                              else next.add(group.id)
                              return next
                            })
                          }}
                        >
                          <span>{providerLabel(group)}</span>
                          <span className={css.groupBadge} aria-hidden="true">{group.models.length}</span>
                          <IconChevronDownOutlineRegular aria-hidden="true" className={clsx(css.groupChevron, isCollapsed && css.groupChevronCollapsed)} />
                        </button>
                      }
                    >
                      <div id={modelsId} hidden={isCollapsed}>
                        {group.models.map((model, at) => renderModelRow(groupStart + at, group, model))}
                      </div>
                    </MenuGroup>
                  )
                })}
              </div>
              {state.status === 'ready' && rankedGroups.length === 0 && (
                <div className={css.empty} role="status">
                  {t(choices.length === 0 ? 'empty.models' : 'search.empty')}
                </div>
              )}
            </>
          )}

          {pane === 'effort' && (
            <>
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                </div>
              )}
              {effortChoices.length === 0
                ? <div className={css.empty}>{t('empty.efforts')}</div>
                : effortChoices.map(level => (
                  <button
                    ref={itemRef()}
                    type="button"
                    role="menuitemradio"
                    aria-checked={effectiveEffort === level.effort}
                    className={clsx(css.option, effectiveEffort === level.effort && css.selected)}
                    key={level.key}
                    disabled={busy}
                    onClick={() => { chooseEffort(level.effort) }}
                  >
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{level.label}</span>
                    </span>
                    <span className={css.check}>
                      {pending !== null && pending.provider === state.current?.provider
                        && pending.model === state.current.model && pending.reasoningEffort === level.effort
                        ? <StateDot state="ongoing" />
                        : effectiveEffort === level.effort ? <IconCheckOutlineRegular /> : null}
                    </span>
                  </button>
                ))}
            </>
          )}
        </MenuSurface>,
        document.body,
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
