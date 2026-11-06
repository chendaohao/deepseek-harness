import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { SubprocessHandle, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as CrewGit from '../src/git.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

function read(text: string, lossy = false): SubprocessOutputRead {
  return { text, nextOffset: Buffer.byteLength(text), lossy }
}

function handle(
  outcome: { exitCode: number | null; signal: NodeJS.Signals | null } = { exitCode: 0, signal: null },
  stdout = 'git stdout\n',
  stderr = 'git stderr\n',
): SubprocessHandle {
  return {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: {
      stdout: { readFrom: () => read(stdout) },
      stderr: { readFrom: () => read(stderr) },
    },
    done: Promise.resolve(outcome),
    terminate: () => {},
    waitForExit: () => Promise.resolve(true),
  }
}

/** The config listing a read enumerates before it starts; answers only that probe. */
function configListing(keys: readonly string[]): (spec: SubprocessSpawnSpec) => SubprocessHandle | undefined {
  return spec => spec.argv.includes('config')
    ? handle({ exitCode: 0, signal: null }, keys.map(key => `${key}\0`).join(''))
    : undefined
}

/** Spawn calls that actually ran the requested operation, skipping the config probe. */
function operationCalls(spawn: ReturnType<typeof vi.fn>) {
  return spawn.mock.calls.map(entry => entry[0] as SubprocessSpawnSpec).filter(spec => !spec.argv.includes('config'))
}

async function setup(options: {
  approve?: boolean
  mode?: 'danger-full-access' | 'read-only'
  onSpawn?: (spec: SubprocessSpawnSpec) => SubprocessHandle | undefined
  /** Repository configuration keys the read-time probe reports. */
  configKeys?: readonly string[]
} = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const spawn = vi.fn((spec: SubprocessSpawnSpec) => configListing(options.configKeys ?? [])(spec)
    ?? options.onSpawn?.(spec) ?? handle())
  const confine = vi.fn((argv: readonly string[]) => Promise.resolve({ argv: ['sandboxed-git', ...argv.slice(1)] }))
  ctx.provide('subprocess', { spawn, resolveExecutable: () => Promise.resolve('git') } as never)
  ctx.provide('workingDirectory', { ensure: () => Promise.resolve('/workspace') } as never)
  ctx.provide('sandbox', { confine } as never)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: options.mode ?? 'danger-full-access', workspaceRoot: '/workspace' }) } as never)
  const request = vi.fn(() => Promise.resolve(options.approve === true ? 'allowed-once' : 'rejected'))
  ctx.provide('approval', { request } as never)
  const fiber = await ctx.plugin(CrewGit, {})
  return { ctx, fiber, spawn, request, confine }
}

let callCounter = 0

function call(ctx: Context, args: unknown, agent: object = { session: {} }) {
  return executeModelToolFixture(ctx, {
    callId: ToolCallId(`git-${++callCounter}`), name: 'crew_git', arguments: args,
    agent: agent as never, signal: new AbortController().signal,
  })
}

describe('Crew commander Git tool', () => {
  it('runs a read operation through direct argv with bounded collected output', async () => {
    const waitForExit = vi.fn(() => Promise.resolve(true))
    const { ctx, spawn, request } = await setup({ onSpawn: () => ({ ...handle(), waitForExit }) })
    const result = await call(ctx, { operation: 'diff', args: ['--cached', '--', 'src/index.ts'] })
    expect(result.isError).toBe(false)
    const spec = operationCalls(spawn)[0]
    expect(spec).toMatchObject({
      argv: [
        'git', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
        '-c', 'protocol.ext.allow=never', 'diff', '--no-ext-diff', '--no-textconv', '--cached', '--', 'src/index.ts',
      ],
      cwd: '/workspace',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
    })
    expect(spec?.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' })
    expect(waitForExit).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()
    if (result.isError) throw new Error('expected Git success')
    expect(result.value).toMatchObject({ operation: 'diff', exitCode: 0, stdout: { text: 'git stdout\n' } })
  })

  it('rejects command-execution options before spawning', async () => {
    const { ctx, spawn, request } = await setup({ approve: true })
    const result = await call(ctx, { operation: 'rebase', args: ['--exec=touch /tmp/not-allowed'] })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_ARGUMENTS' } } })
    expect(spawn).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
  })

  it('requires approval for repository writes', async () => {
    const { ctx, spawn, request } = await setup({ approve: false })
    const result = await call(ctx, { operation: 'commit', args: ['--message=reviewed change'] })
    expect(result.isError).toBe(true)
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'crew_git' }))
    expect(spawn).not.toHaveBeenCalled()
  })

  it('runs an approved write with literal arguments', async () => {
    const { ctx, spawn, request } = await setup({ approve: true })
    const result = await call(ctx, { operation: 'commit', args: ['--message=reviewed change'] })
    expect(result.isError).toBe(false)
    expect(request).toHaveBeenCalledOnce()
    expect(operationCalls(spawn)[0]?.argv).toEqual(expect.arrayContaining(['commit', '--message=reviewed change']))
  })

  it('rejects external remote-helper addresses on push', async () => {
    const { ctx, spawn } = await setup({ approve: true })
    const result = await call(ctx, { operation: 'push', args: ['ext::sh -c touch /tmp/not-allowed'] })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_ARGUMENTS' } } })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('applies the session sandbox policy before spawning', async () => {
    const { ctx, spawn, confine } = await setup({ mode: 'read-only' })
    const result = await call(ctx, { operation: 'status', args: ['--short'] })
    expect(result.isError).toBe(false)
    expect(confine).toHaveBeenCalledWith(
      expect.arrayContaining(['core.fsmonitor=false', 'protocol.ext.allow=never', 'status']),
      expect.objectContaining({ mode: 'read-only', workspaceRoot: '/workspace' }),
      expect.any(AbortSignal),
    )
    expect(operationCalls(spawn)[0]?.argv).toEqual(expect.arrayContaining(['sandboxed-git', 'status']))
  })

  it('waits for the managed process range after caller cancellation', async () => {
    const waitForExit = vi.fn(() => Promise.resolve(true))
    const controller = new AbortController()
    const { ctx, spawn } = await setup({ onSpawn: spec => ({
      ...handle(),
      done: new Promise((resolve) => {
        spec.signal?.addEventListener('abort', () => { resolve({ exitCode: null, signal: 'SIGTERM' }) }, { once: true })
      }),
      waitForExit,
    }) })
    const pending = executeModelToolFixture(ctx, {
      callId: ToolCallId('git-cancel'), name: 'crew_git', arguments: { operation: 'status' },
      agent: { session: {} } as never, signal: controller.signal,
    })
    await vi.waitFor(() => { expect(operationCalls(spawn)).toHaveLength(1) })
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_ABORTED' } } })
    expect(waitForExit).toHaveBeenCalledOnce()
  })

  it('delegates unrelated calls and rejects malformed Crew Git inputs', async () => {
    const { ctx, spawn } = await setup()
    ctx.tools.register(defineTool({
      name: 'other', description: 'Unrelated test tool', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('other'),
    }))
    const unrelated = await executeModelToolFixture(ctx, {
      callId: ToolCallId('other-call'), name: 'other', arguments: {}, signal: new AbortController().signal,
    })
    expect(unrelated.isError).toBe(false)
    for (const args of [null, {}, { operation: 'unknown' }, { operation: 'status', args: [''] }, { operation: 'status', args: ['\0'] }]) {
      const result = await call(ctx, args)
      expect(result.isError).toBe(true)
    }
    expect(spawn).not.toHaveBeenCalled()
  })

  it('requires an Agent before resolving a repository', async () => {
    const { ctx, spawn } = await setup()
    const result = await executeModelToolFixture(ctx, {
      callId: ToolCallId('git-no-agent'), name: 'crew_git', arguments: { operation: 'status' },
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_AGENT_REQUIRED' } } })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('retains truncation and spill recovery facts in both output streams', async () => {
    const { ctx } = await setup({ onSpawn: () => ({
      ...handle(),
      collected: {
        stdout: { readFrom: () => ({ ...read('stdout'), spillPath: '/tmp/crew-git.stdout' }) },
        stderr: { readFrom: () => ({ ...read('stderr', true), spillPath: '/tmp/crew-git.stderr' }) },
      },
    }) })
    const result = await call(ctx, { operation: 'status' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected output success')
    expect(result.value).toMatchObject({
      stdout: { truncated: false, spillPath: '/tmp/crew-git.stdout' },
      stderr: { truncated: true, spillPath: '/tmp/crew-git.stderr' },
    })
  })

  it('fails visibly when the subprocess provider omits collected output', async () => {
    const { ctx } = await setup({ onSpawn: () => ({ ...handle(), collected: {} }) })
    const result = await call(ctx, { operation: 'status' })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_FAILED' } } })
  })

  it('distinguishes launch failure from cancellation during launch', async () => {
    for (const aborted of [false, true]) {
      const controller = new AbortController()
      const { ctx } = await setup({ onSpawn: () => {
        if (aborted) controller.abort()
        throw new Error('spawn refused')
      } })
      const result = await executeModelToolFixture(ctx, {
        callId: ToolCallId(`git-launch-${aborted}`), name: 'crew_git', arguments: { operation: 'status' },
        agent: { session: {} } as never, signal: controller.signal,
      })
      expect(result).toMatchObject({ isError: true, error: { info: { code: aborted ? 'CREW_GIT_ABORTED' : 'CREW_GIT_START_FAILED' } } })
    }
  })

  it('reports provider failure while waiting for a Git outcome', async () => {
    const waitForExit = vi.fn(() => Promise.resolve(true))
    const { ctx } = await setup({ onSpawn: () => ({ ...handle(), done: Promise.reject(new Error('provider failed')), waitForExit }) })
    const result = await call(ctx, { operation: 'status' })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_FAILED' } } })
    expect(waitForExit).toHaveBeenCalledOnce()
  })

  it.each([null, 'SIGTERM' as NodeJS.Signals])('renders signal exits with signal=%s', async (signal) => {
    const { ctx } = await setup({ onSpawn: () => handle({ exitCode: null, signal }) })
    const result = await call(ctx, { operation: 'status' })
    expect(result.isError).toBe(false)
    const [block] = result.content
    expect(block?.type).toBe('text')
    if (block?.type === 'text') expect(block.text).toContain(`signal ${signal ?? 'unknown'}`)
  })

  it('blanks every repository program a read could otherwise run', async () => {
    const { ctx, spawn } = await setup({
      configKeys: [
        'user.name',
        'filter.evil.clean',
        'filter.evil.smudge',
        'filter.evil.required',
        'merge.mine.driver',
        'diff.helper.textconv',
        'core.editor',
        'core.sshcommand',
        'credential.helper',
        'credential.https://example.invalid.helper',
        'gpg.program',
        'diff.renames',
      ],
    })
    const result = await call(ctx, { operation: 'status', args: ['--short'] })
    expect(result.isError).toBe(false)
    const argv = operationCalls(spawn)[0]?.argv ?? []
    // Every key that names a program is overridden to the empty string ...
    for (const key of [
      'filter.evil.clean', 'filter.evil.smudge', 'filter.evil.required', 'merge.mine.driver',
      'diff.helper.textconv', 'core.editor', 'core.sshcommand', 'credential.helper',
      'credential.https://example.invalid.helper', 'gpg.program',
    ]) {
      expect(argv).toEqual(expect.arrayContaining(['-c', `${key}=`]))
    }
    // ... and keys that only carry data are left alone.
    expect(argv).not.toEqual(expect.arrayContaining(['-c', 'user.name=']))
    expect(argv).not.toEqual(expect.arrayContaining(['-c', 'diff.renames=']))
  })

  it('keeps repository filters and drivers for an approved write', async () => {
    const { ctx, spawn } = await setup({
      approve: true,
      configKeys: ['filter.evil.clean', 'merge.mine.driver'],
    })
    const result = await call(ctx, { operation: 'checkout', args: ['--', 'tracked.txt'] })
    expect(result.isError).toBe(false)
    const argv = operationCalls(spawn)[0]?.argv ?? []
    expect(argv).toEqual(expect.arrayContaining(['checkout', '--', 'tracked.txt']))
    // A checkout restores content through the checkout's own filters (Git LFS),
    // so a write must not neutralize them.
    expect(argv).not.toEqual(expect.arrayContaining(['-c', 'filter.evil.clean=']))
    expect(argv).not.toEqual(expect.arrayContaining(['-c', 'merge.mine.driver=']))
  })

  it('refuses a read when the repository configuration cannot be read', async () => {
    const { ctx, spawn } = await setup({ configKeys: [] })
    // The probe reports a Git failure instead of a key listing.
    spawn.mockImplementation((spec: SubprocessSpawnSpec) => spec.argv.includes('config')
      ? handle({ exitCode: 128, signal: null }, '', 'fatal: not a git repository')
      : handle())
    const result = await call(ctx, { operation: 'status' })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_CONFIG_UNREADABLE' } } })
    expect(operationCalls(spawn)).toHaveLength(0)
  })

  it('rejects a process grace that exceeds the timer ceiling at configuration load', () => {
    expect(() => CrewGit.Config({ graceMs: MAX_TIMER_DELAY_MS + 1 })).toThrow()
  })

  it('validates the working directory and removes the tool on disposal', async () => {
    const { ctx, fiber, spawn } = await setup()
    const result = await call(ctx, { operation: 'status', cwd: 'relative' })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_ARGUMENTS' } } })
    expect(spawn).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'crew_git')).toBe(false)
  })
})
