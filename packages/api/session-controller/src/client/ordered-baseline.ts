/** Shared default for callers that grace no identity through an absence. */
const NO_RETAINED_KEYS: ReadonlySet<unknown> = new Set()

/**
 * Merge an authoritative baseline without moving identities already visible to
 * the client. Baseline-only identities are inserted relative to the nearest
 * following known identity; identities absent from the baseline are removed
 * unless `retainAbsent` names them — the caller's absence grace, which keeps a
 * transiently missing row (the whole-list re-pull a phone foreground resync
 * triggers) in place instead of deleting it out from under the selection.
 *
 * @param current - the established client order.
 * @param baseline - the latest authoritative rows.
 * @param keyOf - stable identity selector.
 * @param retainAbsent - keys to keep although this baseline lacks them.
 * @returns baseline-valued rows with the established relative order retained.
 */
export function mergeOrderedBaseline<T>(
  current: readonly T[],
  baseline: readonly T[],
  keyOf: (value: T) => unknown,
  retainAbsent: ReadonlySet<unknown> = NO_RETAINED_KEYS,
): T[] {
  const baselineByKey = new Map<unknown, T>()
  for (const value of baseline) baselineByKey.set(keyOf(value), value)

  const merged = current
    .map((value) => {
      const authoritative = baselineByKey.get(keyOf(value))
      if (authoritative !== undefined) return authoritative
      return retainAbsent.has(keyOf(value)) ? value : undefined
    })
    .filter((value): value is T => value !== undefined)
  const mergedKeys = new Set(merged.map(keyOf))

  for (let index = 0; index < baseline.length; index++) {
    const value = baseline[index]
    /* v8 ignore next -- dense-array guard: index is bounded by baseline.length. */
    if (value === undefined || mergedKeys.has(keyOf(value))) continue
    let insertion = merged.length
    for (let following = index + 1; following < baseline.length; following++) {
      const candidate = baseline[following]
      /* v8 ignore next -- dense-array guard: following is bounded by baseline.length. */
      if (candidate === undefined) continue
      const known = merged.findIndex(item => keyOf(item) === keyOf(candidate))
      if (known !== -1) {
        insertion = known
        break
      }
    }
    merged.splice(insertion, 0, value)
    mergedKeys.add(keyOf(value))
  }
  return merged
}
