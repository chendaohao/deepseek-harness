/**
 * Compile-command serialization guard. Several workers in one deployment share
 * a checkout, so two concurrent install, build, typecheck, or coverage commands
 * overwrite each other's `node_modules`, `lib/`, `dist/`, and `.tsbuildinfo`
 * artifacts. The guard admits one compile-class command at a time through
 * `ctx.tools.guard()` and denies every later one with a retryable message
 * naming what is running.
 *
 * The guard is synchronous, so it denies rather than queues; the in-flight
 * registration is a process-global table keyed by `Symbol.for` so two copies of
 * this package loaded in one process share it. Configuration lives in the
 * package README.
 * @module @deepseek-ai/dsh-compile-serialization
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'compile-serialization'

/** The tool registry whose monotonic guard stage this plugin registers into. */
export const inject = ['tools']

/**
 * Plugin configuration. Every field is deployment-varying and validated at
 * load: an uncompilable pattern, an empty pattern or tool list, or a
 * non-positive cap throws instead of degrading to an unguarded deployment.
 */
export interface Config {
  /**
   * Regular-expression sources matched against a command's text. A command that
   * matches any entry is compile-class and participates in serialization. The
   * defaults cover package-manager installs, `build`/`typecheck`/coverage
   * scripts, a `tsc --build` project build, a coverage run under vitest or jest,
   * and the common bundlers — every one of them writes shared build output.
   */
  commandPatterns?: string[]
  /**
   * Tool names whose `command` argument is inspected. Commands arrive as parsed
   * JSON, so a tool with no string `command` argument is never compile-class.
   */
  toolNames?: string[]
  /**
   * Maximum characters of the in-flight command quoted in the denial (default
   * 120). Bounds only the model-visible message; matching always reads the
   * complete command text.
   */
  commandPreviewChars?: number
  /**
   * Age in milliseconds after which a still-registered command counts as leaked
   * and the next compile-class call may take the slot (default 3600000, one
   * hour). This is a leak valve for a registration whose execution never
   * reported its outcome, not a work limit: a build that legitimately runs
   * longer than this would be preempted, so raise it when a single command can.
   * A registration whose caller signal aborts is reclaimable immediately.
   */
  leaseTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  commandPatterns: z.array(z.string()).default([
    // Installs mutate the shared content-addressable store and node_modules.
    String.raw`\b(?:pnpm|npm|yarn|bun)\s+(?:install|i|ci|add|remove|update|dedupe|prune)\b`,
    // Package-manager scripts that emit lib/, dist/, or coverage output.
    String.raw`\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|test:coverage|coverage)\b`,
    // A direct TypeScript project build writes .tsbuildinfo beside its output.
    String.raw`\btsc\b[^\n]*(?:-b|--build)\b`,
    String.raw`\b(?:vitest|jest)\b[^\n]*--coverage\b`,
    // Bundlers that own an output directory.
    String.raw`\b(?:vite|tsdown|webpack|rollup|esbuild)\s+build\b`,
  ]),
  toolNames: z.array(z.string()).default(['bash', 'pwsh']),
  commandPreviewChars: z.number().step(1).min(1).default(120),
  leaseTimeoutMs: z.number().step(1).min(1).default(3_600_000),
})

/**
 * Global-registry key of the in-flight table. A process may hold two copies of
 * this package — a built `lib/` bundle and `src/` — and each would otherwise
 * keep its own registration table, so both would admit a command and the
 * serialization would not hold. `Symbol.for` gives every copy one key.
 */
const IN_FLIGHT_KEY = Symbol.for('dsh.guard.compile-serialization.in-flight')

/** One admitted compile-class command that has not reported its outcome yet. */
interface InFlightCommand {
  /** Execution identity of the admitted call; the release match is exact. */
  readonly token: ToolExecutionToken
  /** Plugin instance that admitted it, so only that instance clears it on disposal. */
  readonly owner: symbol
  /** Tool the command arrived through. */
  readonly toolName: string
  /** Complete command text, kept for the staleness-free release and previews. */
  readonly command: string
  /** Owning agent id, absent for a caller that reached the registry directly. */
  readonly agentId: string | undefined
  /** Caller signal, so a cancelled command is reclaimable at once. */
  readonly signal: AbortSignal
  /** Admission time, read by the leak valve. */
  readonly startedAt: number
}

/** Process-wide slot holding the one admitted command, shared across copies. */
interface InFlightTable {
  current: InFlightCommand | undefined
}

/**
 * Read the process-global in-flight table, creating it on first use. The
 * stored value is checked rather than trusted: the key is process-global, so
 * unrelated code could have written it.
 * @returns The shared table.
 */
function inFlight(): InFlightTable {
  const key = IN_FLIGHT_KEY
  const existing: unknown = Reflect.get(globalThis, key)
  if (isInFlightTable(existing)) return existing
  const created: InFlightTable = { current: undefined }
  Reflect.set(globalThis, key, created)
  return created
}

/**
 * Test a value for the in-flight table's two-field form.
 * @param value - Candidate read from the global key.
 * @returns Whether the value is a usable table.
 */
function isInFlightTable(value: unknown): value is InFlightTable {
  return typeof value === 'object' && value !== null && 'current' in value
}

/**
 * Read the command text out of a call's parsed arguments. Arguments are a JSON
 * boundary, so the string is validated rather than assumed.
 * @param args - Parsed, frozen call arguments.
 * @returns The command, or `undefined` when the call carries none.
 */
function commandOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const command: unknown = Reflect.get(args, 'command')
  return typeof command === 'string' && command.length > 0 ? command : undefined
}

/**
 * Compile one configured pattern, failing loud on an unusable source.
 * @param source - Regular-expression source from the configuration.
 * @returns The compiled expression.
 * @throws {Error} When the source is empty or not a valid expression.
 */
function compilePattern(source: string): RegExp {
  if (source.length === 0) {
    throw new Error('compile-serialization: `commandPatterns` must not contain an empty pattern')
  }
  try {
    return new RegExp(source)
  } catch (error: unknown) {
    throw new Error(`compile-serialization: invalid commandPatterns entry ${JSON.stringify(source)}`, { cause: error })
  }
}

/**
 * Head-truncate a command for the model-visible denial, marking the omission.
 * @param command - Complete command text.
 * @param cap - Configured character cap.
 * @returns The quoted preview.
 */
function previewCommand(command: string, cap: number): string {
  return command.length <= cap ? command : `${command.slice(0, cap)}… (+${command.length - cap} more chars)`
}

/**
 * The model-facing denial. It names the running command, who runs it, and how
 * long it has run, so the model can decide to wait and retry rather than
 * conclude the deployment is broken.
 * @param held - The command currently holding the slot.
 * @param elapsedMs - How long the holding command has been in flight.
 * @param previewChars - Configured preview cap.
 * @returns The denial reason returned to the tool registry.
 */
function denialReason(held: InFlightCommand, elapsedMs: number, previewChars: number): string {
  const who = held.agentId === undefined ? 'an agent-less caller' : `session ${held.agentId}`
  const elapsed = Math.max(0, Math.round(elapsedMs / 1000))
  return 'another compile-class command is still running: '
    + `${held.toolName} in ${who} started ${String(elapsed)}s ago: `
    + `"${previewCommand(held.command, previewChars)}". `
    + 'Compile and install commands overwrite the same build output, so they run one at a time; '
    + 'retry this command after that one finishes.'
}

/**
 * Install the guard. It registers one monotonic guard plus the `tools/result`
 * release, and clears any registration it still owns when its fiber disposes.
 * @param ctx - Plugin context; both listeners are scoped to it and disposed with it.
 * @param config - Validated {@link Config}; pattern sources are re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the fields are set after validation.
  const patterns = (config.commandPatterns as string[]).map(compilePattern)
  const toolNames = new Set(config.toolNames as string[])
  if (toolNames.size === 0) {
    throw new Error('compile-serialization: `toolNames` must not be empty — the guard would never apply')
  }
  const commandPreviewChars = config.commandPreviewChars as number
  const leaseTimeoutMs = config.leaseTimeoutMs as number
  const owner = Symbol('dsh.compile-serialization.lease-owner')
  const table = inFlight()

  /** Whether a registration is reclaimable: its caller aborted, or it outlived the leak valve. */
  function reclaimable(held: InFlightCommand, now: number): boolean {
    return held.signal.aborted || now - held.startedAt >= leaseTimeoutMs
  }

  /**
   * Whether a call is compile-class. A non-participating tool, a call with no
   * string command, or a command matching no pattern is left untouched.
   */
  function isCompileCommand(exec: Readonly<ToolExecution>): string | undefined {
    if (!toolNames.has(exec.name)) return undefined
    const command = commandOf(exec.arguments)
    if (command === undefined) return undefined
    return patterns.some(pattern => pattern.test(command)) ? command : undefined
  }

  ctx.tools.guard((exec) => {
    const command = isCompileCommand(exec)
    if (command === undefined) return undefined
    const now = Date.now()
    const held = table.current
    if (held !== undefined && !reclaimable(held, now)) {
      return denialReason(held, now - held.startedAt, commandPreviewChars)
    }
    table.current = {
      token: exec.token,
      owner,
      toolName: exec.name,
      command,
      agentId: exec.agent?.id,
      signal: exec.signal,
      startedAt: now,
    }
    return undefined
  })

  // The release point: every execution that entered the pipeline reaches the
  // authoritative result, including a denial, a tool error, and a cancellation,
  // so the exact admitted token is released on all of them.
  ctx.on('tools/result', (exec) => {
    if (table.current?.token === exec.token) table.current = undefined
  })

  // Disposal must not leak the slot: a registration this instance admitted
  // would otherwise block every later compile-class call until the leak valve.
  ctx.effect(() => () => {
    if (table.current?.owner === owner) table.current = undefined
  }, 'compile-serialization.release()')
}
