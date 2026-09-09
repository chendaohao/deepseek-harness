// @vitest-environment jsdom
/** Per-device provider ordering: persistence, reordering, and store join. */
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROVIDER_ORDER_KEY,
  applyProviderOrder,
  readProviderOrder,
  writeProviderOrder,
} from '../src/client/provider-order.ts'
import { reorderedProviderIds } from '../src/client/ModelsSection.tsx'

afterEach(() => { localStorage.removeItem(PROVIDER_ORDER_KEY) })

describe('provider order persistence', () => {
  it('round-trips an order through storage', () => {
    expect(readProviderOrder()).toEqual([])
    writeProviderOrder(['b', 'a'])
    expect(readProviderOrder()).toEqual(['b', 'a'])
  })

  it('yields an empty list on corrupted JSON', () => {
    localStorage.setItem(PROVIDER_ORDER_KEY, '{not json')
    expect(readProviderOrder()).toEqual([])
  })

  it('drops non-string entries from a corrupted list', () => {
    localStorage.setItem(PROVIDER_ORDER_KEY, '["a", 3, null, "b"]')
    expect(readProviderOrder()).toEqual(['a', 'b'])
  })
})

describe('applyProviderOrder', () => {
  const rows = [{ p: 'a' }, { p: 'b' }, { p: 'c' }]
  const providerOf = (row: { p: string }): string => row.p

  it('reorders rows into the persisted order', () => {
    expect(applyProviderOrder(rows, ['c', 'a', 'b'], providerOf)).toEqual([{ p: 'c' }, { p: 'a' }, { p: 'b' }])
  })

  it('appends unpositioned rows after the positioned ones in directory order', () => {
    expect(applyProviderOrder(rows, ['b'], providerOf)).toEqual([{ p: 'b' }, { p: 'a' }, { p: 'c' }])
    expect(applyProviderOrder(rows, ['c', 'a'], providerOf)).toEqual([{ p: 'c' }, { p: 'a' }, { p: 'b' }])
  })

  it('returns the rows unchanged for an empty order', () => {
    expect(applyProviderOrder(rows, [], providerOf)).toEqual(rows)
  })
})

describe('reorderedProviderIds', () => {
  const ids = ['a', 'b', 'c']

  it('moves a row onto another slot between the two ends', () => {
    expect(reorderedProviderIds(ids, 0, 2)).toEqual(['b', 'c', 'a'])
    expect(reorderedProviderIds(ids, 2, 0)).toEqual(['c', 'a', 'b'])
    expect(reorderedProviderIds(ids, 1, 2)).toEqual(['a', 'c', 'b'])
  })

  it('keeps the order for coincident or out-of-range slots', () => {
    expect(reorderedProviderIds(ids, 1, 1)).toEqual(ids)
    expect(reorderedProviderIds(ids, -1, 0)).toEqual(ids)
    expect(reorderedProviderIds(ids, 0, 3)).toEqual(ids)
  })
})
