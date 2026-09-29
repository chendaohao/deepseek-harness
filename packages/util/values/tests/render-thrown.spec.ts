import { describe, expect, it } from 'vitest'
import { renderThrown } from '../src/index.ts'

describe('renderThrown', () => {
  it('renders the full cause chain of a wrapped transport failure', () => {
    const chain = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:443') })

    expect(renderThrown(chain)).toBe('fetch failed: connect ECONNREFUSED 127.0.0.1:443')
  })

  it('renders AggregateError members instead of hiding them behind the wrapper', () => {
    const aggregate = new AggregateError(
      [new Error('connect ECONNREFUSED ::1:443'), new Error('connect ECONNREFUSED 127.0.0.1:443')],
      '',
    )

    expect(renderThrown(new TypeError('fetch failed', { cause: aggregate }))).toBe(
      'fetch failed: AggregateError [connect ECONNREFUSED ::1:443; connect ECONNREFUSED 127.0.0.1:443]',
    )
  })

  it('renders non-Error values, including their own message property', () => {
    expect(renderThrown('plain string')).toBe('plain string')
    expect(renderThrown({ message: 'structured provider failure', code: 'SERVER' }))
      .toBe('structured provider failure')
    expect(renderThrown(42)).toBe('42')
  })

  it('falls back to the error name and stops at an empty or null cause', () => {
    expect(renderThrown(new TypeError('', { cause: null }))).toBe('TypeError')
    expect(renderThrown(new AggregateError([], 'all failed'))).toBe('all failed')
  })

  it('collapses a cause that repeats its wrapper message verbatim', () => {
    const wrapped = new Error('boom', { cause: 'boom' })

    expect(renderThrown(wrapped)).toBe('boom')
  })

  it('flags a true cycle while still rendering a diamond-shared cause twice', () => {
    const circular = new Error('outer')
    circular.cause = circular
    const shared = new Error('shared')
    const diamond = new AggregateError([new Error('a', { cause: shared }), new Error('b', { cause: shared })], 'agg')

    expect(renderThrown(circular)).toBe('outer: <circular cause>')
    expect(renderThrown(diamond)).toBe('agg [a: shared; b: shared]')
  })

  it('collapses only the node whose own coercion or property access throws', () => {
    expect(renderThrown({ toString: () => { throw new Error('hostile') } })).toBe('<unrenderable value>')
    const hostileNode = new Error('node')
    Object.defineProperty(hostileNode, 'message', { get() { throw new Error('hostile getter') } })

    expect(renderThrown(new Error('outer', { cause: hostileNode }))).toBe('outer: <unrenderable value>')
  })
})
