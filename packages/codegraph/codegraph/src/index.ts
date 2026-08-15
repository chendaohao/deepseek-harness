/**
 * CodeGraph integration plugin: for sessions whose workspace carries a
 * `.codegraph/` index, fold the CodeGraph checklist into the first pre-step
 * batch and lazily start one codegraph MCP server (`codegraph serve --mcp`)
 * whose tools are registered as `mcp__codegraph__*`. Workspaces without an
 * index get neither the instructions nor a server.
 *
 * The connection is global, not per-session: DSH's mcp-client sends no
 * rootUri, so the server has no default project and agents pass
 * `projectPath` per call (the injected checklist says so). The server is
 * spawned lazily on the first indexed pre-step and stays up until this
 * plugin disposes.
 *
 * @module @deepseek-ai/dsh-codegraph
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { StdioConfig } from '@deepseek-ai/dsh-mcp-client'
import {
  resolveReconnectPolicy,
  startConnection,
  type ConnectionHandle,
} from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { codegraphChecklistFrame } from './checklist.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'codegraph'

/**
 * No inject declaration: the codegraph MCP connection is started lazily on
 * the first indexed pre-step, by which point the tool registry is mounted in
 * every real deployment (and the checklist folding touches no service at
 * all). An inject list would defer apply until the tools service is provided,
 * which silently skips the plugin in bare-context tests.
 */

/** Default per-tool-call timeout for codegraph MCP tools (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 120_000

/** Default codegraph CLI executable. */
const DEFAULT_COMMAND = 'codegraph'

/** Source kind of the injected checklist message (owned by this plugin). */
export const INSTRUCTION_SOURCE_KIND = 'codegraph-instructions'

/** Durable source facts for the injected checklist message. */
export interface CodegraphInstructionSource {
  kind: 'codegraph-instructions'
  /** The checklist is a one-shot instruction context, not a file-backed baseline. */
  form: 'instructions'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'codegraph-instructions': CodegraphInstructionSource
  }
}

/** Configuration for one codegraph MCP server and the scoped checklist. */
export interface Config {
  /** codegraph CLI executable (default 'codegraph'). */
  command?: string
  /** Extra CLI args appended after `serve --mcp` (default []). */
  args?: string[]
  /** Per-tool-call timeout in ms (default 120000). */
  toolCallTimeoutMs?: number
  /** Set false to disable the plugin entirely (default true). */
  enabled?: boolean
}

export const Config = z.object({
  command: z.string().default(DEFAULT_COMMAND),
  args: z.array(String).default([]),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  enabled: z.boolean().default(true),
}) as unknown as z<Config>

interface ResolvedConfig {
  command: string
  args: string[]
  toolCallTimeoutMs: number
}

function resolveConfig(config: Config): ResolvedConfig {
  return {
    command: config.command ?? DEFAULT_COMMAND,
    args: config.args ?? [],
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
  }
}

async function hasCodegraphIndex(cwd: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  try {
    const info = await stat(join(cwd, '.codegraph'))
    signal?.throwIfAborted()
    return info.isDirectory()
  } catch (error) {
    if (signal !== undefined && signal.aborted) throw error
    return false
  }
}

/** The checklist message already visible in this agent session's history, if any. */
function visibleChecklist(agent: Agent): UserMessage | undefined {
  for (const seq of agent.session.surface.nodes.toReversed()) {
    const event = agent.session.events[seq]
    if (event?.type === 'user/message'
      && event.data.source.kind === INSTRUCTION_SOURCE_KIND) return event.data
  }
  return undefined
}

function checklistMessage(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: codegraphChecklistFrame() }],
    source: {
      kind: INSTRUCTION_SOURCE_KIND,
      form: 'instructions',
    },
  })
}

function samePayload(left: UserMessage, right: UserMessage): boolean {
  return isDeepStrictEqual(left.content, right.content)
    && isDeepStrictEqual(left.source, right.source)
}

/**
 * Mount the codegraph integration.
 * @param ctx - Cordis context carrying the tool registry and agent loop.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return
  const resolved = resolveConfig(config)

  let connection: ConnectionHandle | undefined

  const ensureConnection = (): void => {
    if (connection !== undefined) return
    const stdioConfig: StdioConfig = {
      transport: 'stdio',
      serverName: 'codegraph',
      command: resolved.command,
      args: ['serve', '--mcp', ...resolved.args],
      env: {},
      cwd: '',
      toolCallTimeoutMs: resolved.toolCallTimeoutMs,
      failOnStartupError: false,
    }
    const handle = startConnection(ctx, stdioConfig, resolveReconnectPolicy(undefined, 'codegraph'))
    connection = handle
    void handle.ready.then((outcome: { error?: unknown }) => {
      if (outcome.error !== undefined) {
        ctx.logger.warn('codegraph: MCP connection failed (%o); agents fall back to the codegraph CLI', outcome.error)
      }
    }).catch((error: unknown) => {
      ctx.logger.warn('codegraph: MCP connection error (%o); agents fall back to the codegraph CLI', error)
    })
  }

  ctx.effect(() => () => {
    const current = connection
    connection = undefined
    if (current !== undefined) void current.dispose()
  }, 'codegraph.connection')

  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    const cwd = agent.session.header.cwd ?? process.cwd()
    const indexed = await hasCodegraphIndex(cwd, signal)
    if (!indexed) return decision
    ensureConnection()
    if (visibleChecklist(agent) !== undefined) return decision
    if (decision.kind !== 'enter') return decision
    const desired = checklistMessage()
    if (decision.messages.some(message => samePayload(message, desired))) return decision
    const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
    return { kind: 'enter', messages: entered }
  })
}
