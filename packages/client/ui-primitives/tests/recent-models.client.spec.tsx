// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RECENT_LIMIT,
  RECENT_MODELS_KEY,
  modelMatchesQuery,
  readRecentModels,
  useRecentModels,
  writeRecentModel,
} from '../src/recent-models.ts'

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** A stored list; `unknown` so malformed-entry cases can seed raw shapes. */
function seed(entries: unknown[]): void {
  localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(entries))
}

describe('readRecentModels', () => {
  it('returns an empty list when nothing is stored', () => {
    expect(readRecentModels()).toEqual([])
  })

  it('reads a stored list most-recent-first, capped at the limit', () => {
    const entries = Array.from({ length: RECENT_LIMIT + 2 }, (_, index) => ({ provider: 'p', model: `m${index}` }))
    seed(entries)
    expect(readRecentModels()).toEqual(entries.slice(0, RECENT_LIMIT))
  })

  it('skips malformed entries and non-object values', () => {
    seed([
      { provider: 'a', model: 'm' },
      { provider: 5, model: 'm' },
      null,
      'junk',
      { provider: 'b', model: 'n' },
    ])
    expect(readRecentModels()).toEqual([
      { provider: 'a', model: 'm' },
      { provider: 'b', model: 'n' },
    ])
  })

  it('returns an empty list for a non-array value', () => {
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify({ provider: 'a', model: 'm' }))
    expect(readRecentModels()).toEqual([])
  })

  it('returns an empty list for malformed JSON', () => {
    localStorage.setItem(RECENT_MODELS_KEY, '{not json')
    expect(readRecentModels()).toEqual([])
  })

  it('returns an empty list when storage access throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    try {
      expect(readRecentModels()).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('writeRecentModel', () => {
  it('prepends a selection and persists it for the next read', () => {
    seed([{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }])
    writeRecentModel({ provider: 'c', model: 'm3' })
    expect(readRecentModels()).toEqual([
      { provider: 'c', model: 'm3' },
      { provider: 'a', model: 'm1' },
      { provider: 'b', model: 'm2' },
    ])
  })

  it('moves a duplicate route to the front without repeating it', () => {
    seed([{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }])
    writeRecentModel({ provider: 'b', model: 'm2' })
    expect(readRecentModels()).toEqual([
      { provider: 'b', model: 'm2' },
      { provider: 'a', model: 'm1' },
    ])
  })

  it('caps the list, dropping the oldest entry', () => {
    const entries = Array.from({ length: RECENT_LIMIT }, (_, index) => ({ provider: 'p', model: `m${index}` }))
    seed(entries)
    writeRecentModel({ provider: 'new', model: 'm' })
    const result = readRecentModels()
    expect(result).toHaveLength(RECENT_LIMIT)
    expect(result[0]).toEqual({ provider: 'new', model: 'm' })
    expect(result.some(item => item.model === `m${RECENT_LIMIT - 1}`)).toBe(false)
  })

  it('survives a storage write failure without throwing', () => {
    seed([{ provider: 'a', model: 'm1' }])
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    try {
      expect(() => { writeRecentModel({ provider: 'c', model: 'm3' }) }).not.toThrow()
      expect(readRecentModels()).toEqual([{ provider: 'a', model: 'm1' }])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('modelMatchesQuery', () => {
  const group = { name: 'DeepSeek' }
  const model = { id: 'deepseek-chat', name: 'DeepSeek Chat' }

  it('matches everything for a blank or whitespace query', () => {
    expect(modelMatchesQuery(group, model, '')).toBe(true)
    expect(modelMatchesQuery(group, model, '   ')).toBe(true)
  })

  it('matches the model id case-insensitively', () => {
    expect(modelMatchesQuery(group, model, 'DEEPSEEK-CHAT')).toBe(true)
  })

  it('matches the model name when the id misses', () => {
    expect(modelMatchesQuery(group, { id: 'zzz', name: 'Claude Sonnet' }, 'sonnet')).toBe(true)
  })

  it('matches the provider name when both model fields miss', () => {
    expect(modelMatchesQuery(group, { id: 'zzz', name: 'QwQ' }, 'deepseek')).toBe(true)
  })

  it('returns false when nothing matches', () => {
    expect(modelMatchesQuery(group, model, 'groq')).toBe(false)
  })
})

describe('useRecentModels', () => {
  function Harness() {
    const { recent, record } = useRecentModels()
    return (
      <div>
        <span data-testid="count">{recent.length}</span>
        {recent.map(item => <span key={`${item.provider}/${item.model}`} data-testid="entry">{`${item.provider}/${item.model}`}</span>)}
        <button type="button" onClick={() => { record({ provider: 'c', model: 'm3' }) }}>record</button>
      </div>
    )
  }

  it('initializes from the stored list', () => {
    seed([{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }])
    render(<Harness />)
    expect(screen.getByTestId('count').textContent).toBe('2')
    expect(Array.from(screen.getAllByTestId('entry')).map(node => node.textContent))
      .toEqual(['a/m1', 'b/m2'])
  })

  it('records a selection into state and storage', () => {
    seed([{ provider: 'a', model: 'm1' }])
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'record' }))
    expect(screen.getByTestId('count').textContent).toBe('2')
    expect(Array.from(screen.getAllByTestId('entry')).map(node => node.textContent))
      .toEqual(['c/m3', 'a/m1'])
    expect(readRecentModels()[0]).toEqual({ provider: 'c', model: 'm3' })
  })
})
