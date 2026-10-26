// @vitest-environment jsdom
/** The branch chip inside the floating control row of the Chat view. */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { BranchChip } from '../src/client/chat/BranchChip.tsx'
import { zh } from '../src/client/locale.ts'
import type { ChatViewSlotProps } from '../src/client/contract/slots.ts'

const t: ChatViewSlotProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

describe('BranchChip', () => {
  it('names the branch with the branch glyph and no interactive control', () => {
    render(<BranchChip branch="master" t={t} />)
    expect(screen.getByText('master')).toBeTruthy()
    // Informational only: nothing in the chip can switch a branch.
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('dsw-icon-branch-outline-regular')
  })

  it('renders nothing without a branch', () => {
    const view = render(<BranchChip branch={undefined} t={t} />)
    expect(view.container.childElementCount).toBe(0)
  })

  it('keeps a long branch name in one clipped line', () => {
    const long = 'feature/very-long-branch-name-that-must-not-widen-the-row'
    render(<BranchChip branch={long} t={t} />)
    const name = screen.getByText(long)
    expect(name).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
