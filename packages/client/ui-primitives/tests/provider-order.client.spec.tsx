// @vitest-environment jsdom
/** Per-device provider ordering shared by the Models page and the model selector. */
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROVIDER_ORDER_KEY,
  applyProviderOrder,
  readProviderOrder,
  writeProviderOrder,
} from '../src/provider-order.ts'

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

  it('yields an empty list for a non-array value', () => {
    localStorage.setItem(PROVIDER_ORDER_KEY, JSON.stringify({ provider: 'a' }))
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
