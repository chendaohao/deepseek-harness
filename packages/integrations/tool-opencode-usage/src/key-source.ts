/**
 * Resolution of OpenCode Go query credentials: an explicit config api key, an
 * environment variable, and the opencode runtime's own auth store as fallbacks.
 * @module @deepseek-ai/dsh-tool-opencode-usage/key-source
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

/** The opencode auth.json provider entry this package reads. */
export const OPENCODE_GO_AUTH_PROVIDER_ID = 'opencode-go'

/** Environment variable names matching the opencode-quota ecosystem. */
export const OPENCODE_GO_API_KEY_ENV = 'OPENCODE_GO_API_KEY'

/** Environment variable holding the dashboard workspace id. */
export const OPENCODE_GO_WORKSPACE_ID_ENV = 'OPENCODE_GO_WORKSPACE_ID'

/** Environment variable holding the dashboard auth cookie. */
export const OPENCODE_GO_AUTH_COOKIE_ENV = 'OPENCODE_GO_AUTH_COOKIE'

/** Fully resolved credentials; each field is null when no source supplied it. */
export interface OpencodeGoCredentials {
  apiKey: string | null
  workspaceId: string | null
  authCookie: string | null
}

/** Inputs for one credential resolution pass. */
export interface CredentialResolutionParams {
  /** Explicit config api key (highest precedence). */
  apiKey?: string
  /** Environment variable holding the api key; default {@link OPENCODE_GO_API_KEY_ENV}. */
  apiKeyEnv?: string
  /** Whether to fall back to the opencode runtime auth store. Defaults to true. */
  readOpencodeAuth?: boolean
  /** Explicit config workspace id (highest precedence for web mode). */
  workspaceId?: string
  /** Explicit config auth cookie (highest precedence for web mode). */
  authCookie?: string
  /** Environment snapshot; defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Data-home override used by tests; defaults to XDG_DATA_HOME or ~/.local/share. */
  dataHome?: string
}

/**
 * The opencode auth.json path: `<dataHome>/opencode/auth.json` where dataHome
 * is XDG_DATA_HOME or `~/.local/share` (opencode's own Global.Path.Data).
 * @param params - resolution inputs (env and dataHome overrides).
 * @returns the absolute auth.json path.
 */
export function opencodeAuthPath(
  params: Pick<CredentialResolutionParams, 'env' | 'dataHome'> = {},
): string {
  const env = params.env ?? process.env
  const dataHome = params.dataHome ?? (env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'))
  return join(dataHome, 'opencode', 'auth.json')
}

/**
 * Read the opencode-go api key from the opencode runtime auth store. Missing
 * files, invalid JSON, and absent provider entries all resolve to null: the
 * opencode store is a fallback, never a load-time failure.
 * @param params - resolution inputs.
 * @returns the stored api key, or null.
 */
export async function readOpencodeAuthApiKey(
  params: Pick<CredentialResolutionParams, 'env' | 'dataHome'> = {},
): Promise<string | null> {
  let text: string
  try {
    text = await readFile(opencodeAuthPath(params), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const entry = (parsed as Record<string, unknown>)[OPENCODE_GO_AUTH_PROVIDER_ID]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
    const key = (entry as Record<string, unknown>).key
    return typeof key === 'string' && key.length > 0 ? key : null
  } catch {
    return null
  }
}

/**
 * Resolve credentials through the documented chain: explicit config, then the
 * named environment variables, then (api key only) the opencode auth store.
 * @param params - resolution inputs.
 * @returns the resolved credentials; absent sources stay null.
 */
export async function resolveCredentials(
  params: CredentialResolutionParams,
): Promise<OpencodeGoCredentials> {
  const env = params.env ?? process.env
  const apiKeyEnv = params.apiKeyEnv?.trim() || OPENCODE_GO_API_KEY_ENV
  const envApiKey = env[apiKeyEnv]?.trim() || null
  const authStoreKey =
    params.readOpencodeAuth === false ? null : await readOpencodeAuthApiKey(params)
  return {
    apiKey: params.apiKey?.trim() || envApiKey || authStoreKey || null,
    workspaceId: params.workspaceId?.trim() || env[OPENCODE_GO_WORKSPACE_ID_ENV]?.trim() || null,
    authCookie: params.authCookie?.trim() || env[OPENCODE_GO_AUTH_COOKIE_ENV]?.trim() || null,
  }
}
