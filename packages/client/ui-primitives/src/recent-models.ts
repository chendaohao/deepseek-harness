/**
 * Recently used chat models, shared by every model-picking surface (the web
 * composer dropdown and the mobile remote sheet). The list is a per-device
 * UI convenience: it lives in localStorage, is capped and self-pruning, and
 * never feeds a model request, so it stays off the session log.
 *
 * `modelMatchesQuery` is the single filter implementation both surfaces use,
 * so their search behavior cannot drift.
 */
import { useCallback, useState } from 'react'

/** localStorage key holding the JSON recent-model list. */
export const RECENT_MODELS_KEY = 'dsh:recent-models'

/** How many recent models are remembered; older entries rotate off. */
export const RECENT_LIMIT = 5

/** One remembered provider/model route. */
export interface RecentModel {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/**
 * Read the persisted recent-model list, most-recent first.
 * Any storage or parse failure (private mode, corrupted value) yields an
 * empty list; storage stays bounded by {@link RECENT_LIMIT}.
 * @returns the valid, capped recent routes.
 */
export function readRecentModels(): RecentModel[] {
  try {
    const raw = localStorage.getItem(RECENT_MODELS_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const items: RecentModel[] = []
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue
      const { provider, model } = entry as Record<string, unknown>
      if (typeof provider !== 'string' || typeof model !== 'string') continue
      items.push({ provider, model })
    }
    return items.slice(0, RECENT_LIMIT)
  } catch {
    return []
  }
}

/**
 * Persist a bounded list, most-recent first. A storage failure (private mode)
 * is non-fatal: the caller's in-memory state still reflects the change.
 * @param entries - the complete list to store.
 */
function persistRecentModels(entries: readonly RecentModel[]): void {
  try {
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(entries.slice(0, RECENT_LIMIT)))
  } catch {
    // Private-mode storage failures are non-fatal; the session keeps its choice.
  }
}

/**
 * Record one selection as the most recent; duplicate routes move to the front
 * and the list is capped at {@link RECENT_LIMIT}.
 * @param selection - the route to promote.
 */
export function writeRecentModel(selection: RecentModel): void {
  const deduped = readRecentModels().filter(
    item => item.provider !== selection.provider || item.model !== selection.model,
  )
  persistRecentModels([selection, ...deduped])
}

/** One route taken off the list, with where it sat so it can go back there. */
export interface RecentRemoval {
  /** The route that left the list. */
  readonly selection: RecentModel
  /** Zero-based position it occupied before removal. */
  readonly index: number
}

/**
 * Take one route off the persisted list, leaving every other entry in place.
 * @param selection - the route to forget.
 * @returns where it sat, for {@link restoreRecentModel}; undefined when the
 * list did not hold it.
 */
export function removeRecentModel(selection: RecentModel): RecentRemoval | undefined {
  const current = readRecentModels()
  const index = current.findIndex(
    item => item.provider === selection.provider && item.model === selection.model,
  )
  if (index === -1) return undefined
  persistRecentModels(current.filter((_item, at) => at !== index))
  return { selection, index }
}

/**
 * Put a removed route back where it was. A route already present is not
 * duplicated, and a position past the current end lands last.
 * @param removal - the record {@link removeRecentModel} returned.
 */
export function restoreRecentModel(removal: RecentRemoval): void {
  const rest = readRecentModels().filter(
    item => item.provider !== removal.selection.provider || item.model !== removal.selection.model,
  )
  const at = Math.min(removal.index, rest.length)
  persistRecentModels([...rest.slice(0, at), removal.selection, ...rest.slice(at)])
}

/**
 * Search predicate over a provider group and one of its models. Matching is a
 * case-insensitive substring over the model id, the model name, and the
 * provider name, so a user can type either a model or a provider.
 * @param group - the provider group (only its name is matched).
 * @param model - the model (id and name are matched).
 * @param query - the raw search text; blank matches everything.
 * @returns whether the model matches the query.
 */
export function modelMatchesQuery(
  group: { name: string },
  model: { id: string; name: string },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return model.id.toLowerCase().includes(needle)
    || model.name.toLowerCase().includes(needle)
    || group.name.toLowerCase().includes(needle)
}

/**
 * React binding over {@link readRecentModels} / {@link writeRecentModel} /
 * {@link removeRecentModel}. Each action persists first, then re-reads, so the
 * hook never renders a list the device did not store.
 * @returns the current recent list plus `record` (promote one route), `forget`
 * (take one off, returning where it sat), and `restore` (put one back).
 */
export function useRecentModels(): {
  recent: RecentModel[]
  record: (selection: RecentModel) => void
  forget: (selection: RecentModel) => RecentRemoval | undefined
  restore: (removal: RecentRemoval) => void
} {
  const [recent, setRecent] = useState<RecentModel[]>(() => readRecentModels())
  const record = useCallback((selection: RecentModel): void => {
    writeRecentModel(selection)
    setRecent(readRecentModels())
  }, [])
  const forget = useCallback((selection: RecentModel): RecentRemoval | undefined => {
    const removal = removeRecentModel(selection)
    setRecent(readRecentModels())
    return removal
  }, [])
  const restore = useCallback((removal: RecentRemoval): void => {
    restoreRecentModel(removal)
    setRecent(readRecentModels())
  }, [])
  return { recent, record, forget, restore }
}
