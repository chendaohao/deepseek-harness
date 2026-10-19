// @vitest-environment jsdom
/**
 * Phone layer installation: the device gate, the layer attribute, the touch
 * stylesheet, the swipe wiring, and that disposal removes all three.
 */
import { Context } from '@deepseek-ai/cordis'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-mobile/client'
import { FORCE_DESKTOP_KEY } from '../src/client/device.ts'
import { apply as hostApply } from '../src/index.ts'

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-mobile'
const LAYER_ATTRIBUTE = 'data-dsh-mobile-layer'

/**
 * Every shipped client stylesheet, for resolving the suffix selectors back to
 * the local classes they name. `ui-theme` keeps an equivalent walker for its own
 * contract specs; this package owns its copy rather than importing another
 * package's test file.
 * @returns absolute paths of CSS under packages/client, build output excluded.
 */
function clientStylesheets(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'lib' && entry.name !== 'dist') walk(path)
      } else if (entry.name.endsWith('.css')) found.push(path)
    }
  }
  walk(resolve(import.meta.dirname, '../..'))
  return found
}

/** Install a phone-class media-query table for one test. */
function installPhoneQueries(): void {
  vi.stubGlobal('matchMedia', (media: string) => ({ matches: media === '(pointer: coarse)' }))
}

beforeEach(() => {
  installPhoneQueries()
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute(LAYER_ATTRIBUTE)
  document.head.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`).forEach((node) => { node.remove() })
  globalThis.sessionStorage.clear()
})

/** Boot the plugin against a context exposing the layout service it injects. */
async function bench() {
  const ctx = new Context()
  const toggleSidebar = vi.fn()
  ctx.provide('layout', { toggleSidebar } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, toggleSidebar }
}

describe('ui-mobile apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['layout'])
  })

  it('keeps the host Loader entry inert', () => {
    expect(() => { hostApply() }).not.toThrow()
  })

  it('marks the document, mounts the touch sheet, and removes both on dispose', async () => {
    const { fiber } = await bench()
    expect(document.documentElement.hasAttribute(LAYER_ATTRIBUTE)).toBe(true)
    const sheets = [...document.head.querySelectorAll<HTMLStyleElement>(`style[data-plugin="${PLUGIN_ID}"]`)]
    expect(sheets.map(style => style.dataset.pluginCss)).toEqual([`${PLUGIN_ID}/touch.css`])
    // The spec lane resolves `?inline` to empty text (tsdown, not vitest, owns
    // that transform), so the sheet's content is asserted from disk instead.
    const sheet = readFileSync(resolve(import.meta.dirname, '../src/client/touch.css'), 'utf8')
    expect(sheet).toContain(`[${LAYER_ATTRIBUTE}]`)
    await fiber.dispose()
    expect(document.documentElement.hasAttribute(LAYER_ATTRIBUTE)).toBe(false)
    expect(document.head.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`)).toHaveLength(0)
  })

  it('scopes every rule to the layer attribute', () => {
    const sheet = readFileSync(resolve(import.meta.dirname, '../src/client/touch.css'), 'utf8')
    const withoutComments = sheet.replace(/\/\*[\s\S]*?\*\//g, ' ')
    for (const [, selector = ''] of withoutComments.matchAll(/([^{}]+)\{/g)) {
      // The attribute scope is what keeps this document-wide sheet inert on a
      // desktop page; an unscoped rule would leak the layer everywhere.
      expect(selector.trim(), `unscoped selector: ${selector.trim()}`).toContain(`[${LAYER_ATTRIBUTE}]`)
    }
  })

  it('names only component selectors that exist in the shipped stylesheets', () => {
    // The suffix selectors are a convention, not a type-checked contract, so
    // every `[class$="_x"]` the sheet uses is resolved back to a real CSS
    // Modules local class. Renaming one must fail here rather than silently
    // dropping a rule. The leading underscore belongs to the compiled
    // `[hash]_[local]` form, not to source.
    const sheet = readFileSync(resolve(import.meta.dirname, '../src/client/touch.css'), 'utf8')
    const suffixes = [...sheet.matchAll(/\[class\$="_([A-Za-z0-9]+)"\]/g)].map(([, name = '']) => name)
    expect(suffixes.length).toBeGreaterThan(0)
    const sources = clientStylesheets().map(path => ({ path, css: readFileSync(path, 'utf8') }))
    for (const suffix of new Set(suffixes)) {
      const owner = sources.find(({ css }) => new RegExp(`\\.${suffix}\\s*[,{]`).test(css))
      expect(owner?.path, `no shipped stylesheet declares .${suffix}`).toBeDefined()
    }
  })

  it('wires the swipe to the layout service, and unhooks it on dispose', async () => {
    const { fiber, toggleSidebar } = await bench()
    const send = (type: string, x: number): void => {
      document.dispatchEvent(new PointerEvent(type, {
        bubbles: true, clientX: x, clientY: 400, pointerId: 1, isPrimary: true, pointerType: 'touch',
      }))
    }
    send('pointerdown', 10)
    send('pointermove', 20)
    send('pointermove', 70)
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    await fiber.dispose()
    send('pointermove', 200)
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('installs nothing on a desktop pointer', async () => {
    vi.stubGlobal('matchMedia', (media: string) => ({ matches: media === '(hover: hover)' }))
    const { fiber } = await bench()
    expect(document.documentElement.hasAttribute(LAYER_ATTRIBUTE)).toBe(false)
    expect(document.head.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`)).toHaveLength(0)
    await fiber.dispose()
  })

  it('installs nothing when this tab asked for the desktop layout', async () => {
    globalThis.sessionStorage.setItem(FORCE_DESKTOP_KEY, '1')
    const { fiber } = await bench()
    expect(document.documentElement.hasAttribute(LAYER_ATTRIBUTE)).toBe(false)
    await fiber.dispose()
  })

  it('keeps the layer on when session storage is denied by policy', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const { fiber } = await bench()
    expect(document.documentElement.hasAttribute(LAYER_ATTRIBUTE)).toBe(true)
    await fiber.dispose()
    getItem.mockRestore()
  })
})
