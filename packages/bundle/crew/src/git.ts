/**
 * Crew commander's structured Git tool. The model selects one fixed Git
 * operation and literal argv values; no shell parses the request. Mutating
 * operations use the shared approval pipeline before a process starts.
 * @module @deepseek-ai/dsh-crew/git
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'crew-git'
/** Services required by the structured Git tool. */
export const inject = ['tools', 'subprocess', 'workingDirectory', 'sandbox', 'sandboxPolicy']

/** Runtime configuration for the Crew Git tool. */
export interface Config {
  /** Cooperative execution budget in milliseconds, enforced when the shared tool-timeout policy is mounted. */
  timeoutMs?: number
  /** Maximum retained UTF-8 bytes per output stream. */
  maxOutputBytes?: number
  /** Managed-process termination grace in milliseconds. */
  graceMs?: number
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  maxOutputBytes: z.number().step(1).min(1).default(256 * 1024),
  graceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(3_000),
})

const READ_OPERATIONS = ['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse'] as const
const WRITE_OPERATIONS = ['checkout', 'reset', 'restore', 'stash', 'clean', 'commit', 'push', 'rebase', 'merge', 'switch'] as const
const OPERATIONS = [...READ_OPERATIONS, ...WRITE_OPERATIONS] as const
type Operation = (typeof OPERATIONS)[number]

/** Disable repository-selected processes, prompts, lazy fetches, and inherited repository selectors. */
const GIT_PREFIX = [
  '--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never',
] as const
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries([
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
    'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
    'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
  ].map(key => [key, undefined])),
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  // stdin is closed, so an editor prompt would block until the timeout; refuse instead.
  GIT_EDITOR: 'true',
  LC_ALL: 'C',
}

/** Options accepted for each operation. Prefixes ending in `=` accept a value. */
const ALLOWED_OPTIONS: Readonly<Record<Operation, readonly string[]>> = {
  status: ['--short', '--branch', '--porcelain', '--porcelain=v1', '--porcelain=v2', '-sb', '--untracked-files=all', '--untracked-files=normal', '--untracked-files=no'],
  diff: ['--stat', '--cached', '--staged', '--name-only', '--name-status', '--check', '--exit-code'],
  log: ['--oneline', '--decorate', '--stat', '--graph', '--all', '--max-count=', '-n', '--format='],
  show: ['--stat', '--name-only', '--name-status', '--format='],
  'ls-files': ['--cached', '--deleted', '--modified', '--others', '--exclude-standard', '--stage'],
  'rev-parse': ['--show-toplevel', '--git-dir', '--abbrev-ref', '--short', '--verify', '--quiet'],
  checkout: ['-b', '-B', '--detach', '--force'],
  reset: ['--soft', '--mixed', '--hard', '--keep', '--merge'],
  restore: ['--staged', '--worktree', '--source='],
  stash: ['--include-untracked', '--all', '--keep-index', '--staged', '--message='],
  clean: ['-n', '--dry-run', '-f', '--force', '-d', '-x', '-X', '-fd', '-fx', '-fdx', '-ff'],
  commit: ['-m', '--message', '--message=', '--amend', '--no-edit', '--allow-empty', '--no-verify', '--signoff'],
  push: ['-u', '--set-upstream', '--force-with-lease', '--force-with-lease=', '--force', '--delete', '--dry-run', '--tags', '--no-verify'],
  rebase: ['--continue', '--abort', '--skip', '--onto', '--onto=', '--no-verify'],
  merge: ['--no-ff', '--ff-only', '--squash', '--abort', '--continue', '--no-commit', '--no-edit', '--no-verify', '-m', '--message', '--message='],
  switch: ['-c', '-C', '--create', '--force-create', '--detach', '--force'],
}

/** Stable failures produced before or during a Git operation. */
export class CrewGitError extends HarnessError {}

function operationOf(args: unknown): Operation | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const operation: unknown = Reflect.get(args, 'operation')
  return typeof operation === 'string' && (OPERATIONS as readonly string[]).includes(operation)
    ? operation as Operation
    : undefined
}

/** Validate literal arguments, including the options that could make Git execute another program. */
function validateArguments(operation: Operation, args: readonly string[]): void {
  const allowed = ALLOWED_OPTIONS[operation]
  if (operation === 'push' && args.some(arg => arg.includes('::'))) {
    throw new CrewGitError('crew_git push does not accept external remote-helper addresses', 'CREW_GIT_ARGUMENTS')
  }
  let positionalOnly = false
  for (const arg of args) {
    if (arg.length === 0 || arg.includes('\0')) {
      throw new CrewGitError('crew_git arguments must be non-empty and contain no NUL', 'CREW_GIT_ARGUMENTS')
    }
    if (arg === '--') {
      positionalOnly = true
      continue
    }
    if (positionalOnly || !arg.startsWith('-')) continue
    if (allowed.some(option => arg === option || option.endsWith('=') && arg.startsWith(option))) continue
    throw new CrewGitError(`crew_git does not allow option ${JSON.stringify(arg)} for git ${operation}`, 'CREW_GIT_ARGUMENTS')
  }
}

/**
 * Keys whose value names a program Git then runs without asking: content
 * filters, merge drivers, diff helpers, signing programs, the editor, the
 * transport command, and credential helpers. A checkout writes them into its
 * own `.git/config`, so a read that trusted them would let a repository run
 * commands the model never requested.
 *
 * Only read operations neutralize them. A write keeps the repository's filters
 * and merge drivers because a commit and a checkout rely on them — Git LFS
 * stores pointers and restores content through exactly these — and the approval
 * pipeline already puts a write's intent in front of the user.
 */
const PROGRAM_CONFIG = new RegExp([
  'filter\\..+\\.(?:clean|smudge|process|required)',
  'merge\\..+\\.driver',
  'diff\\..+\\.(?:command|textconv)',
  'diff\\.external',
  'core\\.(?:sshcommand|editor|askpass|gitproxy|pager)',
  'sequence\\.editor',
  'credential\\.(?:.+?\\.)?helper',
  'gpg\\.(?:program|ssh\\.program|x509\\.program)',
  'interactive\\.difffilter',
  'submodule\\..+\\.update',
].map(source => `(?:${source})`).join('|'), 'iu')

/**
 * Turn configured key names into command-local overrides that blank each one.
 * `-c <key>=` outranks every configuration file and leaves the files, the
 * index, and their timestamps untouched.
 * @param keys - configuration key names reported by `git config --list`.
 * @returns the `-c <key>=` pair list for keys whose value names a program.
 */
function programConfigOverrides(keys: readonly string[]): string[] {
  return keys.filter(key => PROGRAM_CONFIG.test(key)).flatMap(key => ['-c', `${key}=`])
}

/** One finished Git process, already collected and released. */
interface GitRun {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: StreamOutput
  stderr: StreamOutput
}

/** One stream's collected text plus the facts a truncated or spilled read must keep. */
interface StreamOutput {
  text: string
  truncated: boolean
  spillPath?: string
}

function outputOf(read: SubprocessOutputRead | undefined, stream: 'stdout' | 'stderr'): StreamOutput {
  if (read === undefined) throw new CrewGitError(`crew_git received no collected ${stream}`, 'CREW_GIT_FAILED')
  return {
    text: read.text,
    truncated: read.lossy,
    ...read.spillPath === undefined ? {} : { spillPath: read.spillPath },
  }
}

/** Install the commander's structured Git tool and its write-operation approval rule.
 * @param ctx - Crew preset context owning the tool and approval registrations.
 * @param config - Execution budgets; omitted fields use the validated defaults.
 * @returns after both registrations are active.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = Config(config) as Required<Config>
  const writes = new Set<string>(WRITE_OPERATIONS)

  /** Run one Git process to completion and release its process range before returning. */
  async function runGit(argv: readonly string[], cwd: string, signal: AbortSignal, label: string): Promise<GitRun> {
    let handle: SubprocessHandle
    try {
      handle = ctx.subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: resolved.maxOutputBytes },
          stderr: { maxBytes: resolved.maxOutputBytes },
        },
        graceMs: resolved.graceMs,
        signal,
        env: { ...GIT_ENV },
      } satisfies SubprocessSpawnSpec)
    } catch (error: unknown) {
      if (signal.aborted) throw new CrewGitError('crew_git was aborted before Git started', 'CREW_GIT_ABORTED', { cause: error })
      throw new CrewGitError(`crew_git could not start git ${label}`, 'CREW_GIT_START_FAILED', { cause: error })
    }
    try {
      let outcome
      try {
        outcome = await handle.done
      } catch (error: unknown) {
        throw new CrewGitError(`crew_git git ${label} failed before reporting an outcome`, 'CREW_GIT_FAILED', { cause: error })
      }
      if (signal.aborted) throw new CrewGitError('crew_git was aborted before completion', 'CREW_GIT_ABORTED')
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: outputOf(handle.collected.stdout?.readFrom(0), 'stdout'),
        stderr: outputOf(handle.collected.stderr?.readFrom(0), 'stderr'),
      }
    } finally {
      handle.terminate()
      await handle.waitForExit()
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'crew_git') return next()
    const operation = operationOf(exec.arguments)
    if (operation === undefined || !writes.has(operation)) return next()
    return {
      kind: 'ask',
      reason: `Crew requests git ${operation}. This changes repository or remote state; approve only after reviewing its arguments.`,
    }
  })
  ctx.tools.register(defineTool({
    name: 'crew_git',
    description: 'Run one allowlisted Git operation directly with literal arguments, without a shell. Use for Crew commander Git reads and approved Git writes. Shell expansion and command-execution options are not available.',
    timeoutMs: resolved.timeoutMs,
    parameters: {
      operation: { type: 'string', required: true, enum: OPERATIONS, description: 'Git subcommand to run.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Literal arguments after the subcommand. Options are allowlisted per operation; use -- before path-only arguments.' },
      cwd: { type: 'string', description: 'Absolute repository directory. Omit to use the current session working directory.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          operation: { type: 'string', required: true },
          cwd: { type: 'string', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          stdout: { type: 'object', required: true, additionalProperties: false, properties: {
            text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true }, spillPath: { type: 'string' },
          } },
          stderr: { type: 'object', required: true, additionalProperties: false, properties: {
            text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true }, spillPath: { type: 'string' },
          } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `git ${value.operation} exited with ${value.exitCode ?? `signal ${value.signal ?? 'unknown'}`}\n${value.stdout.text}${value.stderr.text}`,
      }],
    },
    isConcurrencySafe: args => !writes.has(args.operation),
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new CrewGitError('crew_git requires a calling agent', 'CREW_GIT_AGENT_REQUIRED')
      validateArguments(args.operation, args.args ?? [])
      if (args.cwd !== undefined && !isAbsolute(args.cwd)) {
        throw new CrewGitError('crew_git cwd must be absolute', 'CREW_GIT_ARGUMENTS')
      }
      const cwd = args.cwd ?? await ctx.workingDirectory.ensure(agent, exec.signal)
      const safeReadOptions = ['diff', 'log', 'show'].includes(args.operation) ? ['--no-ext-diff', '--no-textconv'] : []
      const program = await ctx.subprocess.resolveExecutable('git', undefined, exec.signal)
      const policy: SandboxExecutionPolicy = ctx.sandboxPolicy.resolve({ session: agent.session })
      const confine = async (command: readonly string[]): Promise<readonly string[]> => policy.mode === 'danger-full-access'
        ? command
        : (await ctx.sandbox.confine(command, { ...policy, mode: policy.mode }, exec.signal)).argv
      // A read must not let the checkout choose a program. Enumerate the keys Git
      // resolves here, then blank every one that names an executable for this call.
      let overrides: string[] = []
      if (!writes.has(args.operation)) {
        const listing = await runGit(
          await confine([program, ...GIT_PREFIX, 'config', '--null', '--name-only', '--list']),
          cwd, exec.signal, 'config',
        )
        if (listing.exitCode !== 0) {
          throw new CrewGitError(`crew_git could not read the Git configuration of ${cwd}`, 'CREW_GIT_CONFIG_UNREADABLE')
        }
        overrides = programConfigOverrides(listing.stdout.text.split('\0').filter(name => name.length > 0))
      }
      const argv = await confine([program, ...GIT_PREFIX, ...overrides, args.operation, ...safeReadOptions, ...args.args ?? []])
      const run = await runGit(argv, cwd, exec.signal, args.operation)
      return {
        operation: args.operation,
        cwd,
        exitCode: run.exitCode,
        signal: run.signal,
        stdout: run.stdout,
        stderr: run.stderr,
      }
    },
  }))
}
