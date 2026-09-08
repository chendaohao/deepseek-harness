import { describe, expect, it } from 'vitest'
import {
  currentRequestFacts,
  factsFrom,
  runWithRequestFacts,
} from '../src/request-facts.ts'

describe('request facts propagation', () => {
  it('installs facts for the wrapped call and its awaited callees', async () => {
    const facts = factsFrom({ headers: { 'X-Dsh-Proxied': '1', 'accept': 'text/html', 'cookie': ['a', 'b'] as unknown as string } })
    // Header names are lower-cased and array-valued entries are dropped, matching
    // the fetch bridge's single-string filter.
    expect(facts.headers).toEqual({ 'x-dsh-proxied': '1', accept: 'text/html' })
    const seen: Array<unknown> = []
    await runWithRequestFacts(facts, async () => {
      seen.push(currentRequestFacts())
      await Promise.resolve()
      // The context survives an awaited boundary.
      seen.push(currentRequestFacts())
    })
    expect(seen).toEqual([facts, facts])
  })

  it('reports no facts outside any request scope', () => {
    expect(currentRequestFacts()).toBeUndefined()
  })

  it('restores the outer facts when nested scopes close', () => {
    const outer = { headers: { 'x-outer': '1' } }
    const inner = { headers: { 'x-inner': '1' } }
    runWithRequestFacts(outer, () => {
      expect(currentRequestFacts()).toBe(outer)
      runWithRequestFacts(inner, () => {
        expect(currentRequestFacts()).toBe(inner)
      })
      expect(currentRequestFacts()).toBe(outer)
    })
    expect(currentRequestFacts()).toBeUndefined()
  })

  it('keeps concurrent scopes independent', async () => {
    const left = { headers: { 'x-side': 'left' } }
    const right = { headers: { 'x-side': 'right' } }
    const [leftSeen, rightSeen] = await Promise.all([
      runWithRequestFacts(left, async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 5))
        return currentRequestFacts()
      }),
      runWithRequestFacts(right, async () => currentRequestFacts()),
    ])
    expect(leftSeen).toBe(left)
    expect(rightSeen).toBe(right)
  })
})
