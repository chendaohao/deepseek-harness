/** Crew commander replay: direct writes fail while delegation and bounded Git remain available. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { assertFixtureInventory, fixtureUserPrompts, launchWebScaffold, type WebScaffold } from './scaffold.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/crew-commander-read-only', import.meta.url))
const CREW_BUNDLE_DIR = fileURLToPath(new URL('../../../packages/bundle/crew', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')

describe('Crew commander read-only composition', () => {
  let scaffold: WebScaffold
  let handle: AgentHandle

  beforeAll(async () => {
    const prompt = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))[0]
    if (prompt === undefined) throw new Error('Crew replay fixture has no user prompt')
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      compareReplaySession: true,
      extraOverlayPath: join(CREW_BUNDLE_DIR, 'cordis.patch.yml'),
      extraInstallAnchors: [join(CREW_BUNDLE_DIR, 'package.json')],
    })
    handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('crew-commander-read-only'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'crew' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'crew').then(() => undefined),
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
  })

  afterAll(async () => {
    await handle?.dispose()
    await scaffold?.close()
  })

  it('replays a direct write as an executor denial with no file effect', async () => {
    const session = handle.agent.session
    const tools = session.requestHeader()?.tools ?? []
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['worker', 'planner', 'reviewer', 'crew_git', 'read']))
    expect(tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining(['bash', 'pwsh', 'write', 'edit', 'apply_patch']))
    expect(tools.find(tool => tool.name === 'worker')?.description).toContain('Use worker for every implementation action')
    expect(tools.find(tool => tool.name === 'planner')?.description).toContain('decision-complete written plan')
    expect(tools.find(tool => tool.name === 'reviewer')?.description).toContain('PASS or FAIL verdict')
    const result = session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(result?.data.message.isError).toBe(true)
    expect(result?.data.message.content).toEqual([{ type: 'text', text: 'Error: unknown tool "write"' }])
    await expect(readFile(join(scaffold.workspaceCwd, 'direct-write.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(DIR, [
      'session.v4.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json',
    ])
  })
})
