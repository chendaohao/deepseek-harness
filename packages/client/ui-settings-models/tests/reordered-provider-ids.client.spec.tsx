// @vitest-environment jsdom
/** Drag geometry: which slot a dragged provider row lands in. */
import { describe, expect, it } from 'vitest'
import { reorderedProviderIds } from '../src/client/ModelsSection.tsx'

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
