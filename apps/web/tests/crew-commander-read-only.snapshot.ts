/** Crew commander replay: direct writes fail while delegation and bounded Git remain available. */
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    // Reuse by acceptance objective: a phase never starts a worker, budgets never justify reuse.
    expect(prompt).toContain('Reuse a worker by acceptance objective, not phase, directory, command count, or remaining budget.')
    expect(prompt).toContain('a phase never requires a fresh worker')
    expect(prompt).toContain('Run budgets are per turn and never justify reuse.')
    // Recovery reads evidence before it dispatches, and an unknown mutation blocks retry.
    expect(prompt).toContain('recover before dispatching: call `list_agents`')
    expect(prompt).toContain('A closing message is not completion evidence')
    expect(prompt).toContain('Unknown mutation effects block retry and dependent work until verified')
    expect(prompt).not.toContain('Start a fresh worker for a new acceptance objective or phase')
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

  it('creates a branch and fetches a named local remote through the mounted preset', async () => {
    const git = promisify(execFile)
    const root = await mkdtemp(join(tmpdir(), 'dsh-crew-branch-fetch-'))
    let gitHandle: AgentHandle | undefined
    try {
      const remote = join(root, 'remote.git')
      const source = join(root, 'source')
      await git('git', ['init', '--quiet', '--bare', remote])
      await git('git', ['init', '--quiet', source])
      await git('git', ['-C', source, 'config', 'user.name', 'Crew Test'])
      await git('git', ['-C', source, 'config', 'user.email', 'crew@example.invalid'])
      await writeFile(join(source, 'a.txt'), 'base\n')
      await git('git', ['-C', source, 'add', 'a.txt'])
      await git('git', ['-C', source, 'commit', '--quiet', '-m', 'base'])
      await git('git', ['-C', source, 'push', '--quiet', remote, 'HEAD:refs/heads/main'])
      await git('git', ['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
      const repo = join(root, 'clone')
      await git('git', ['clone', '--quiet', remote, repo])
      await git('git', ['-C', repo, 'config', 'user.name', 'Crew Test'])
      await git('git', ['-C', repo, 'config', 'user.email', 'crew@example.invalid'])
      // Hostile configuration plus the shared checkpoints the fetch must not touch.
      await git('git', ['-C', repo, 'branch', 'keep-local'])
      await git('git', ['-C', repo, 'tag', 'keep-tag'])
      await git('git', ['-C', repo, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/CFG/*'])
      await git('git', ['-C', repo, 'config', 'remote.origin.pruneTags', 'true'])
      await git('git', ['-C', repo, 'config', 'remote.origin.prune', 'true'])
      const marker = join(root, 'uploadpack-ran')
      const program = join(root, 'marker.cjs')
      await writeFile(program, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`)
      await chmod(program, 0o700)
      await git('git', ['-C', repo, 'config', 'remote.origin.uploadpack', program])
      await writeFile(join(repo, '.git', 'FETCH_HEAD'), 'sentinel-fetch-head\n')
      const localBranch = (await git('git', ['-C', repo, 'rev-parse', 'refs/heads/keep-local'])).stdout.trim()
      const localTag = (await git('git', ['-C', repo, 'rev-parse', 'refs/tags/keep-tag'])).stdout.trim()

      gitHandle = await scaffold.ctx.agents.create({
        sessionId: SessionId('crew-commander-branch-fetch'),
        meta: { cwd: scaffold.workspaceCwd, agentPreset: 'crew' },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'crew').then(() => undefined),
      })
      gitHandle.agent.session.append('sandbox/mode', { mode: 'danger-full-access' })
      gitHandle.agent.session.append('approval/policy', { policy: 'never' })
      const run = (callId: string, args: Record<string, unknown>) => executeModelToolFixture(gitHandle?.agent.ctx as never, {
        callId: ToolCallId(callId), name: 'crew_git', arguments: args,
        agent: gitHandle?.agent as never, signal: new AbortController().signal,
      })

      const created = await run('crew-branch-create', { operation: 'branch', cwd: repo, args: ['crew-test/backup', 'origin/main'] })
      expect(created.isError, JSON.stringify(created)).toBe(false)
      if (created.isError) throw new Error('expected mounted branch creation to reach Git')
      expect(created.value).toMatchObject({ operation: 'branch', exitCode: 0 })
      const query = await run('crew-branch-query', { operation: 'branch', cwd: repo, args: ['--list', 'crew-test/*'] })
      expect(query.isError).toBe(false)
      if (query.isError) throw new Error('expected mounted branch query to reach Git')
      const listed = query.value as { exitCode: number | null; stdout: { text: string } }
      expect(listed.exitCode).toBe(0)
      expect(listed.stdout.text).toContain('crew-test/backup')
      // The branch was created after the local branch set was recorded, so the fetch
      // baseline below includes it instead of contradicting its existence.
      const branchesBefore = (await git('git', ['-C', repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'])).stdout

      await writeFile(join(source, 'advance.txt'), 'advance\n')
      await git('git', ['-C', source, 'add', 'advance.txt'])
      await git('git', ['-C', source, 'commit', '--quiet', '-m', 'advance'])
      await git('git', ['-C', source, 'push', '--quiet', remote, 'HEAD:refs/heads/main'])
      const expected = (await git('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim()

      const fetched = await run('crew-fetch', { operation: 'fetch', cwd: repo, args: ['origin'] })
      expect(fetched.isError, JSON.stringify(fetched)).toBe(false)
      if (fetched.isError) throw new Error('expected mounted fetch to reach Git')
      expect(fetched.value).toMatchObject({ operation: 'fetch', exitCode: 0 })
      expect((await git('git', ['-C', repo, 'rev-parse', 'refs/remotes/origin/main'])).stdout.trim()).toBe(expected)
      expect((await git('git', ['-C', repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/CFG/'])).stdout).toBe('')
      expect((await git('git', ['-C', repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'])).stdout).toBe(branchesBefore)
      expect((await git('git', ['-C', repo, 'rev-parse', 'refs/heads/keep-local'])).stdout.trim()).toBe(localBranch)
      expect((await git('git', ['-C', repo, 'rev-parse', 'refs/tags/keep-tag'])).stdout.trim()).toBe(localTag)
      expect(await readFile(join(repo, '.git', 'FETCH_HEAD'), 'utf8')).toBe('sentinel-fetch-head\n')
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await gitHandle?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(DIR, [
      'session.v4.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json',
    ])
  })
})
