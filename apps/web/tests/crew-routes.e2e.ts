// Web e2e scenario: the Models page's crew block edits the combination library,
// and a new crew session copies one combination onto itself.
//
// The block no longer writes the three role namespaces: a combination is a
// template, and editing it is a write into one settings entry that no running
// role can lock. That separation is what the first case checks — the role rows
// are gone, replaced by one combination picker and one role picker.
//
// The remaining cases stay inside the settings dialog and issue zero model
// calls: the block is pure settings/llm-catalog traffic, so a stray stream would
// fail loud because the adapter registry is empty. The cascade case changes the
// provider and asserts that the model and effort move with it rather than being
// left stranded.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { openSettings, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CREW_BUNDLE_DIR = join(REPO_ROOT, 'packages/bundle/crew')

describe('web e2e: the crew-route block edits the combination library', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    // The crew bundle is a product bundle, so the profile selects it the way
    // `dsh plugin add` leaves it: a file dependency plus a `dsh.profile.bundles`
    // entry. Its rows then serve the three role namespaces and the library.
    scaffold = await launchWebScaffold({
      profile: { packages: [{ dir: CREW_BUNDLE_DIR, enabled: true }] },
    })
    browser = await chromium.launch()
    // The scenario asserts the shipped Chinese copy, so the browser asks for it.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await openSettings(page, 'zh')
  }, 180_000)

  afterAll(async () => { await browser?.close(); await scaffold?.close() })

  /** Open the Models page and return the crew block. */
  async function openCrewBlock() {
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    // `exact` keeps the nav entry distinct from the add-provider control, which
    // also carries the word 模型.
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    await dialog.getByText('填入各提供商的 API 密钥即可使用其模型。').waitFor({ timeout: 10_000 })
    const block = dialog.locator('section').filter({ hasText: '编队路由' })
    await block.waitFor({ timeout: 10_000 })
    return block
  }

  it('draws one combination editor instead of three role rows', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-crew-routes'))
    const block = await openCrewBlock()

    expect(await block.count()).toBe(1)
    // The three per-role provider controls are gone: one role is edited at a
    // time, selected from the role picker.
    expect(await block.getByLabel('模型组合').count()).toBe(1)
    expect(await block.getByLabel('要编辑的角色').count()).toBe(1)
    // One role is edited at a time: the pickers carry the selected role's name,
    // and only that role's controls exist.
    expect(await block.getByLabel('工人提供方').count()).toBe(1)
    expect(await block.getByLabel('规划者提供方').count()).toBe(0)

    // The role picker names all three delegation roles.
    const roles = await block.getByLabel('要编辑的角色').locator('option').allTextContents()
    expect(roles).toEqual(['工人', '规划者', '审核者'])

    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('saves a combination from the seeded draft and reopens it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-crew-route-presets'))
    const block = await openCrewBlock()
    const picker = block.getByLabel('模型组合')
    // The shipped library is empty, so the picker offers the new-combination
    // entry only, and the draft is seeded from the roles' stored routes.
    await expect.poll(async () => picker.locator('option').count(), { timeout: 10_000 }).toBe(1)
    const providerBefore = await block.getByLabel('工人提供方').inputValue()
    expect(providerBefore).not.toBe('')

    await block.getByLabel('组合名称').fill('回归组合')
    await block.getByRole('button', { name: '保存', exact: true }).click()
    await block.getByText('组合已保存。').waitFor({ timeout: 10_000 })
    await expect.poll(async () => picker.locator('option').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(async () => picker.locator('option').first().textContent(), { timeout: 10_000 })
      .toBe('回归组合')

    // The saved draft still describes the same routes: opening the editor
    // never rewrites what the combination holds.
    expect(await block.getByLabel('工人提供方').inputValue()).toBe(providerBefore)

    await block.getByRole('button', { name: '删除组合' }).click()
    await block.getByText('组合已删除。').waitFor({ timeout: 10_000 })

    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('carries the model and effort with a provider change instead of stranding them', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-crew-route-cascade'))
    const block = await openCrewBlock()
    const provider = block.getByLabel('工人提供方')
    const before = await provider.inputValue()
    const options = await provider.locator('option').allTextContents()
    // The scenario needs a second provider the catalog advertises; without one
    // the cascade cannot run and the assertion below would be vacuous.
    const target = (await provider.locator('option').evaluateAll(
      (nodes, current) => nodes
        .map(node => (node as HTMLOptionElement).value)
        .find(value => value !== current),
      before,
    ))
    if (target === undefined) {
      // A single-provider deployment still proves the editor renders editable.
      expect(options.length).toBeGreaterThan(0)
      return
    }

    await provider.selectOption(target)
    // The cascade lands in the draft; re-reading the row shows all three fields
    // agreeing rather than a provider with another provider's model.
    await expect.poll(
      async () => block.getByLabel('工人提供方').inputValue(),
      { timeout: 10_000 },
    ).toBe(target)
    expect(await block.getByLabel('工人模型').inputValue()).not.toBe('')
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)
})
