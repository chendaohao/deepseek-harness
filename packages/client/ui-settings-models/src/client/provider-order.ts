/**
 * Per-device manual ordering of the Models page provider rows. The order is a
 * browser UI convenience: it lives in localStorage, follows the
 * recent-models precedent, and never reaches the Host — the provider
 * directory itself stays Host-owned, and a paired (forwarded) client stays
 * read-only against settings, so a Host copy would be unwritable from the
 * surfaces this ordering exists for.
 */

/** localStorage key holding the JSON provider-order list. */
export const PROVIDER_ORDER_KEY = 'dsh:provider-order'

/**
 * Read the persisted provider order.
 * @returns the valid provider ids, first rendered first; any storage or
 *   parse failure (private mode, corrupted value) yields an empty list.
 */
export function readProviderOrder(): string[] {
  try {
    const raw = localStorage.getItem(PROVIDER_ORDER_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    return []
  }
}

/**
 * Persist one provider order; storage failure (private mode) is non-fatal —
 * the in-memory state already reflects the ordering.
 * @param order - the provider ids, first rendered first.
 */
export function writeProviderOrder(order: readonly string[]): void {
  try {
    localStorage.setItem(PROVIDER_ORDER_KEY, JSON.stringify(order))
  } catch {
    /* private mode or quota: keep the session-local ordering */
  }
}

/**
 * Reorder rows into the persisted order.
 * @param rows - rows in directory order.
 * @param order - the persisted provider ids, first rendered first.
 * @param providerOf - extracts the provider id from one row.
 * @returns the rows in the persisted order, with rows absent from it
 *   (providers added since the order was saved) keeping their relative
 *   directory order appended after the positioned ones.
 */
export function applyProviderOrder<T>(
  rows: readonly T[],
  order: readonly string[],
  providerOf: (row: T) => string,
): T[] {
  if (order.length === 0) return [...rows]
  const position = new Map(order.map((provider, index) => [provider, index]))
  const positioned = rows
    .map(row => ({ row, at: position.get(providerOf(row)) }))
    .filter((entry): entry is { row: T; at: number } => entry.at !== undefined)
  const unpositioned = rows.filter(row => position.get(providerOf(row)) === undefined)
  positioned.sort((left, right) => left.at - right.at)
  return [...positioned.map(entry => entry.row), ...unpositioned]
}
