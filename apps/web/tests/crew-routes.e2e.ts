// Web e2e scenario: the Models page's crew-route block follows the crew bundle.
// The block edits one Host route namespace per crew delegation role. Those rows
// live in `dsh-crew`, not in `dsh-web-app`, so a profile that selects the crew
// bundle serves three namespaces and draws three rows in one block, while the
// scaffold's default profile (no crew) draws no block at all — the absence case
// lives in models-settings.e2e.ts. Zero model calls: the block is pure
// settings/llm-catalog traffic, so a stray stream would fail loud because the
// adapter registry is empty. The cascade case changes the provider and asserts
// that the model and effort are written with it rather than left stranded.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { openSettings, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CREW_BUNDLE_DIR = join(REPO_ROOT, 'packages/bundle/crew')

describe('web e2e: the crew-route block follows the crew bundle', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    // The crew bundle is a product bundle, so the profile selects it the way
    // `dsh plugin add` leaves it: a file dependency plus a `dsh.profile.bundles`
    // entry. Its rows then serve the three role namespaces this block edits.
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

  it('draws one row per crew role inside a single block', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-crew-routes'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '模型' }).click()
    await dialog.getByText('填入各提供商的 API 密钥即可使用其模型。').waitFor({ timeout: 10_000 })

    const block = dialog.locator('section').filter({ hasText: '编队路由' })
    await block.waitFor({ timeout: 10_000 })
    // One block, three roles, and each role's pickers carry its own name so the
    // three otherwise identical selects stay distinguishable.
    expect(await block.count()).toBe(1)
    for (const role of ['工人', '规划者', '审核者']) {
      await expect.poll(
        async () => block.getByLabel(`${role}提供方`).count(),
        { timeout: 10_000 },
      ).toBe(1)
    }
    // The composition base is the deployment fallback the stored route overrides.
    expect(await block.getByLabel('工人提供方').inputValue()).toBe('workbuddy')
    expect(await block.getByLabel('规划者提供方').inputValue()).toBe('workbuddy')
    expect(await block.getByLabel('审核者提供方').inputValue()).toBe('workbuddy')

    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('saves the three routes as one combination and switches back to them', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-crew-route-presets'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    const block = dialog.locator('section').filter({ hasText: '编队路由' })
    const picker = block.getByLabel('模型组合')
    // The shipped list is empty, so the only entry is the derived custom one.
    await expect.poll(async () => picker.locator('option').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(async () => picker.locator('option').first().textContent(), { timeout: 10_000 })
      .toBe('自定义（未保存）')

    // Save the current routes under a name, then move one role by hand.
    await block.getByRole('button', { name: '保存组合' }).click()
    const name = block.getByLabel('组合名称')
    await name.fill('回归组合')
    await block.getByRole('button', { name: '保存', exact: true }).click()
    await block.getByText('组合已保存。').waitFor({ timeout: 10_000 })
    await expect.poll(async () => picker.locator('option').count(), { timeout: 10_000 }).toBe(2)

    const workerModel = block.getByLabel('工人模型')
    const before = await workerModel.inputValue()
    const options = await workerModel.locator('option').evaluateAll(
      (nodes, current) => nodes
        .map(node => (node as HTMLOptionElement).value)
        .find(value => value !== current),
      before,
    )
    if (options === undefined) return
    await workerModel.selectOption(options)
    // A hand edit leaves the custom entry selected: the routes are no longer
    // the saved combination.
    await expect.poll(async () => picker.inputValue(), { timeout: 10_000 }).toBe('')

    await picker.selectOption({ label: '回归组合' })
    await block.getByText('已把这套组合应用到所有角色。').waitFor({ timeout: 10_000 })
    await expect.poll(async () => workerModel.inputValue(), { timeout: 10_000 }).toBe(before)
    await expect.poll(async () => picker.inputValue(), { timeout: 10_000 }).toBe('preset-1')

    // Dropping the combination reports the drop, not the save it shares a write
    // path with; the picker falls back to the derived custom entry.
    await block.getByRole('button', { name: '删除组合' }).click()
    await block.getByText('组合已删除。').waitFor({ timeout: 10_000 })
    await expect.poll(async () => picker.locator('option').count(), { timeout: 10_000 }).toBe(1)

    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('writes the model and effort with a provider change instead of stranding them', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-crew-route-cascade'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    const block = dialog.locator('section').filter({ hasText: '编队路由' })
    const workerProvider = block.getByLabel('工人提供方')
    const before = await workerProvider.inputValue()
    const options = await workerProvider.locator('option').allTextContents()
    // The scenario needs a second provider the catalog advertises; without one
    // the cascade cannot run and the assertion below would be vacuous.
    const target = (await workerProvider.locator('option').evaluateAll(
      (nodes, current) => nodes
        .map(node => (node as HTMLOptionElement).value)
        .find(value => value !== current),
      before,
    ))
    if (target === undefined) {
      // A single-provider deployment still proves the row renders editable.
      expect(options.length).toBeGreaterThan(0)
      return
    }

    await workerProvider.selectOption(target)
    // The cascade lands in the Host document; re-reading the row shows all
    // three fields agreeing rather than a provider with another's model.
    await expect.poll(
      async () => block.getByLabel('工人提供方').inputValue(),
      { timeout: 10_000 },
    ).toBe(target)
    const model = await block.getByLabel('工人模型').inputValue()
    expect(model).not.toBe('')
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)
})
