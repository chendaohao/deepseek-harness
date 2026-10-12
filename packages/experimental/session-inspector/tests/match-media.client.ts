/** jsdom ships no `window.matchMedia`, and the primitives subscribe to the query's `change` event. */

import { vi } from 'vitest'

/**
 * Install a complete `matchMedia` stand-in for one test.
 *
 * A bare `{ matches }` is not enough: the primitives call `addEventListener` on
 * the returned list, so a stub without it throws during the mount effect.
 * @param matches - Query result the installed list reports.
 */
export function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', () => ({
    matches,
    media: '',
    onchange: null,
    addEventListener: (): void => { /* the mounted effect only subscribes; no test here dispatches a change. */ },
    removeEventListener: (): void => {},
    addListener: (): void => {},
    removeListener: (): void => {},
    dispatchEvent: (): boolean => true,
  }))
}
