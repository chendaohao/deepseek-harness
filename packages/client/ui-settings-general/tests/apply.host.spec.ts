import { expect, it } from 'vitest'
import { apply } from '../src/index.ts'

it('keeps the Settings General Host Loader entry inert', () => {
  expect(apply).not.toThrow()
})
