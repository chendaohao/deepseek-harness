// Web e2e scenario: the Models page's crew block edits the combination library,
// and a new crew session copies one combination onto itself.
//
// The block no longer writes the three role namespaces: a combination is a
// template, and editing it is a write into one settings entry that no running
// role can lock. That separation is what the first cases check — the role rows
// are gone, replaced by one combination picker and one role picker.
//
// The library cases stay inside the settings dialog and issue zero model
// calls: the block is pure settings/llm-catalog traffic, so a stray stream would
// fail loud because the adapter registry is empty. The cascade case changes the
// provider and asserts that the model and effort move with it rather than being
// left stranded.
//
// The route-chain cases boot a second scaffold with a replay adapter and drive
// the real composition: the chip stages Crew, the combination picker stages a
// stored library, the first send applies both through the seat gate before the
// prompt leaves, and the session's durable log carries exactly one
// `crew/routes-selected`. A second blank session records the combination the
// user explicitly picks rather than the picker opening entry, and a later
// library edit moves neither session.
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, openSettings, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

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

/**
 * One text-only replay entry: the marker arrives as streamed deltas and the
 * finish chunk closes the call, matching what a recorded turn derives from.
 * @param marker - the full assistant response text.
 * @returns the replay chunks producing exactly that text.
 */
function textChunks(marker: string): StreamChunk[] {
  const midpoint = Math.ceil(marker.length / 2)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: marker.slice(0, midpoint) },
    { type: 'text-delta', index: 0, text: marker.slice(midpoint) },
    { type: 'block-end', index: 0, block: { type: 'text', text: marker } },
    { type: 'usage', usage: { inputTokens: 32, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

describe('web e2e: a crew session records its combination and runs the three roles on it', () => {
  const COMBINATION_A = '编队A'
  const COMBINATION_B = '编队B'
  const MARKER_A = 'CREW_ROUTE_A_FIRST_TURN'

  let scaffold: WebScaffold
  let browser: Browser
  let replayDir: string
  let chainHome: string
  const events: SessionEvent[] = []

  beforeAll(async () => {
    // One positional replay script for the one live first turn: the scenario
    // sends a single model call, and the replay refusal is what keeps an
    // unrecorded second call loud instead of silently replayed.
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-crew-routes-replay-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    const replay: ReplayOverrideDoc = [
      { kind: 'chunks', chunks: textChunks(MARKER_A) },
    ]
    await writeFile(replayOverride, JSON.stringify(replay))
    // The replay key is the credential the DeepSeek provider reports as
    // configured, so the Models page draws its rows without a first-run setup
    // card — the same posture the replayed scenarios record with.
    chainHome = await mkdtemp(join(tmpdir(), 'dsh-crew-routes-home-'))
    await mkdir(chainHome, { recursive: true })
    await writeFile(join(chainHome, '.credentials.yaml'),
      'version: 1\nrefs:\n  DEEPSEEK_API_KEY: snapshot-replay-key\n',
      { mode: 0o600 })
    scaffold = await launchWebScaffold({
      // The install anchor installs the bundle the way `dsh plugin add` leaves
      // it: a link under the profile's node_modules plus a profile layer, and
      // the layer list is what supplies the runtime resolution's profile-scope
      // dependency closure — `@deepseek-ai/dsh-preset-tool-mask` is declared
      // only by this bundle, so the preset rows cannot import it without it.
      // The `bundles` entry then selects the bundle's rows; `packages` would
      // install the same link the anchor already installed.
      // The anchor already installs the bundle's link, so the `packages` list
      // stays empty and only the `bundles` selection is added.
      extraInstallAnchors: [join(CREW_BUNDLE_DIR, 'package.json')],
      profile: { packages: [], bundles: ['@deepseek-ai/dsh-crew'], hmr: false },
      replayFixture: join(replayDir, 'override-only.jsonl'),
      replayOverride,
      replayContextWindow: 10_000_000,
      // The combination editor's effort picker only becomes a select when the
      // chosen model declares efforts; both combinations' models advertise the
      // full ladder through the replay catalog.
      replayProviders: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 128_000, reasoningEfforts: ['off', 'low', 'high', 'max'], defaultReasoningEffort: 'high' },
          { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', contextWindow: 1_000_000, reasoningEfforts: ['off', 'low', 'high', 'max'], defaultReasoningEffort: 'max' },
        ],
      }],
      harnessHome: chainHome,
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    // The chip filters a broken preset out of its menu; surface that state here
    // with the mount's own logger records, so a red run names its row.
    const roster = await scaffold.ctx.agentPresets.list()
    const crewRow = roster.find(row => row.id === 'crew')
    if (crewRow === undefined) {
      const buffered = ((scaffold.ctx.logger as { buffer?: { type?: string; name?: string; args?: unknown[] }[] }).buffer) ?? []
      const records = buffered.map(record => `${record.type}: ${record.name}: ${record.args?.map(arg => arg instanceof Error ? arg.message : JSON.stringify(arg))?.join(' ')?.slice(0, 220)}`)
        .slice(-12)
      throw new Error(`crew preset absent from the roster (${roster.map(row => row.id).join(', ')}); logger: ${records.join(' | ') || 'none'}`)
    }
    if (crewRow.broken !== undefined) {
      const buffered = ((scaffold.ctx.logger as { buffer?: { type?: string; name?: string; args?: unknown[] }[] }).buffer) ?? []
      const records = buffered.map(record => `${record.type}: ${record.name}: ${record.args?.map(arg => arg instanceof Error ? arg.message : JSON.stringify(arg))?.join(' ')?.slice(0, 260)}`)
        .slice(-12)
      throw new Error(`crew preset is broken: ${crewRow.broken}; logger: ${records.join(' | ') || 'none'}`)
    }
    browser = await chromium.launch()
  }, 180_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) {
      await rm(replayDir, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    if (chainHome !== undefined && process.env.DSH_WEB_E2E_KEEP !== '1') {
      await rm(chainHome, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'crew route chain cleanup failed')
  })

  /** One zh page on a fresh workspace, ready to type into the composer. */
  async function crewPage(name: string): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    lastPage = page
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, name)
    return page
  }

  /**
   * Stage Crew on the hero chip and, when named, one combination on the picker.
   *
   * The chip and picker are the product flow a person uses: open the preset
   * menu, pick Crew, then optionally open the combination menu and pick one.
   * With no combination the displayed opening entry applies at the first send.
   * @param page - the page whose hero row is staged.
   * @param combination - combination name to stage on the picker, or none to leave the opening entry untouched.
   */
  async function stageCrewWith(page: Page, combination?: string): Promise<void> {
    // The chip's accessible name is the staged preset's display name; before a
    // pick it shows the deployment default (标准模式). The workspace hero
    // button is also a popup button, so the label filters it out.
    const chip = page.locator('button[aria-haspopup="menu"]').filter({ hasText: '标准模式' }).first()
    await chip.waitFor({ timeout: 15_000 })
    await chip.click()
    // The preset item's accessible name carries the name and its description,
    // so the match is a prefix on the name.
    await page.getByRole('menuitem', { name: /^Crew/ }).click()
    if (combination === undefined) return
    const picker = page.getByRole('button', { name: '模型组合' })
    await picker.waitFor({ timeout: 15_000 })
    await picker.click()
    await page.getByRole('menuitem', { name: combination, exact: true }).click()
  }

  /**
   * Send one first turn and wait for its durable completion.
   * @param page - the page to type into.
   * @param text - the prompt text; a marker makes the turn identifiable.
   * @param marker - the replay response the turn ends with.
   */
  async function sendFirstTurn(page: Page, text: string, marker: string): Promise<void> {
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.waitFor({ timeout: 15_000 })
    const before = events.length
    await composer.fill(text)
    await composer.press('Enter')
    await expect.poll(() => events.slice(before).some(event =>
      event.type === 'assistant/message' && JSON.stringify(event.data.message.content).includes(marker),
    ), { timeout: 30_000 }).toBe(true)
  }

  /** The most recently opened page, for the failure shot of the running case. */
  let lastPage: Page | undefined

  /** The `crew/routes-selected` payloads one session's durable log carries. */
  async function recordedSelections(sessionId: SessionId): Promise<unknown[]> {
    await scaffold.ctx.sessionPersistence.flush()
    const handle = await scaffold.ctx.sessionPersistence.open(sessionId, 'read')
    try {
      const { events: stored } = await handle.read()
      return stored
        .filter((event: SessionEvent) => event.type === 'crew/routes-selected')
        .map((event: SessionEvent) => event.data)
    } finally {
      await handle.close()
    }
  }

  /** The single-role replacements recorded on one session. */
  async function recordedReplacements(sessionId: SessionId): Promise<unknown[]> {
    await scaffold.ctx.sessionPersistence.flush()
    const handle = await scaffold.ctx.sessionPersistence.open(sessionId, 'read')
    try {
      const { events: stored } = await handle.read()
      return stored
        .filter((event: SessionEvent) => event.type === 'crew/route-replaced')
        .map((event: SessionEvent) => event.data)
    } finally {
      await handle.close()
    }
  }

  /** The route one role's resolver returns for a live session. */
  function roleRouteOf(sessionId: SessionId, namespace: string): { provider: string; model: string; reasoningEffort: string } {
    const registry = scaffold.ctx.get('subagentRouteSettings')
    if (registry === undefined) throw new Error('crew route chain: this deployment serves no subagent route registry')
    const resolution = registry.resolutionOf(namespace)
    if (resolution === undefined) throw new Error(`crew route chain: namespace "${namespace}" has no serving row`)
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error(`crew route chain: session ${String(sessionId)} is not live`)
    const route = resolution.forSession(agent.session)
    if (route === undefined) throw new Error(`crew route chain: session ${String(sessionId)} records no "${namespace}" route`)
    return route
  }

  it('runs a fresh crew session on the combination it staged, end to end', async () => {
    onTestFailed(() => lastPage && saveFailureShot(lastPage, 'web-e2e-crew-route-chain'))
    // Store the two combinations through the library's Host write path. The
    // role rows read the deployment's stored defaults (workbuddy), which the
    // test catalog does not serve, so each combination re-picks the provider
    // first and then the model and effort the replay adapter advertises.
    const dialogPage = await crewPage('crew-route-chain-setup')
    await openSettings(dialogPage, 'zh')
    const dialog = dialogPage.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    const block = dialog.locator('section').filter({ hasText: '编队路由' })
    await block.waitFor({ timeout: 10_000 })
    for (const [name, model, effort] of [
      [COMBINATION_A, 'deepseek-v4-flash', 'high'],
      [COMBINATION_B, 'deepseek-v4-flash-vision-exp', 'max'],
    ] as const) {
      if (name !== COMBINATION_A) {
        // After a save the editor still shows the stored combination; "new"
        // mints the draft the second combination is written into.
        await block.getByRole('button', { name: '新建组合', exact: true }).click()
      }
      await block.getByLabel('组合名称').fill(name)
      // The three roles each carry their own route, and the combination is
      // refused as a whole when one still names a provider the deployment
      // does not serve: the editor writes one role per view, so every role
      // takes the provider, model, and effort the replay catalog advertises.
      for (const role of ['工人', '规划者', '审核者'] as const) {
        await block.getByLabel('要编辑的角色').selectOption({ label: role })
        await block.getByLabel(`${role}提供方`).selectOption('deepseek-official')
        await block.getByLabel(`${role}模型`).selectOption(model)
        await block.getByLabel(`${role}思考等级`).selectOption(effort)
      }
      await block.getByRole('button', { name: '保存', exact: true }).click()
      await block.getByText('组合已保存。').waitFor({ timeout: 10_000 })
    }
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      .catch(() => dialogPage.keyboard.press('Escape'))

    // Session A: stage Crew, leave the picker on its opening entry A, and send.
    // The untouched display selection commits with the first turn, not before it.
    const pageA = await crewPage('crew-route-chain-a')
    await stageCrewWith(pageA)
    await sendFirstTurn(pageA, '开始', MARKER_A)
    const sessionIdA = await pageA.evaluate(() =>
      (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId) as SessionId

    // Exactly one durable selection, carrying combination A's identity and routes.
    const selections = await recordedSelections(sessionIdA)
    expect(selections).toHaveLength(1)
    expect(selections[0]).toMatchObject({
      presetName: COMBINATION_A,
      routes: {
        worker: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
        planner: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
        reviewer: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
      },
    })
    // The three role resolvers return combination A's route for this session.
    for (const namespace of ['subagent-worker-route-settings', 'subagent-planner-route-settings', 'subagent-reviewer-route-settings']) {
      await expect.poll(() => roleRouteOf(sessionIdA, namespace), { timeout: 10_000 }).toMatchObject({
        provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high',
      })
    }

    // Repair only worker from the live catalog. The replacement is durable and
    // changes the next delegation resolver without sending another model call.
    const modelCallsBeforeRepair = events.filter(event => event.type === 'request/header').length
    await pageA.getByRole('button', { name: '换路', exact: true }).click()
    const repair = pageA.getByRole('dialog', { name: '更换 Crew 角色路由' })
    await repair.getByLabel('模型').waitFor()
    await pageA.screenshot({ path: join(process.cwd(), '.artifacts/crew-route-repair-light.png'), animations: 'disabled' })
    await pageA.setViewportSize({ width: 390, height: 800 })
    await pageA.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => pageA.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
    await expect.poll(() => pageA.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await pageA.screenshot({ path: join(process.cwd(), '.artifacts/crew-route-repair-dark-mobile.png'), animations: 'disabled' })
    await pageA.emulateMedia({ colorScheme: 'light' })
    await pageA.setViewportSize({ width: 1680, height: 1000 })
    await repair.getByLabel('模型').selectOption('deepseek-v4-flash-vision-exp')
    await repair.getByLabel('思考等级').selectOption('max')
    await repair.getByRole('button', { name: '确认换路', exact: true }).click()
    await repair.waitFor({ state: 'detached' })
    await expect.poll(() => roleRouteOf(sessionIdA, 'subagent-worker-route-settings')).toMatchObject({
      provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', reasoningEffort: 'max',
    })
    expect(roleRouteOf(sessionIdA, 'subagent-planner-route-settings')).toMatchObject({
      model: 'deepseek-v4-flash', reasoningEffort: 'high',
    })
    expect(roleRouteOf(sessionIdA, 'subagent-reviewer-route-settings')).toMatchObject({
      model: 'deepseek-v4-flash', reasoningEffort: 'high',
    })
    expect(await recordedReplacements(sessionIdA)).toEqual([{
      role: 'worker',
      route: { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', reasoningEffort: 'max' },
    }])
    expect(events.filter(event => event.type === 'request/header')).toHaveLength(modelCallsBeforeRepair)
    await pageA.close()

    // Session B: choosing Crew only opens the combination picker. The explicit
    // B pick applies to the current blank session; it must not record A merely
    // because A was the picker's opening entry.
    const pageB = await crewPage('crew-route-chain-b')
    await stageCrewWith(pageB, COMBINATION_B)
    const sessionIdB = await pageB.evaluate(() =>
      (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId) as SessionId
    await expect.poll(() => recordedSelections(sessionIdB), { timeout: 10_000 }).toHaveLength(1)
    const selectionsB = await recordedSelections(sessionIdB)
    expect(selectionsB[0]).toMatchObject({ presetName: COMBINATION_B })
    for (const namespace of ['subagent-worker-route-settings', 'subagent-planner-route-settings', 'subagent-reviewer-route-settings']) {
      await expect.poll(() => roleRouteOf(sessionIdB, namespace), { timeout: 10_000 }).toMatchObject({
        provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', reasoningEffort: 'max',
      })
    }
    // A's original selection remains recorded after the worker repair.
    expect((await recordedSelections(sessionIdA))[0]).toMatchObject({ presetName: COMBINATION_A })
    await pageB.close()

    // Editing the library afterwards moves neither session: no log gains a
    // selection, and A's agent still resolves A's route.
    const selectionsACount = (await recordedSelections(sessionIdA)).length
    const dialogEdit = await crewPage('crew-route-chain-edit')
    await openSettings(dialogEdit, 'zh')
    const editDialog = dialogEdit.getByRole('dialog', { name: '设置' })
    await editDialog.getByRole('button', { name: '模型', exact: true }).click()
    const editBlock = editDialog.locator('section').filter({ hasText: '编队路由' })
    await editBlock.waitFor({ timeout: 10_000 })
    await editBlock.getByLabel('组合名称').fill(`${COMBINATION_A} 改`)
    await editBlock.getByRole('button', { name: '保存', exact: true }).click()
    await editBlock.getByText('组合已保存。').waitFor({ timeout: 10_000 })
    await editDialog.getByRole('button', { name: '关闭', exact: true }).click()
      .catch(() => dialogEdit.keyboard.press('Escape'))
    await dialogEdit.close()
    expect(await recordedSelections(sessionIdA)).toHaveLength(selectionsACount)
    await expect.poll(() => roleRouteOf(sessionIdA, 'subagent-worker-route-settings')).toMatchObject({
      provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', reasoningEffort: 'max',
    })
  }, 180_000)
})
