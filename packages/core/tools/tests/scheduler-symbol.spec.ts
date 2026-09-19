/** The scheduler key stays process-stable so separately loaded copies of the package share one scheduler. */
import { describe, expect, it } from 'vitest'
import { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'

/** Read a symbol-keyed scheduler the way `dsh-agent-loop` reads it off an arbitrary registry. */
const readScheduler = (registry: object): unknown => (registry as Record<symbol, unknown>)[TOOL_RUNTIME_SCHEDULER]

describe('TOOL_RUNTIME_SCHEDULER', () => {
  it('keys the scheduler through the global symbol registry', () => {
    expect(TOOL_RUNTIME_SCHEDULER).toBe(Symbol.for('dsh.tools.scheduler'))
  })

  it('resolves a scheduler published by a separately loaded copy of the package', () => {
    const siblingCopy = { [Symbol.for('dsh.tools.scheduler')]: { prepare: () => undefined } }
    expect(readScheduler(siblingCopy)).toBeDefined()
  })
})
