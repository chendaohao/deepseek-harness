import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
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
  requireWriteApproval?: boolean
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
  const fiber = await ctx.plugin(CrewGit, options.requireWriteApproval === undefined
    ? {}
    : { requireWriteApproval: options.requireWriteApproval })
  return { ctx, fiber, spawn, request, confine }
}

async function setupReal(config: CrewGit.Config = {}, globalConfig = '/dev/null') {
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
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
  const request = vi.fn(() => Promise.resolve('rejected'))
  ctx.provide('approval', { request } as never)
  await ctx.plugin(CrewGit, config)
  return { ctx, request }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-crew-git-'))
  temporaryDirectories.push(path)
  return path
}

function git(cwd: string, args: readonly string[], input?: string, globalConfig = '/dev/null'): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' },
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

/** A private global Git config directory so a test can record Trace2 events. */
async function gitGlobalDirectory(root: string): Promise<string> {
  const path = join(root, 'git-global')
  await mkdir(path, { recursive: true })
  return path
}

/** Count `git maintenance` child processes a Trace2 event log recorded. */
async function maintenanceRuns(tracePath: string): Promise<number> {
  let text: string
  try {
    text = await readFile(tracePath, 'utf8')
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return 0
    throw error
  }
  return text.split('\n').filter(line => line.includes('"argv":[') && line.includes('"maintenance"')).length
}

/** A repository with one ordinary commit followed by a merge, plus a `side` branch. */
async function createMergeRepository(root: string): Promise<string> {
  const repo = await createRepository(root)
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await git(repo, ['add', 'a.txt'])
  await git(repo, ['commit', '--quiet', '-m', 'one'])
  // Pin the first branch name so `main...side` below does not depend on init.defaultBranch.
  await git(repo, ['checkout', '--quiet', '-B', 'main'])
  await git(repo, ['branch', 'side'])
  await writeFile(join(repo, 'a.txt'), 'two\n')
  await git(repo, ['commit', '--quiet', '-am', 'two'])
  await git(repo, ['checkout', '--quiet', 'side'])
  await writeFile(join(repo, 'b.txt'), 'side\n')
  await git(repo, ['add', 'b.txt'])
  await git(repo, ['commit', '--quiet', '-m', 'side'])
  await git(repo, ['checkout', '--quiet', 'main'])
  await git(repo, ['merge', '--quiet', '--no-ff', '-m', 'merge side', 'side'])
  return repo
}

/** A bare remote whose `main` holds one commit. */
async function createRemoteWithMain(root: string): Promise<string> {
  const bare = join(root, 'remote.git')
  const source = join(root, 'source')
  await git(root, ['init', '--quiet', '--bare', bare])
  await git(root, ['init', '--quiet', source])
  await git(source, ['config', 'user.name', 'Crew Test'])
  await git(source, ['config', 'user.email', 'crew@example.invalid'])
  await writeFile(join(source, 'a.txt'), 'base\n')
  await git(source, ['add', 'a.txt'])
  await git(source, ['commit', '--quiet', '-m', 'base'])
  await git(source, ['push', '--quiet', bare, 'HEAD:refs/heads/main'])
  // A bare remote with no HEAD ref clones into a repository with no local branch.
  await git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  return bare
}

/** Clone a prepared remote; the clone's `origin` is a local path, so nothing reaches the network. */
async function cloneRepository(root: string, remote: string): Promise<string> {
  const repo = join(root, 'clone')
  await git(root, ['clone', '--quiet', remote, repo])
  await git(repo, ['config', 'user.name', 'Crew Test'])
  await git(repo, ['config', 'user.email', 'crew@example.invalid'])
  return repo
}

/** Push one more commit to the remote's `main` and return the new commit id. */
async function advanceRemoteMain(root: string, remote: string, name = 'advance.txt'): Promise<string> {
  const source = join(root, 'source')
  await writeFile(join(source, name), `${name}\n`)
  await git(source, ['add', name])
  await git(source, ['commit', '--quiet', '-m', name])
  await git(source, ['push', '--quiet', remote, 'HEAD:refs/heads/main'])
  return (await git(source, ['rev-parse', 'HEAD'])).trim()
}

/** Give HEAD an OpenPGP signature header so log can be asked to verify it. */
async function signHead(repo: string): Promise<void> {
  const raw = await git(repo, ['cat-file', 'commit', 'HEAD'])
  const signed = raw.replace('\n\n', '\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n fake\n -----END PGP SIGNATURE-----\n\n')
  const hash = (await git(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], signed)).trim()
  await git(repo, ['update-ref', 'HEAD', hash])
}

/** The output fields `crew_git` projects for one finished Git process. */
interface GitProjection {
  readonly operation: string
  readonly exitCode: number | null
  readonly stdout: { readonly text: string }
  readonly stderr: { readonly text: string }
}

/** Read one string field from a JSON object, refusing anything else. */
function jsonString(container: object, key: string): string {
  const value: unknown = Reflect.get(container, key)
  if (typeof value !== 'string') throw new TypeError(`expected ${key} to be a string`)
  return value
}

/** Read one nested text field, the only shape `crew_git` returns for a stream. */
function jsonText(container: object, key: string): string {
  const stream: unknown = Reflect.get(container, key)
  if (typeof stream !== 'object' || stream === null) throw new TypeError(`expected ${key} to be an object`)
  return jsonString(stream, 'text')
}

/** Read a successful `crew_git` projection, which its output schema fixes as an object. */
function projectionOf(result: { readonly isError: false; readonly value: JsonValue }): GitProjection {
  if (typeof result.value !== 'object' || result.value === null || Array.isArray(result.value)) {
    throw new TypeError('expected a crew_git projection object')
  }
  const exitCode: unknown = Reflect.get(result.value, 'exitCode')
  if (typeof exitCode !== 'number' && exitCode !== null) throw new TypeError('expected an exit code')
  return {
    operation: jsonString(result.value, 'operation'),
    exitCode,
    stdout: { text: jsonText(result.value, 'stdout') },
    stderr: { text: jsonText(result.value, 'stderr') },
  }
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

  it('keeps sandbox confinement when write approval is disabled', async () => {
    const { ctx, spawn, request, confine } = await setup({ mode: 'read-only', requireWriteApproval: false })
    const result = await call(ctx, { operation: 'commit', args: ['--message=authorized change'] })
    expect(result.isError).toBe(false)
    expect(request).not.toHaveBeenCalled()
    expect(confine).toHaveBeenCalledWith(
      expect.arrayContaining(['commit', '--message=authorized change']),
      expect.objectContaining({ mode: 'read-only', workspaceRoot: '/workspace' }),
      expect.any(AbortSignal),
    )
    expect(operationCalls(spawn)[0]?.argv).toEqual(expect.arrayContaining(['sandboxed-git', 'commit']))
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

  it.each([
    ['log', ['-v']],
    ['log', ['-5']],
    ['log', ['--no-merges']],
    ['log', ['--numstat', '--first-parent']],
    ['diff', ['--numstat']],
    ['show', ['--numstat']],
  ] as const)('runs %s with the extended read option %j without write approval', async (operation, args) => {
    const { ctx, spawn, request } = await setup()
    const result = await call(ctx, { operation, args })
    expect(result.isError).toBe(false)
    expect(request).not.toHaveBeenCalled()
    const argv = operationCalls(spawn)[0]?.argv ?? []
    expect(argv).toEqual(expect.arrayContaining([operation, ...args]))
    // The read-time program probe still precedes the operation.
    expect(spawn.mock.calls[0]?.[0].argv).toEqual(expect.arrayContaining(['config', '--name-only', '--list']))
  })

  it.each([
    ['rev-list', ['--count', 'HEAD']],
    ['rev-list', ['--left-right', '--count', 'main...side']],
    ['rev-list', ['--no-merges', 'HEAD']],
    ['rev-list', ['--first-parent', '-5']],
  ] as const)('runs rev-list as a read with %j', async (operation, args) => {
    const { ctx, spawn, request } = await setup()
    const result = await call(ctx, { operation, args })
    expect(result.isError).toBe(false)
    expect(request).not.toHaveBeenCalled()
    expect(operationCalls(spawn)[0]?.argv).toEqual(expect.arrayContaining(['rev-list', ...args]))
  })

  it.each([
    ['log', ['--verbose'], 'Git accepts -v on log and show and rejects --verbose'],
    ['show', ['--verbose'], 'Git accepts -v on log and show and rejects --verbose'],
    ['diff', ['--verbose'], 'Git accepts -v on log and show and rejects --verbose'],
    ['log', ['--count'], 'Use rev-list --count for a commit count'],
    ['rev-list', ['--numstat'], 'Use log --numstat --first-parent'],
    ['rev-list', ['--stat'], 'Use log --numstat --first-parent'],
    ['status', ['-Z'], 'Accepted: --short'],
    ['rebase', ['--exec=touch /tmp/x'], 'Accepted: --continue'],
  ] as const)('rejects %s %j before spawning with a usable alternative', async (operation, args, hint) => {
    const { ctx, spawn } = await setup({ approve: true })
    const result = await call(ctx, { operation, args })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_ARGUMENTS' } } })
    expect(spawn).not.toHaveBeenCalled()
    const message = result.isError ? result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') : ''
    expect(message).toContain(operation)
    expect(message).toContain(JSON.stringify(args[0] as string))
    expect(message).toContain(hint)
  })

  it.each([['-0'], ['-5'], ['-000']])('accepts %s as a decimal commit limit on log and rev-list', async (limit) => {
    const { ctx, spawn } = await setup()
    for (const operation of ['log', 'rev-list'] as const) {
      const result = await call(ctx, { operation, args: [limit] })
      expect(result.isError).toBe(false)
    }
    expect(operationCalls(spawn)).toHaveLength(2)
  })

  it.each([['-5x'], ['--5'], ['-n5']])('rejects %s as a malformed commit limit', async (limit) => {
    const { ctx, spawn } = await setup()
    const result = await call(ctx, { operation: 'rev-list', args: [limit] })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_ARGUMENTS' } } })
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([
    [[]],
    [['--all']],
    [['--list', 'topic/*']],
    [['--show-current']],
    [['--contains=HEAD']],
    [['--merged=main', '--format=%(refname:short)']],
  ] as const)('classifies branch %j as a read query', async (args) => {
    const { ctx, spawn, request } = await setup()
    const result = await call(ctx, { operation: 'branch', args })
    expect(result.isError).toBe(false)
    expect(request).not.toHaveBeenCalled()
    expect(operationCalls(spawn)[0]?.argv).toEqual(expect.arrayContaining(['branch', ...args]))
    expect(ctx.tools.get('crew_git')?.isConcurrencySafe?.({ operation: 'branch', args })).toBe(true)
  })

  it.each([[['crew-test/one']], [['crew-test/two', 'HEAD']]])('creates branch from %j as a write with an injected --no-track', async (args) => {
    const { ctx, spawn, request } = await setup({ approve: true })
    const result = await call(ctx, { operation: 'branch', args })
    expect(result.isError).toBe(false)
    expect(request).toHaveBeenCalledOnce()
    expect(operationCalls(spawn)[0]?.argv).toEqual(expect.arrayContaining(['branch', '--no-track', ...args]))
    // A write must not pay for the read-time program probe.
    expect(spawn.mock.calls.some(entry => entry[0].argv.includes('config'))).toBe(false)
    expect(ctx.tools.get('crew_git')?.isConcurrencySafe?.({ operation: 'branch', args })).toBe(false)
  })

  it('does not create a branch when its approval is refused', async () => {
    const { ctx, spawn } = await setup({ approve: false })
    const result = await call(ctx, { operation: 'branch', args: ['crew-test/refused'] })
    expect(result.isError).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([
    [['-D', 'main']],
    [['-m', 'main', 'renamed']],
    [['-f', 'main', 'HEAD']],
    [['--track', 'new', 'origin/main']],
    [['--no-track', 'new', 'origin/main']],
    [['--list', '-D', 'main']],
    [['--list', '--delete', 'main']],
    [['one', 'two', 'three']],
  ] as const)('rejects the branch mutation form %j', async (args) => {
    const { ctx, spawn } = await setup({ approve: true })
    const result = await call(ctx, { operation: 'branch', args })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_ARGUMENTS' } } })
    expect(spawn).not.toHaveBeenCalled()
    const message = result.isError ? result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') : ''
    expect(message).toContain('branch <new-branch> [<start-point>]')
    expect(message).toContain('--no-track')
  })

  it('requests approval for every fetch, including a dry run', async () => {
    for (const args of [['origin'], ['--dry-run', 'origin'], ['--prune', 'origin']]) {
      const { ctx, request } = await setup({ approve: false })
      const result = await call(ctx, { operation: 'fetch', args })
      expect(result.isError).toBe(true)
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'crew_git' }))
      expect(ctx.tools.get('crew_git')?.isConcurrencySafe?.({ operation: 'fetch', args })).toBe(false)
    }
  })

  it.each([
    [['origin'], '--no-prune'],
    [['--prune', 'origin'], '--prune'],
    [['--no-prune', '--dry-run', 'origin'], '--no-prune'],
  ] as const)('generates the fixed fetch argv for %j', async (args, pruneFlag) => {
    const { ctx, spawn, request } = await setup({ approve: true })
    const result = await call(ctx, { operation: 'fetch', args })
    expect(result.isError).toBe(false)
    expect(request).toHaveBeenCalledOnce()
    const argv = operationCalls(spawn)[0]?.argv ?? []
    expect(argv.slice(argv.indexOf('fetch'))).toEqual([
      'fetch', pruneFlag,
      '--no-tags', '--no-prune-tags', '--no-write-fetch-head', '--no-auto-gc',
      '--upload-pack=git-upload-pack', '--refmap=',
      ...(args as readonly string[]).includes('--dry-run') ? ['--dry-run'] : [],
      'origin', '+refs/heads/*:refs/remotes/origin/*',
    ])
    expect(spawn.mock.calls.some(entry => entry[0].argv.includes('config'))).toBe(false)
  })

  it.each([
    [[]],
    [['origin', 'upstream']],
    [['https://example.invalid/repo.git']],
    [['../repo.git']],
    [['ext::sh -c touch% /tmp/x']],
    [['origin', 'main:local']],
    [['--tags', 'origin']],
    [['-f', 'origin']],
    [['foo.bar']],
    [['foo/bar']],
    [['foo..bar']],
    [['-origin']],
    [['--prune', '--no-prune', 'origin']],
  ] as const)('rejects the fetch form %j', async (args) => {
    // Approval passes here so the assertions reach argument validation rather than its refusal.
    const { ctx, spawn } = await setup({ approve: true })
    const result = await call(ctx, { operation: 'fetch', args })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CREW_GIT_ARGUMENTS' } } })
    expect(spawn).not.toHaveBeenCalled()
    const message = result.isError ? result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') : ''
    expect(message).toContain('fetch')
    expect(message).toContain('[A-Za-z0-9][A-Za-z0-9_-]*')
  })

  it.each(['origin', 'upstream-1', 'fork_1'])('accepts the named remote %s', async (remote) => {
    const { ctx } = await setup({ approve: true })
    const result = await call(ctx, { operation: 'fetch', args: [remote] })
    expect(result.isError).toBe(false)
  })

  it('returns a non-zero Git exit as a structured result rather than a tool error', async () => {
    const { ctx } = await setup({ onSpawn: () => handle({ exitCode: 128, signal: null }, '', 'fatal: bad revision\n') })
    const result = await call(ctx, { operation: 'rev-list', args: ['--count', 'nope'] })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a structured Git failure')
    expect(result.value).toMatchObject({ exitCode: 128, stderr: { text: 'fatal: bad revision\n' } })
  })

  it('keeps rev-list reads parallel and every fetch exclusive', async () => {
    const { ctx } = await setup()
    const tool = ctx.tools.get('crew_git')
    expect(tool?.isConcurrencySafe?.({ operation: 'rev-list', args: ['--count', 'HEAD'] })).toBe(true)
    expect(tool?.isConcurrencySafe?.({ operation: 'log', args: ['--numstat'] })).toBe(true)
    expect(tool?.isConcurrencySafe?.({ operation: 'branch', args: ['--show-current'] })).toBe(true)
    for (const args of [{ operation: 'fetch', args: ['origin'] }, { operation: 'branch', args: ['new-branch'] }, { operation: 'commit', args: [] }, null, {}, { operation: 'unknown' }]) {
      expect(tool?.isConcurrencySafe?.(args)).toBe(false)
    }
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
  it('executes a configured write without calling the rejecting approval answerer', async () => {
    const root = await temporaryDirectory()
    const repo = await createRepository(root)
    await writeFile(join(repo, 'a.txt'), 'checkpoint\n')
    await git(repo, ['add', 'a.txt'])
    const { ctx, request } = await setupReal({ requireWriteApproval: false })
    const result = await call(ctx, { operation: 'commit', cwd: repo, args: ['--message=checkpoint'] })
    expect(result.isError).toBe(false)
    expect(request).not.toHaveBeenCalled()
    expect((await git(repo, ['log', '-1', '--format=%s'])).trim()).toBe('checkpoint')
  })

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

  it('runs the extended read options against a real repository, including merge numstat', async () => {
    const root = await temporaryDirectory()
    const repo = await createMergeRepository(root)
    const { ctx } = await setupReal()
    const merge = (await git(repo, ['rev-list', '--merges', '-1', 'HEAD'])).trim()

    for (const [operation, args] of [
      ['log', ['-v', '-1', '--oneline']],
      ['log', ['-5', '--oneline']],
      ['log', ['--no-merges', '--oneline']],
      ['log', ['--numstat', '-1', '--first-parent']],
      ['diff', ['--numstat', 'HEAD~1', 'HEAD']],
      ['show', ['--numstat', '--format=%s', merge]],
      ['rev-list', ['--count', 'HEAD']],
      ['rev-list', ['--left-right', '--count', 'main...side']],
      ['rev-list', ['--no-merges', 'HEAD']],
      ['rev-list', ['--first-parent', '-2', 'HEAD']],
    ] as const) {
      const result = await call(ctx, { operation, cwd: repo, args: [...args] })
      expect(result.isError, `${operation} ${args.join(' ')}`).toBe(false)
      if (result.isError) throw new Error('expected read success')
      expect(projectionOf(result).exitCode, `${operation} ${args.join(' ')}`).toBe(0)
    }

    const withoutFirstParent = await call(ctx, { operation: 'log', cwd: repo, args: ['--numstat', '-1', '--format=%s', merge] })
    const withFirstParent = await call(ctx, { operation: 'log', cwd: repo, args: ['--numstat', '--first-parent', '-1', '--format=%s', merge] })
    const direct = await call(ctx, { operation: 'diff', cwd: repo, args: ['--numstat', `${merge}^1`, merge] })
    if (withoutFirstParent.isError || withFirstParent.isError || direct.isError) throw new Error('expected numstat reads to succeed')
    const numeric = (text: string): string[] => text.split('\n').filter(line => /^[0-9-]+\t[0-9-]+\t/.test(line))
    expect(numeric(projectionOf(withoutFirstParent).stdout.text)).toEqual([])
    expect(numeric(projectionOf(withFirstParent).stdout.text)).toEqual(numeric(projectionOf(direct).stdout.text))
    expect(numeric(projectionOf(direct).stdout.text).length).toBeGreaterThan(0)
  }, 60_000)

  it('creates a branch without auto-tracking and leaves HEAD, index, and worktree alone', async () => {
    const root = await temporaryDirectory()
    const remote = await createRemoteWithMain(root)
    const repo = await cloneRepository(root, remote)
    await git(repo, ['config', 'branch.autoSetupMerge', 'true'])
    await writeFile(join(repo, 'dirty.txt'), 'untracked\n')
    await writeFile(join(repo, 'a.txt'), 'dirty worktree\n')
    const before = await git(repo, ['rev-parse', 'HEAD'])
    const headRef = await git(repo, ['symbolic-ref', 'HEAD'])
    const index = await git(repo, ['write-tree'])

    const { ctx } = await setupReal({ requireWriteApproval: false })
    const created = await call(ctx, { operation: 'branch', cwd: repo, args: ['crew-test/backup', 'origin/main'] })
    expect(created.isError).toBe(false)
    if (created.isError) throw new Error('expected branch creation to succeed')
    expect(projectionOf(created).exitCode).toBe(0)

    expect((await git(repo, ['rev-parse', 'refs/heads/crew-test/backup'])).trim())
      .toBe((await git(repo, ['rev-parse', 'origin/main'])).trim())
    await expect(git(repo, ['config', '--get', 'branch.crew-test/backup.remote'])).rejects.toThrow()
    await expect(git(repo, ['config', '--get', 'branch.crew-test/backup.merge'])).rejects.toThrow()
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(before)
    expect(await git(repo, ['symbolic-ref', 'HEAD'])).toBe(headRef)
    expect(await git(repo, ['write-tree'])).toBe(index)
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('dirty worktree\n')
    expect(await readFile(join(repo, 'dirty.txt'), 'utf8')).toBe('untracked\n')

    const query = await call(ctx, { operation: 'branch', cwd: repo, args: ['--list', 'crew-test/*'] })
    expect(query.isError).toBe(false)
    if (query.isError) throw new Error('expected branch query to succeed')
    expect(projectionOf(query).stdout.text).toContain('crew-test/backup')
  })

  it('fetches only refs/remotes/<remote>/* while hostile repository configuration stays inert', async () => {
    const root = await temporaryDirectory()
    const remote = await createRemoteWithMain(root)
    const repo = await cloneRepository(root, remote)
    await git(repo, ['branch', 'keep-local'])
    await git(repo, ['tag', 'keep-tag'])
    await writeFile(join(repo, '.git', 'FETCH_HEAD'), 'sentinel-fetch-head\n')
    await git(repo, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/CFG/*'])
    await git(repo, ['config', 'remote.origin.pruneTags', 'true'])
    await git(repo, ['config', 'remote.origin.prune', 'true'])
    await git(repo, ['config', 'fetch.prune', 'true'])
    await git(repo, ['config', 'remote.origin.tagOpt', '--tags'])
    const localBranch = await git(repo, ['rev-parse', 'refs/heads/keep-local'])
    const localTag = await git(repo, ['rev-parse', 'refs/tags/keep-tag'])
    const trackingBefore = await git(repo, ['rev-parse', 'refs/remotes/origin/main'])
    const { ctx } = await setupReal({ requireWriteApproval: false })

    const dryRun = await call(ctx, { operation: 'fetch', cwd: repo, args: ['--dry-run', 'origin'] })
    expect(dryRun.isError).toBe(false)
    if (dryRun.isError) throw new Error('expected the dry run to reach Git')
    expect(projectionOf(dryRun).exitCode).toBe(0)
    expect(await git(repo, ['rev-parse', 'refs/remotes/origin/main'])).toBe(trackingBefore)

    const expected = await advanceRemoteMain(root, remote)
    const fetched = await call(ctx, { operation: 'fetch', cwd: repo, args: ['origin'] })
    expect(fetched.isError).toBe(false)
    if (fetched.isError) throw new Error('expected the fetch to reach Git')
    expect(projectionOf(fetched).exitCode).toBe(0)
    expect((await git(repo, ['rev-parse', 'refs/remotes/origin/main'])).trim()).toBe(expected)
    expect(await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/CFG/'])).toBe('')
    expect(await git(repo, ['rev-parse', 'refs/heads/keep-local'])).toBe(localBranch)
    expect(await git(repo, ['rev-parse', 'refs/tags/keep-tag'])).toBe(localTag)
    expect(await readFile(join(repo, '.git', 'FETCH_HEAD'), 'utf8')).toBe('sentinel-fetch-head\n')

    const stale = await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/'])
    expect(stale).toContain('refs/remotes/origin/main')
  })

  it('prunes a stale remote-tracking ref only when --prune is explicit', async () => {
    const root = await temporaryDirectory()
    const remote = await createRemoteWithMain(root)
    const repo = await cloneRepository(root, remote)
    await git(repo, ['branch', 'keep-local'])
    await git(repo, ['tag', 'keep-tag'])
    await writeFile(join(repo, '.git', 'FETCH_HEAD'), 'sentinel-fetch-head\n')
    await git(repo, ['update-ref', 'refs/remotes/origin/gone', 'HEAD'])
    await git(repo, ['config', 'remote.origin.prune', 'true'])
    await git(repo, ['config', 'fetch.prune', 'true'])
    const localBranch = await git(repo, ['rev-parse', 'refs/heads/keep-local'])
    const localTag = await git(repo, ['rev-parse', 'refs/tags/keep-tag'])
    const { ctx } = await setupReal({ requireWriteApproval: false })

    const expectedKept = await advanceRemoteMain(root, remote)
    const kept = await call(ctx, { operation: 'fetch', cwd: repo, args: ['origin'] })
    expect(kept.isError).toBe(false)
    if (kept.isError) throw new Error('expected the fetch to reach Git')
    expect(projectionOf(kept).exitCode).toBe(0)
    expect((await git(repo, ['rev-parse', 'refs/remotes/origin/main'])).trim()).toBe(expectedKept)
    expect(await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/gone'])).toContain('refs/remotes/origin/gone')

    const expectedPruned = await advanceRemoteMain(root, remote, 'second.txt')
    const pruned = await call(ctx, { operation: 'fetch', cwd: repo, args: ['--prune', 'origin'] })
    expect(pruned.isError).toBe(false)
    if (pruned.isError) throw new Error('expected the pruning fetch to reach Git')
    expect(projectionOf(pruned).exitCode).toBe(0)
    expect((await git(repo, ['rev-parse', 'refs/remotes/origin/main'])).trim()).toBe(expectedPruned)
    expect(await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/gone'])).toBe('')
    expect(await git(repo, ['rev-parse', 'refs/heads/keep-local'])).toBe(localBranch)
    expect(await git(repo, ['rev-parse', 'refs/tags/keep-tag'])).toBe(localTag)
    expect(await readFile(join(repo, '.git', 'FETCH_HEAD'), 'utf8')).toBe('sentinel-fetch-head\n')
  })

  it.runIf(process.platform !== 'win32')('does not run the repository-configured upload-pack program', async () => {
    const root = await temporaryDirectory()
    const remote = await createRemoteWithMain(root)
    const repo = await cloneRepository(root, remote)
    const { marker, program } = await markerProgram(root)
    await git(repo, ['config', 'remote.origin.uploadpack', program])
    await git(repo, ['branch', 'keep-local'])
    await git(repo, ['tag', 'keep-tag'])
    await writeFile(join(repo, '.git', 'FETCH_HEAD'), 'sentinel-fetch-head\n')
    const localBranch = await git(repo, ['rev-parse', 'refs/heads/keep-local'])
    const localTag = await git(repo, ['rev-parse', 'refs/tags/keep-tag'])
    const expected = await advanceRemoteMain(root, remote)
    const { ctx } = await setupReal({ requireWriteApproval: false })

    const result = await call(ctx, { operation: 'fetch', cwd: repo, args: ['origin'] })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected the fetch to reach Git')
    expect(projectionOf(result).exitCode).toBe(0)
    expect((await git(repo, ['rev-parse', 'refs/remotes/origin/main'])).trim()).toBe(expected)
    expect(existsSync(marker)).toBe(false)
    expect(await git(repo, ['rev-parse', 'refs/heads/keep-local'])).toBe(localBranch)
    expect(await git(repo, ['rev-parse', 'refs/tags/keep-tag'])).toBe(localTag)
    expect(await readFile(join(repo, '.git', 'FETCH_HEAD'), 'utf8')).toBe('sentinel-fetch-head\n')
  })

  it('suppresses automatic maintenance while an equivalent bare fetch runs it', async () => {
    const root = await temporaryDirectory()
    const remote = await createRemoteWithMain(root)
    const repo = await cloneRepository(root, remote)
    await git(repo, ['branch', 'keep-local'])
    await git(repo, ['tag', 'keep-tag'])
    await writeFile(join(repo, '.git', 'FETCH_HEAD'), 'sentinel-fetch-head\n')
    const localBranch = await git(repo, ['rev-parse', 'refs/heads/keep-local'])
    const localTag = await git(repo, ['rev-parse', 'refs/tags/keep-tag'])
    // Trace2 records a `maintenance run --auto` child process, so the control proves
    // this checkout would maintain on its own and the fixed argv suppresses it.
    const trace = join(root, 'trace2.json')
    const globalDirectory = await gitGlobalDirectory(root)
    await writeFile(join(globalDirectory, 'config'), `[trace2]\n\teventTarget = ${trace}\n`)

    const controlExpected = await advanceRemoteMain(root, remote, 'control.txt')
    await git(repo, ['fetch', '--no-prune', '--no-tags', '--no-prune-tags', '--no-write-fetch-head',
      '--upload-pack=git-upload-pack', '--refmap=', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
    undefined, join(globalDirectory, 'config'))
    expect((await git(repo, ['rev-parse', 'refs/remotes/origin/main'])).trim()).toBe(controlExpected)
    const controlCount = await maintenanceRuns(trace)
    expect(controlCount).toBeGreaterThan(0)

    const expected = await advanceRemoteMain(root, remote, 'fixed.txt')
    await rm(trace, { force: true })
    const { ctx } = await setupReal({ requireWriteApproval: false }, join(globalDirectory, 'config'))
    const result = await call(ctx, { operation: 'fetch', cwd: repo, args: ['origin'] })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected the fetch to reach Git')
    expect(projectionOf(result).exitCode).toBe(0)
    expect((await git(repo, ['rev-parse', 'refs/remotes/origin/main'])).trim()).toBe(expected)
    expect(await maintenanceRuns(trace)).toBe(0)
    expect(await git(repo, ['rev-parse', 'refs/heads/keep-local'])).toBe(localBranch)
    expect(await git(repo, ['rev-parse', 'refs/tags/keep-tag'])).toBe(localTag)
    expect(await readFile(join(repo, '.git', 'FETCH_HEAD'), 'utf8')).toBe('sentinel-fetch-head\n')
  })

  it('reports an ext:: remote as a structured Git failure without running the helper', async () => {
    const root = await temporaryDirectory()
    const { marker, program } = await markerProgram(root)
    const repo = await createRepository(root)
    await writeFile(join(repo, 'a.txt'), 'stored\n')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['commit', '--quiet', '-m', 'baseline'])
    await git(repo, ['remote', 'add', 'evil', `ext::sh -c ${shellQuote(process.execPath)}+${shellQuote(program)}`])
    const { ctx } = await setupReal({ requireWriteApproval: false })
    const result = await call(ctx, { operation: 'fetch', cwd: repo, args: ['evil'] })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a structured Git result')
    expect(projectionOf(result).exitCode).not.toBe(0)
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
