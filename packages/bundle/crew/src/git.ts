/**
 * Crew commander's structured Git tool. The model selects one fixed Git
 * operation and literal argv values; no shell parses the request. By default,
 * mutating operations use the shared approval pipeline before a process starts.
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
  /**
   * Whether Git mutations require per-operation user approval. Disable only for
   * deployment-authorized unattended commander writes; Session sandbox policy still applies.
   */
  requireWriteApproval?: boolean
  /** Cooperative execution budget in milliseconds, enforced when the shared tool-timeout policy is mounted. */
  timeoutMs?: number
  /** Maximum retained UTF-8 bytes per output stream. */
  maxOutputBytes?: number
  /** Managed-process termination grace in milliseconds. */
  graceMs?: number
}

export const Config: z<Config> = z.object({
  requireWriteApproval: z.boolean().default(true),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  maxOutputBytes: z.number().step(1).min(1).default(256 * 1024),
  graceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(3_000),
})

const READ_OPERATIONS = ['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse', 'rev-list'] as const
const WRITE_OPERATIONS = ['checkout', 'reset', 'restore', 'stash', 'clean', 'commit', 'push', 'rebase', 'merge', 'switch', 'fetch'] as const
const OPERATIONS = [...READ_OPERATIONS, 'branch', ...WRITE_OPERATIONS] as const
type Operation = (typeof OPERATIONS)[number]
const WRITE_OPERATION_SET: ReadonlySet<Operation> = new Set<Operation>(WRITE_OPERATIONS)

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
    // Trace variables accept absolute output paths; reads must not append files.
    'GIT_TRACE', 'GIT_TRACE_FSMONITOR', 'GIT_TRACE_PACK_ACCESS', 'GIT_TRACE_PACKET', 'GIT_TRACE_PACKFILE',
    'GIT_TRACE_PERFORMANCE', 'GIT_TRACE_REFS', 'GIT_TRACE_SETUP', 'GIT_TRACE_SHALLOW', 'GIT_TRACE_CURL',
    'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF',
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
  diff: ['--stat', '--cached', '--staged', '--name-only', '--name-status', '--check', '--exit-code', '--numstat'],
  log: ['--oneline', '--decorate', '--stat', '--graph', '--all', '--max-count=', '-n', '--format=', '-v', '--no-merges', '--numstat', '--first-parent'],
  show: ['--stat', '--name-only', '--name-status', '--format=', '--numstat'],
  'ls-files': ['--cached', '--deleted', '--modified', '--others', '--exclude-standard', '--stage'],
  'rev-parse': ['--show-toplevel', '--git-dir', '--abbrev-ref', '--short', '--verify', '--quiet'],
  // `--numstat` and `--stat` do not exist on rev-list; counting is what it adds.
  'rev-list': ['--count', '--left-right', '--no-merges', '--first-parent'],
  // `branch` parses its own two forms; the table entry documents the query allowlist.
  branch: ['--list', '--all', '-a', '--remotes', '-r', '--show-current', '--verbose', '-v', '--contains=', '--no-contains=', '--merged=', '--no-merged=', '--points-at=', '--format=', '--sort='],
  // `fetch` parses its own form and generates the fixed argv; the entry names the user-facing options.
  fetch: ['--dry-run', '--prune', '--no-prune'],
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

/** Whether a log/show format requests signature verification, excluding an escaped `%%`. */
function signatureFormat(arg: string): boolean {
  if (!arg.startsWith('--format=')) return false
  const format = arg.slice('--format='.length)
  for (let index = 0; index < format.length - 1; index++) {
    if (format[index] !== '%') continue
    if (format[index + 1] === '%') index++
    else if (format[index + 1] === 'G') return true
  }
  return false
}

/** Whether `arg` matches one entry of an operation's allowlist. */
function allowedOption(allowed: readonly string[], arg: string): boolean {
  return allowed.some(option => arg === option || option.endsWith('=') && arg.startsWith(option))
}

/** Whether `arg` is a decimal commit limit, which Git reads only on log and rev-list. */
function decimalCommitLimit(operation: Operation, arg: string): boolean {
  return (operation === 'log' || operation === 'rev-list') && /^-[0-9]+$/.test(arg)
}

/** Render an operation's static allowlist for a diagnostic. */
function describeOptions(operation: Operation): string {
  const options = ALLOWED_OPTIONS[operation].map(option => option.endsWith('=') ? `${option}<value>` : option)
  if (operation === 'log' || operation === 'rev-list') options.push('-N (decimal commit limit)')
  return options.join(', ')
}

/** Reject one option with the alternative that reaches the same result, when one exists. */
function rejectOption(operation: Operation, arg: string): never {
  const alternative = operation === 'log' && arg === '--count'
    ? ' Use rev-list --count for a commit count; git log silently ignores --count.'
    : operation === 'rev-list' && (arg === '--numstat' || arg === '--stat')
      ? ' Use log --numstat --first-parent for merge-introduced changes, or diff/show --numstat.'
      : arg === '--verbose'
        ? ' Git accepts -v on log and show and rejects --verbose.'
        : ''
  throw new CrewGitError(
    `crew_git does not allow option ${JSON.stringify(arg)} for git ${operation}.${alternative} Accepted: ${describeOptions(operation)}.`,
    'CREW_GIT_ARGUMENTS',
  )
}

/** Validate literal arguments, including the options that could make Git execute another program. */
function validateLiteralArguments(operation: Operation, args: readonly string[]): void {
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
    if (positionalOnly || !arg.startsWith('-') || decimalCommitLimit(operation, arg)) continue
    if (!allowedOption(allowed, arg)) rejectOption(operation, arg)
    if ((operation === 'log' || operation === 'show') && signatureFormat(arg)) {
      throw new CrewGitError('crew_git read formats cannot request signature verification', 'CREW_GIT_ARGUMENTS')
    }
  }
}

/**
 * One `branch` call: an allowlisted query, or a creation whose tracking flag the
 * tool owns. Deletion, rename, copy, force, and upstream edits have no form.
 */
type BranchForm =
  | { readonly kind: 'query' }
  | { readonly kind: 'create'; readonly names: readonly string[] }
  | { readonly kind: 'invalid' }

/**
 * Classify `branch` arguments without throwing, so approval can fail closed on
 * input that the executing validator will later reject.
 * @param args - literal arguments after `branch`.
 * @returns the form this argv expresses, or `invalid`.
 */
function branchForm(args: readonly string[]): BranchForm {
  const options: string[] = []
  const positionals: string[] = []
  for (const arg of args) {
    if (arg.length === 0 || arg.includes('\0') || arg === '--') return { kind: 'invalid' }
    if (!arg.startsWith('-')) {
      positionals.push(arg)
      continue
    }
    if (!allowedOption(ALLOWED_OPTIONS.branch, arg)) return { kind: 'invalid' }
    options.push(arg)
  }
  if (options.length === 0) {
    if (positionals.length === 0) return { kind: 'query' }
    return positionals.length === 1 || positionals.length === 2 ? { kind: 'create', names: positionals } : { kind: 'invalid' }
  }
  if (options.includes('--show-current')) return options.length === 1 && positionals.length === 0 ? { kind: 'query' } : { kind: 'invalid' }
  // Without --list, a positional names a branch to create; the query forms never take one.
  if (options.includes('--list')) return { kind: 'query' }
  return positionals.length === 0 ? { kind: 'query' } : { kind: 'invalid' }
}

/** The single accepted `fetch` form; the tool supplies every other argument. */
const FETCH_FORM = 'fetch [--dry-run] [--prune | --no-prune] <remote>'

/** Remote names whose generated refspec component cannot escape `refs/remotes/`. */
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/**
 * Build the one `fetch` argv this tool runs. The caller names a remote and two
 * booleans; refspec, tag, FETCH_HEAD, maintenance, and upload-pack behavior are
 * fixed here so repository configuration cannot redirect them.
 * @param args - literal arguments after `fetch`.
 * @returns the operation name followed by the complete safe argument list.
 */
function fetchInvocation(args: readonly string[]): readonly string[] {
  const reject = (detail: string): never => {
    throw new CrewGitError(
      `crew_git does not accept ${JSON.stringify(args)} for git fetch: ${detail}. `
      + `Accepted form: ${FETCH_FORM}, where the remote is one name matching ${REMOTE_NAME.source}. `
      + 'URLs and refspecs are not accepted; the tool supplies the fixed refspec and safety options.',
      'CREW_GIT_ARGUMENTS',
    )
  }
  let dryRun = false
  let prune: '--prune' | '--no-prune' | undefined
  const positionals: string[] = []
  for (const arg of args) {
    if (arg.length === 0 || arg.includes('\0') || arg === '--') reject('arguments must be non-empty and contain no NUL, and -- is not accepted')
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--prune' || arg === '--no-prune') {
      if (prune !== undefined && prune !== arg) reject('--prune and --no-prune are mutually exclusive')
      prune = arg
    } else if (arg.startsWith('-')) reject(`${JSON.stringify(arg)} is not an accepted option`)
    else positionals.push(arg)
  }
  if (positionals.length !== 1) reject('requires exactly one named remote')
  const remote = positionals[0] as string
  if (!REMOTE_NAME.test(remote)) reject(`remote ${JSON.stringify(remote)} must match ${REMOTE_NAME.source}`)
  return [
    'fetch', prune ?? '--no-prune',
    '--no-tags', '--no-prune-tags', '--no-write-fetch-head', '--no-auto-gc',
    '--upload-pack=git-upload-pack', '--refmap=',
    ...dryRun ? ['--dry-run'] : [],
    remote, `+refs/heads/*:refs/remotes/${remote}/*`,
  ]
}

/**
 * Validate one call and derive the argv that follows `git`.
 * @param operation - the selected subcommand.
 * @param args - literal arguments the model supplied.
 * @returns the subcommand plus every argument, including tool-injected ones.
 */
function invocationOf(operation: Operation, args: readonly string[]): readonly string[] {
  if (operation === 'fetch') return fetchInvocation(args)
  if (operation === 'branch') {
    const form = branchForm(args)
    if (form.kind === 'query') return ['branch', ...args]
    if (form.kind === 'create') return ['branch', '--no-track', ...form.names]
    throw new CrewGitError(
      `crew_git does not accept ${JSON.stringify(args)} for git branch. Accepted forms: an allowlisted query `
      + `(${describeOptions('branch')}), for example branch --list 'topic/*' or branch --show-current, and `
      + 'branch <new-branch> [<start-point>]; the tool always passes --no-track. '
      + 'Delete, rename, copy, force, and upstream options are not supported.',
      'CREW_GIT_ARGUMENTS',
    )
  }
  validateLiteralArguments(operation, args)
  return [operation, ...args]
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
  'gpg\\.(?:[^.]+\\.)?(?:program|defaultkeycommand)',
  'interactive\\.difffilter',
  'submodule\\..+\\.update',
].map(source => `(?:${source})`).join('|'), 'iu')

/**
 * Turn configured key names into command-local environment overrides. Separate
 * key and value slots preserve subsection names containing `=`; unlike `-c`,
 * Git does not have to split the key from its value first. Reads also disable
 * configured signature verification and replace the repository's pretty format,
 * either of which can otherwise start a signature program.
 * @param keys - configuration key names reported by `git config --list`.
 * @returns environment entries carrying empty program values and safe read formatting.
 */
function readConfigEnvironment(keys: readonly string[]): NodeJS.ProcessEnv {
  const entries: (readonly [string, string])[] = keys.filter(key => PROGRAM_CONFIG.test(key)).map(key => [key, ''] as const)
  entries.push(['log.showSignature', 'false'], ['format.pretty', 'medium'])
  return {
    GIT_CONFIG_COUNT: String(entries.length),
    ...Object.fromEntries(entries.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ])),
  }
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

/** Read literal arguments from raw tool input; a non-string entry makes the input ambiguous. */
function rawArgsOf(raw: unknown): readonly string[] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value: unknown = Reflect.get(raw, 'args')
  if (value === undefined) return []
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')
    ? value
    : undefined
}

/**
 * Whether one call mutates repository or remote state. Unknown or ambiguous
 * input counts as a write so approval is requested before anything spawns;
 * only a permanent read, or a `branch` query in its allowlisted form, does not.
 * @param operation - the subcommand, when the input names a known one.
 * @param args - literal arguments, when every entry is a string.
 * @returns whether the call must pass the write-approval rule.
 */
function mutatingCall(operation: Operation | undefined, args: readonly string[] | undefined): boolean {
  if (operation === undefined || args === undefined) return true
  if (WRITE_OPERATION_SET.has(operation)) return true
  return operation === 'branch' && branchForm(args).kind !== 'query'
}

/** Install the commander's structured Git tool and its configurable write-operation approval rule.
 * @param ctx - Crew preset context owning the tool and approval registrations.
 * @param config - Tool settings; omitted fields use the validated defaults.
 * @returns after both registrations are active.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = Config(config) as Required<Config>

  /** Run one Git process to completion and release its process range before returning.
   * Reads supply command-local program/signature overrides; writes leave `configEnv` empty.
   */
  async function runGit(
    argv: readonly string[], cwd: string, signal: AbortSignal, label: string,
    configEnv: Readonly<NodeJS.ProcessEnv> = {},
  ): Promise<GitRun> {
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
        env: { ...GIT_ENV, ...configEnv },
      } satisfies SubprocessSpawnSpec)
    } catch (error: unknown) {
      if (signal.aborted) throw new CrewGitError('crew_git was aborted before Git started', 'CREW_GIT_ABORTED', { cause: error })
      throw new CrewGitError(`crew_git could not start git ${label}`, 'CREW_GIT_START_FAILED', { cause: error })
    }
    let failure: { error: unknown } | undefined
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
    } catch (error: unknown) {
      failure = { error }
    } finally {
      handle.terminate()
      try {
        await handle.waitForExit()
      } catch (cleanupError: unknown) {
        if (failure === undefined) {
          throw new CrewGitError(`crew_git could not confirm that git ${label} stopped`, 'CREW_GIT_FAILED', { cause: cleanupError })
        }
        /* v8 ignore else -- every expected operation failure above already has a CrewGitError code. */
        if (failure.error instanceof CrewGitError) {
          throw new CrewGitError(failure.error.message, failure.error.code, {
            cause: new AggregateError([failure.error, cleanupError]),
          })
        }
        /* v8 ignore next -- Unexpected non-Harness defects have no stable tool error code to preserve. */
        throw new AggregateError([failure.error, cleanupError], `crew_git git ${label} and its cleanup both failed`)
      }
    }
    throw failure.error
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'crew_git') return next()
    const operation = operationOf(exec.arguments)
    if (!resolved.requireWriteApproval || !mutatingCall(operation, rawArgsOf(exec.arguments))) return next()
    const label = operation ?? 'an unrecognized operation'
    return {
      kind: 'ask',
      reason: `Crew requests git ${label}. This changes repository or remote state; approve only after reviewing its arguments.`,
    }
  })
  ctx.tools.register(defineTool({
    name: 'crew_git',
    description: 'Run one allowlisted Git operation directly with literal arguments, without a shell. Use for Crew commander Git reads and approved Git writes. Shell expansion and command-execution options are not available. A Git non-zero exit is returned with exitCode, stdout, and stderr; validation, launch, cancellation, and cleanup failures remain tool errors.',
    timeoutMs: resolved.timeoutMs,
    parameters: {
      operation: { type: 'string', required: true, enum: OPERATIONS, description: 'Git subcommand to run. Rev-list and branch queries are reads; branch creation and every fetch are writes.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Literal arguments after the subcommand. Options are allowlisted per operation; log and rev-list also accept -N as a decimal commit limit. Use rev-list --count for counts and log --numstat --first-parent for merge-introduced changes. Fetch requires one named remote and no URL or refspec; the tool supplies fixed refspec and safety options. Branch accepts an allowlisted query or a new branch name with an optional start point and always uses --no-track. Use -- before path-only arguments.' },
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
    isConcurrencySafe: args => !mutatingCall(operationOf(args), rawArgsOf(args)),
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new CrewGitError('crew_git requires a calling agent', 'CREW_GIT_AGENT_REQUIRED')
      const operation = args.operation
      const invocation = invocationOf(operation, args.args ?? [])
      const write = mutatingCall(operation, args.args ?? [])
      if (args.cwd !== undefined && !isAbsolute(args.cwd)) {
        throw new CrewGitError('crew_git cwd must be absolute', 'CREW_GIT_ARGUMENTS')
      }
      const cwd = args.cwd ?? await ctx.workingDirectory.ensure(agent, exec.signal)
      const safeReadOptions = ['diff', 'log', 'show'].includes(operation) ? ['--no-ext-diff', '--no-textconv'] : []
      const program = await ctx.subprocess.resolveExecutable('git', undefined, exec.signal)
      const policy: SandboxExecutionPolicy = ctx.sandboxPolicy.resolve({ session: agent.session })
      const confine = async (command: readonly string[]): Promise<readonly string[]> => policy.mode === 'danger-full-access'
        ? command
        : (await ctx.sandbox.confine(command, { ...policy, mode: policy.mode }, exec.signal)).argv
      // A read must not let the checkout choose a program. Enumerate the keys Git
      // resolves here, then blank every one that names an executable for this call.
      let configEnv: Readonly<NodeJS.ProcessEnv> = {}
      if (!write) {
        const listing = await runGit(
          await confine([program, ...GIT_PREFIX, 'config', '--null', '--name-only', '--list']),
          cwd, exec.signal, 'config',
        )
        if (listing.exitCode !== 0 || listing.stdout.truncated) {
          throw new CrewGitError(`crew_git could not read the complete Git configuration of ${cwd}`, 'CREW_GIT_CONFIG_UNREADABLE')
        }
        configEnv = readConfigEnvironment(listing.stdout.text.split('\0').filter(name => name.length > 0))
      }
      const argv = await confine([program, ...GIT_PREFIX, invocation[0] as string, ...safeReadOptions, ...invocation.slice(1)])
      const run = await runGit(argv, cwd, exec.signal, invocation[0] as string, configEnv)
      return {
        operation,
        cwd,
        exitCode: run.exitCode,
        signal: run.signal,
        stdout: run.stdout,
        stderr: run.stderr,
      }
    },
  }))
}
