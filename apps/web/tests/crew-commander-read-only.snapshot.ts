/** Crew commander replay: direct writes fail while delegation and bounded Git remain available. */
import { execFile } from 'node:child_process'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, fixtureUserPrompts, launchWebScaffold, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/crew-commander-read-only', import.meta.url))
const CREW_BUNDLE_DIR = fileURLToPath(new URL('../../../packages/bundle/crew', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const MODE = webSnapshotMode()

/**
 * Every tool name the commander's composed request may carry. This allowlist is
 * written here rather than read from the tool-schema sidecar: refresh rewrites
 * that sidecar from the current composition, so it cannot refuse a newly added
 * writer or executor.
 */
const COMMANDER_TOOLS = [
  'ask_user_question', 'create_goal', 'crew_git', 'get_goal', 'glob', 'grep', 'interrupt_agent',
  'list_agents', 'planner', 'present', 'read', 'read_image', 'reviewer', 'send_message', 'skill',
  'todo_write', 'update_goal', 'wait_agent', 'web_fetch', 'web_search', 'worker',
]

/** The rendered system-prompt text of every `system/message` event, in log order. */
function systemPromptsOf(session: Session): string[] {
  return session.snapshotEvents().flatMap((event) => {
    if (event.type !== 'system/message') return []
    const content = event.data.message.content
    const text = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    return text === '' ? [] : [text]
  })
}

describe('Crew commander read-only composition', () => {
  let scaffold: WebScaffold
  let handle: AgentHandle
  let previousWriteApproval: string | undefined

  beforeAll(async () => {
    previousWriteApproval = process.env.DSH_CREW_GIT_REQUIRE_WRITE_APPROVAL
    process.env.DSH_CREW_GIT_REQUIRE_WRITE_APPROVAL = 'false'
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
    try {
      await handle?.dispose()
      await scaffold?.close()
    } finally {
      if (previousWriteApproval === undefined) Reflect.deleteProperty(process.env, 'DSH_CREW_GIT_REQUIRE_WRITE_APPROVAL')
      else process.env.DSH_CREW_GIT_REQUIRE_WRITE_APPROVAL = previousWriteApproval
    }
  })

  it('replays a direct write as an executor denial with no file effect', async () => {
    const session = handle.agent.session
    const tools = session.requestHeader()?.tools ?? []
    expect(tools.map(tool => tool.name).toSorted()).toEqual(COMMANDER_TOOLS.toSorted())
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['worker', 'planner', 'reviewer', 'crew_git', 'read']))
    expect(tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining(['bash', 'pwsh', 'write', 'edit', 'apply_patch']))
    expect(tools.find(tool => tool.name === 'worker')?.description).toContain('Use worker for every implementation action')
    expect(tools.find(tool => tool.name === 'planner')?.description).toContain('decision-complete written plan')
    expect(tools.find(tool => tool.name === 'planner')?.description).not.toContain('contested design')
    expect(tools.find(tool => tool.name === 'reviewer')?.description).toContain('PASS or FAIL verdict')
    const result = session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(result?.data.message.isError).toBe(true)
    expect(result?.data.message.content).toEqual([{ type: 'text', text: 'Error: unknown tool "write"' }])
    await expect(readFile(join(scaffold.workspaceCwd, 'direct-write.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(MODE === 'refresh')('composes the collaboration rules into the real system prompt', () => {
    const prompt = systemPromptsOf(handle.agent.session).join('\n\n')
    // Hybrid planner trigger, and its purpose-only tool description left alone.
    expect(prompt).toContain('Planner triggering is hybrid.')
    expect(prompt).toContain('use planner only when an unresolved design choice has a high cost to reverse')
    // Fact pack before any planner call.
    expect(prompt).toContain('Before any planner call, give it a fact pack:')
    // Reuse by acceptance objective, with budgets excluded as a reuse criterion.
    expect(prompt).toContain('Reuse a worker by acceptance objective, not by directory or remaining budget.')
    expect(prompt).toContain('Run budgets are per turn and never justify reuse.')
    // Automatic compaction and the terminal-failure boundary.
    expect(prompt).toContain('Let automatic compaction continue an unfinished objective')
    expect(prompt).toContain('Do not automatically resume a budget-stopped or terminal quota/auth-failed worker.')
    // Local checkpoints remain distinct from final delivery when a reviewer is unavailable.
    expect(prompt).toContain('A user-requested local checkpoint commit may proceed after its scope and validation are verified; it is not final delivery.')
    expect(prompt).toContain('No delivery PASS: do not push, publish, or call the work complete.')
    expect(prompt).toContain('every completion report must state that independent review did not run')
  })

  it('executes a configured Git write through the mounted preset with approval disabled', async () => {
    const git = promisify(execFile)
    const repo = await mkdtemp(join(tmpdir(), 'dsh-crew-unattended-'))
    let gitHandle: AgentHandle | undefined
    try {
      await git('git', ['init', '--quiet', repo])
      await git('git', ['-C', repo, 'config', 'user.name', 'Crew Test'])
      await git('git', ['-C', repo, 'config', 'user.email', 'crew@example.invalid'])
      await writeFile(join(repo, 'checkpoint.txt'), 'checkpoint\n')
      await git('git', ['-C', repo, 'add', 'checkpoint.txt'])
      gitHandle = await scaffold.ctx.agents.create({
        sessionId: SessionId('crew-commander-unattended-git'),
        meta: { cwd: scaffold.workspaceCwd, agentPreset: 'crew' },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'crew').then(() => undefined),
      })
      gitHandle.agent.session.append('sandbox/mode', { mode: 'danger-full-access' })
      gitHandle.agent.session.append('approval/policy', { policy: 'never' })
      const result = await executeModelToolFixture(gitHandle.agent.ctx, {
        callId: ToolCallId('crew-unattended-commit'), name: 'crew_git',
        arguments: { operation: 'commit', cwd: repo, args: ['--message=checkpoint'] },
        agent: gitHandle.agent, signal: new AbortController().signal,
      })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected mounted Crew Git execution to reach Git')
      expect(result.value, JSON.stringify(result.value)).toMatchObject({ operation: 'commit', exitCode: 0 })
      const { stdout } = await git('git', ['-C', repo, 'log', '-1', '--format=%s'])
      expect(stdout.trim()).toBe('checkpoint')
    } finally {
      await gitHandle?.dispose()
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(DIR, [
      'session.v4.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json',
    ])
  })
})
