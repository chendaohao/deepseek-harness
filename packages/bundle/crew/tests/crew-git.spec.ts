import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { SubprocessHandle, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as CrewGit from '../src/git.ts'

const contexts: Context[] = []
const temporaryDirectories: string[] = []
afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  } finally {
    vi.unstubAllEnvs()
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  }
})

function read(text: string, lossy = false): SubprocessOutputRead {
  return { text, nextOffset: Buffer.byteLength(text), lossy }
}

function handle(
  outcome: { exitCode: number | null; signal: NodeJS.Signals | null } = { exitCode: 0, signal: null },
  stdout = 'git stdout\n',
  stderr = 'git stderr\n',
  stdoutLossy = false,
): SubprocessHandle {
  return {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: {
      stdout: { readFrom: () => read(stdout, stdoutLossy) },
      stderr: { readFrom: () => read(stderr) },
    },
    done: Promise.resolve(outcome),
    terminate: () => {},
    waitForExit: () => Promise.resolve(true),
  }
}

/** The config listing a read enumerates before it starts; answers only that probe. */
function configListing(keys: readonly string[], lossy = false): (spec: SubprocessSpawnSpec) => SubprocessHandle | undefined {
  return spec => spec.argv.includes('config')
    ? handle({ exitCode: 0, signal: null }, keys.map(key => `${key}\0`).join(''), 'git stderr\n', lossy)
    : undefined
}

/** Spawn calls that actually ran the requested operation, skipping the config probe. */
function operationCalls(spawn: ReturnType<typeof vi.fn>) {
  return spawn.mock.calls.map(entry => entry[0] as SubprocessSpawnSpec).filter(spec => !spec.argv.includes('config'))
}

function environmentConfig(spec: SubprocessSpawnSpec | undefined): Record<string, string | undefined> {
  const entries: Record<string, string | undefined> = {}
  for (const [name, key] of Object.entries(spec?.env ?? {})) {
    const index = /^GIT_CONFIG_KEY_(\d+)$/.exec(name)?.[1]
    if (index === undefined || key === undefined) continue
    entries[key] = spec?.env?.['GIT_CONFIG_VALUE_' + index]
  }
  return entries
}

async function setup(options: {
  approve?: boolean
  mode?: 'danger-full-access' | 'read-only'
  onSpawn?: (spec: SubprocessSpawnSpec) => SubprocessHandle | undefined
  /** Repository configuration keys the read-time probe reports. */
  configKeys?: readonly string[]
  /** Whether the probe lost the head of its key listing. */
  configLossy?: boolean
} = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const spawn = vi.fn((spec: SubprocessSpawnSpec) => configListing(options.configKeys ?? [], options.configLossy === true)(spec)
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

async function setupReal(config: CrewGit.Config = {}) {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('workingDirectory', { ensure: () => Promise.resolve('/workspace') } as never)
  ctx.provide('sandbox', { confine: () => { throw new Error('danger-full-access must not confine') } } as never)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/workspace' }) } as never)
  ctx.provide('approval', { request: () => Promise.resolve('rejected') } as never)
  await ctx.plugin(CrewGit, config)
  return { ctx }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-crew-git-'))
  temporaryDirectories.push(path)
  return path
}

function git(cwd: string, args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')} failed: ${stderr}`, { cause: error }))
      else resolve(stdout)
    })
    child.stdin?.end(input)
  })
}

async function createRepository(root: string): Promise<string> {
  const repo = join(root, 'repo')
  await git(root, ['init', '--quiet', repo])
  await git(repo, ['config', 'user.name', 'Crew Test'])
  await git(repo, ['config', 'user.email', 'crew@example.invalid'])
  return repo
}

function shellQuote(path: string): string {
  return `'${path.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`
}

async function markerProgram(root: string) {
  const marker = join(root, 'executed')
  const script = join(root, 'marker.cjs')
  await writeFile(script, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')\n`)
  await chmod(script, 0o700)
  return { marker, program: script, command: `${shellQuote(process.execPath)} ${shellQuote(script)}` }
}

async function createFilteredRepository(root: string, filterName: string, command: string): Promise<string> {
  const repo = await createRepository(root)
  await writeFile(join(repo, 'a.txt'), 'stored\n')
  await writeFile(join(repo, '.gitattributes'), `a.txt filter=${filterName}\n`)
  await git(repo, ['add', 'a.txt', '.gitattributes'])
  await git(repo, ['commit', '--quiet', '-m', 'baseline'])
  await git(repo, ['config', `filter.${filterName}.clean`, command])
  await writeFile(join(repo, 'a.txt'), 'changed\n')
  return repo
}

/** Give HEAD an OpenPGP signature header so log can be asked to verify it. */
async function signHead(repo: string): Promise<void> {
  const raw = await git(repo, ['cat-file', 'commit', 'HEAD'])
  const signed = raw.replace('\n\n', '\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n fake\n -----END PGP SIGNATURE-----\n\n')
  const hash = (await git(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], signed)).trim()
  await git(repo, ['update-ref', 'HEAD', hash])
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
    expect(spec?.env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
      GIT_TRACE: undefined, GIT_TRACE2: undefined, GIT_TRACE2_EVENT: undefined, GIT_TRACE2_PERF: undefined,
    })
    expect(environmentConfig(spec)).toEqual({ 'log.showSignature': 'false', 'format.pretty': 'medium' })
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

  it.each(['log', 'show'])('rejects signature-verifying pretty formats for %s before spawning', async (operation) => {
    const { ctx, spawn } = await setup()
    const result = await call(ctx, { operation, args: ['--format=%G?'] })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_ARGUMENTS' } } })
    expect(spawn).not.toHaveBeenCalled()

    for (const format of ['--format=%%G?', '--format=%s']) {
      const literal = await call(ctx, { operation, args: [format] })
      expect(literal.isError).toBe(false)
    }
    const nonFormat = await call(ctx, { operation, args: [operation === 'log' ? '--oneline' : '--stat'] })
    expect(nonFormat.isError).toBe(false)
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

  it('preserves a provider failure when managed-range observation also fails', async () => {
    const { ctx } = await setup({ onSpawn: () => ({
      ...handle(),
      done: Promise.reject(new Error('provider failed')),
      waitForExit: () => Promise.reject(new Error('range unavailable')),
    }) })
    const result = await call(ctx, { operation: 'status' })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_FAILED' } } })
  })

  it('preserves cancellation when managed-range observation also fails', async () => {
    const controller = new AbortController()
    const { ctx, spawn } = await setup({ onSpawn: spec => ({
      ...handle(),
      done: new Promise((resolve) => {
        spec.signal?.addEventListener('abort', () => { resolve({ exitCode: null, signal: 'SIGTERM' }) }, { once: true })
      }),
      waitForExit: () => Promise.reject(new Error('range unavailable')),
    }) })
    const pending = executeModelToolFixture(ctx, {
      callId: ToolCallId('git-cancel-range-failure'), name: 'crew_git', arguments: { operation: 'status' },
      agent: { session: {} } as never, signal: controller.signal,
    })
    await vi.waitFor(() => { expect(operationCalls(spawn)).toHaveLength(1) })
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_ABORTED' } } })
  })

  it('reports managed-range observation failure after a Git outcome', async () => {
    const { ctx } = await setup({ onSpawn: () => ({
      ...handle(), waitForExit: () => Promise.reject(new Error('range unavailable')),
    }) })
    const result = await call(ctx, { operation: 'status' })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_FAILED' } } })
  })

  it.each([null, 'SIGTERM' as NodeJS.Signals])('renders signal exits with signal=%s', async (signal) => {
    const { ctx } = await setup({ onSpawn: () => handle({ exitCode: null, signal }) })
    const result = await call(ctx, { operation: 'status' })
    expect(result.isError).toBe(false)
    const [block] = result.content
    expect(block?.type).toBe('text')
    if (block?.type === 'text') expect(block.text).toContain(`signal ${signal ?? 'unknown'}`)
  })

  it('overrides every repository program with environment key/value pairs', async () => {
    const { ctx, spawn } = await setup({
      configKeys: [
        'user.name',
        'filter.evil.clean',
        'filter.evil=1.clean',
        'filter.evil.smudge',
        'filter.evil.required',
        'merge.mine.driver',
        'diff.helper.textconv',
        'core.editor',
        'core.sshcommand',
        'credential.helper',
        'credential.https://example.invalid.helper',
        'gpg.program',
        'gpg.openpgp.program',
        'gpg.ssh.defaultKeyCommand',
        'diff.renames',
      ],
    })
    const result = await call(ctx, { operation: 'status', args: ['--short'] })
    expect(result.isError).toBe(false)
    const config = environmentConfig(operationCalls(spawn)[0])
    for (const key of [
      'filter.evil.clean', 'filter.evil=1.clean', 'filter.evil.smudge', 'filter.evil.required', 'merge.mine.driver',
      'diff.helper.textconv', 'core.editor', 'core.sshcommand', 'credential.helper',
      'credential.https://example.invalid.helper', 'gpg.program', 'gpg.openpgp.program', 'gpg.ssh.defaultKeyCommand',
    ]) {
      expect(config[key]).toBe('')
    }
    expect(config['log.showSignature']).toBe('false')
    expect(config['format.pretty']).toBe('medium')
    expect(config).not.toHaveProperty('user.name')
    expect(config).not.toHaveProperty('diff.renames')
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
    expect(environmentConfig(operationCalls(spawn)[0])).toEqual({})
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

  it('refuses a read when the configuration listing is truncated', async () => {
    const { ctx, spawn } = await setup({ configLossy: true })
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

describe('Crew commander Git real execution regressions', () => {
  it('does not execute a filter whose subsection contains an equals sign', async () => {
    const root = await temporaryDirectory()
    const { marker, command } = await markerProgram(root)
    const repo = await createFilteredRepository(root, 'evil=1', command)
    const { ctx } = await setupReal()
    const result = await call(ctx, { operation: 'diff', cwd: repo })
    expect(result.isError).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })

  // The fake OpenPGP executable uses a POSIX shebang; the env contract tests remain platform-neutral.
  it.runIf(process.platform !== 'win32')('does not execute an OpenPGP program selected by repository configuration', async () => {
    const root = await temporaryDirectory()
    const { marker, program } = await markerProgram(root)
    const repo = await createRepository(root)
    await writeFile(join(repo, 'a.txt'), 'stored\n')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['commit', '--quiet', '-m', 'baseline'])
    await signHead(repo)
    await git(repo, ['config', 'gpg.openpgp.program', program])
    await git(repo, ['config', 'log.showSignature', 'true'])
    const { ctx } = await setupReal()
    const result = await call(ctx, { operation: 'log', cwd: repo })
    expect(result.isError).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })

  // The fake default gpg also uses a POSIX shebang.
  it.runIf(process.platform !== 'win32')('does not run a default verifier selected by format.pretty', async () => {
    const root = await temporaryDirectory()
    const { marker, program } = await markerProgram(root)
    const bin = join(root, 'bin')
    await mkdir(bin)
    await rename(program, join(bin, 'gpg'))
    vi.stubEnv('PATH', bin + delimiter + (process.env.PATH ?? ''))
    const repo = await createRepository(root)
    await writeFile(join(repo, 'a.txt'), 'stored\n')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['commit', '--quiet', '-m', 'baseline'])
    await signHead(repo)
    await git(repo, ['config', 'format.pretty', '%G?'])
    const { ctx } = await setupReal()
    const result = await call(ctx, { operation: 'log', cwd: repo })
    expect(result.isError).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })

  it('refuses a truncated configuration listing before running the read', async () => {
    const root = await temporaryDirectory()
    const { marker, command } = await markerProgram(root)
    const repo = await createFilteredRepository(root, 'evil', command)
    const padding = `[pad]\n${Array.from({ length: 32 }, (_, index) =>
      `k${String(index).padStart(2, '0')}${'x'.repeat(80)} = value\n`).join('')}`
    await appendFile(join(repo, '.git', 'config'), padding)
    const { ctx } = await setupReal({ maxOutputBytes: 128 })
    const result = await call(ctx, { operation: 'diff', cwd: repo })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_CONFIG_UNREADABLE' } } })
    expect(existsSync(marker)).toBe(false)
  })

  it('does not write an inherited Git trace file during reads', async () => {
    const root = await temporaryDirectory()
    const repo = await createRepository(root)
    const trace = join(root, 'trace.log')
    vi.stubEnv('GIT_TRACE', trace)
    const { ctx } = await setupReal()
    const result = await call(ctx, { operation: 'status', cwd: repo })
    expect(result.isError).toBe(false)
    expect(existsSync(trace)).toBe(false)
  })
})
