/**
 * Model-facing `opencode_usage` tool: queries the OpenCode Go subscription
 * usage (5h rolling, weekly, and monthly windows) through either the bearer
 * api-key endpoint or a cookie-authenticated dashboard scrape. The package owns
 * schemas, credential resolution, and presentation; the query modes live in
 * `query.ts` and `key-source.ts`.
 * @module @deepseek-ai/dsh-tool-opencode-usage
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { OPENCODE_GO_AUTH_PROVIDER_ID, resolveCredentials } from './key-source.ts'
import { DEFAULT_OPENCODE_USAGE_TIMEOUT_MS, queryByApiKey, queryByWeb } from './query.ts'
import type { UsageMode, UsageResult, UsageWindow } from './query.ts'

export { opencodeAuthPath, readOpencodeAuthApiKey, resolveCredentials } from './key-source.ts'
export type { OpencodeGoCredentials } from './key-source.ts'
export {
  DEFAULT_OPENCODE_USAGE_TIMEOUT_MS,
  parseApiUsageWindow,
  parseHumanReadableTime,
  queryByApiKey,
  queryByWeb,
} from './query.ts'
export type { UsageMode, UsageResult, UsageWindow, UsageWindowKey } from './query.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-opencode-usage'

/** Services required by the opencode usage tool. */
export const inject = ['tools', 'systemPrompt']

/** Plugin configuration: acquisition mode, credential sources, and request budget. */
export interface Config {
  /** Register the tool. Defaults to true. */
  enabled?: boolean
  /** Acquisition mode. Defaults to 'auto' (api key, then dashboard scrape). */
  mode?: UsageMode | 'auto'
  /** Explicit OpenCode Go api key (highest-precedence api-key source). */
  apiKey?: string
  /** Environment variable holding the api key. Defaults to 'OPENCODE_GO_API_KEY'. */
  apiKeyEnv?: string
  /** Fall back to the opencode runtime auth store (auth.json). Defaults to true. */
  readOpencodeAuth?: boolean
  /** Workspace id for the dashboard scrape. */
  workspaceId?: string
  /** auth cookie for the dashboard scrape. */
  authCookie?: string
  /** API origin. Defaults to https://opencode.ai. */
  baseUrl?: string
  /** Cooperative request timeout (ms). Defaults to 15000. */
  timeoutMs?: number
}

/** Schemastery configuration for the opencode usage tool. */
export const Config: z<Config> = z.object({
  enabled: z.boolean(),
  mode: z.union([z.const('auto'), z.const('api-key'), z.const('web')]),
  apiKey: z.string(),
  apiKeyEnv: z.string(),
  readOpencodeAuth: z.boolean(),
  workspaceId: z.string(),
  authCookie: z.string(),
  baseUrl: z.string(),
  timeoutMs: z.number(),
})

/** The default API origin; the config `baseUrl` replaces it when set. */
export const DEFAULT_OPENCODE_BASE_URL = 'https://opencode.ai'

/** The api-key acquisition mode label used in errors and results. */
const API_KEY_MODE: UsageMode = 'api-key'

/** Model-facing description of the tool and when to use it. */
const TOOL_DESCRIPTION =
  'Query the OpenCode Go subscription usage: 5h rolling, weekly, and monthly windows with percent used and reset times. '
  + 'Use this when the user asks about OpenCode Go quota, usage, or limits. '
  + 'Without an explicit mode, the api-key acquisition is preferred and the dashboard scrape is the fallback.'

/** The per-window output schema; a window may be absent from the response. */
const windowSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        percentUsed: { type: 'number', required: true },
        percentRemaining: { type: 'number', required: true },
        resetsAt: { type: 'string', required: true },
      },
    },
    { type: 'null' },
  ],
} as const

/** Resolve the effective acquisition mode: tool argument, then config, then auto. */
function resolveMode(argument: UsageMode | 'auto' | undefined, config: Config): UsageMode | 'auto' {
  return argument ?? config.mode ?? 'auto'
}

/**
 * Format one window as a render line; a null window reports "unavailable".
 * @param label - window label for the table.
 * @param window - the window, or null.
 * @returns one text line.
 */
function formatWindowLine(label: string, window: UsageWindow | null): string {
  if (!window) return `${label}: unavailable`
  return `${label}: ${window.percentUsed}% used (${window.percentRemaining}% remaining), resets ${window.resetsAt}`
}

/** Render the canonical result as human-readable text. */
function renderUsage(value: UsageResult): string {
  const lines = [
    `OpenCode Go usage via ${value.mode} at ${value.queriedAt}:`,
    formatWindowLine('5h rolling', value.windows.rolling),
    formatWindowLine('Weekly', value.windows.weekly),
    formatWindowLine('Monthly', value.windows.monthly),
  ]
  return lines.join('\n')
}

/**
 * Pending-card presenter: the query is a read against an external service.
 * @param _args - the raw tool arguments; unused, the view is static.
 * @returns the pending search card view.
 */
export function presentCall(_args: { mode?: UsageMode | 'auto' }): GenericCallView {
  return { card: 'generic', title: 'Query OpenCode Go usage', kind: 'search' }
}

/**
 * Completed-card presenter: show the rendered usage summary.
 * @param _args - the raw tool arguments; unused, the view derives from the result.
 * @param result - the final model-facing tool result carrying the rendered usage text.
 * @returns the completed generic card view.
 */
export function presentResult(_args: { mode?: UsageMode | 'auto' }, result: ToolResult): GenericResultView {
  return { card: 'generic', title: 'OpenCode Go usage', content: result.content }
}

/** Build the acquisition error listing exactly which source is missing. */
function missingCredentialsError(
  mode: UsageMode | 'auto',
  apiKey: string | null,
  workspaceId: string | null,
  authCookie: string | null,
): Error {
  const hints: string[] = []
  if (!apiKey) {
    hints.push(
      'set config apiKey, the OPENCODE_GO_API_KEY environment variable, '
      + `or an '${OPENCODE_GO_AUTH_PROVIDER_ID}' entry in the opencode auth.json`,
    )
  }
  if (!workspaceId || !authCookie) {
    const missing = !workspaceId && !authCookie ? 'workspaceId and authCookie' : !workspaceId ? 'workspaceId' : 'authCookie'
    hints.push(
      `set ${missing} (config or OPENCODE_GO_WORKSPACE_ID / OPENCODE_GO_AUTH_COOKIE env) for the dashboard scrape`,
    )
  }
  const requested = mode === 'auto' ? 'no usable OpenCode Go credentials' : `mode '${mode}' needs credentials`
  return new Error(`${requested}: ${hints.join('; ')}`)
}

/**
 * Register the `opencode_usage` tool on `ctx.tools` plus a short system-prompt
 * guidance section. A missing credential is a runtime error, never a load-time
 * one: the tool stays visible and fails with a structured message.
 * @param ctx - registrant context carrying the tool and prompt registries.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return
  const timeoutMs = config.timeoutMs ?? DEFAULT_OPENCODE_USAGE_TIMEOUT_MS
  const baseUrl = (config.baseUrl ?? DEFAULT_OPENCODE_BASE_URL).replace(/\/$/, '')
  ctx.systemPrompt.section({
    name: 'tool:opencode_usage',
    order: 115,
    text: 'Use the opencode_usage tool when the user asks about OpenCode Go subscription quota or usage; it reports the 5h rolling, weekly, and monthly windows.',
  })
  ctx.tools.register(defineTool({
    name: 'opencode_usage',
    description: TOOL_DESCRIPTION,
    parameters: {
      mode: {
        type: 'string',
        enum: ['auto', 'api-key', 'web'],
        description: "Acquisition mode: 'api-key' uses the bearer key endpoint, 'web' scrapes the workspace dashboard, 'auto' prefers the api key and falls back to the dashboard.",
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true, enum: ['api-key', 'web'] },
          queriedAt: { type: 'string', required: true },
          windows: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              rolling: { ...windowSchema, required: true },
              weekly: { ...windowSchema, required: true },
              monthly: { ...windowSchema, required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderUsage(value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const mode = resolveMode(args.mode, config)
      const credentials = await resolveCredentials({
        ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
        ...(config.apiKeyEnv !== undefined ? { apiKeyEnv: config.apiKeyEnv } : {}),
        ...(config.readOpencodeAuth !== undefined ? { readOpencodeAuth: config.readOpencodeAuth } : {}),
        ...(config.workspaceId !== undefined ? { workspaceId: config.workspaceId } : {}),
        ...(config.authCookie !== undefined ? { authCookie: config.authCookie } : {}),
      })
      if (mode === API_KEY_MODE || (mode === 'auto' && credentials.apiKey)) {
        if (!credentials.apiKey) {
          throw missingCredentialsError(mode, credentials.apiKey, credentials.workspaceId, credentials.authCookie)
        }
        return await queryByApiKey({
          apiKey: credentials.apiKey,
          baseUrl,
          timeoutMs,
          signal: exec.signal,
        })
      }
      if (!credentials.workspaceId || !credentials.authCookie) {
        throw missingCredentialsError(mode, credentials.apiKey, credentials.workspaceId, credentials.authCookie)
      }
      return await queryByWeb({
        workspaceId: credentials.workspaceId,
        authCookie: credentials.authCookie,
        baseUrl,
        timeoutMs,
        signal: exec.signal,
      })
    },
    presentCall,
    presentResult,
  }))
}
