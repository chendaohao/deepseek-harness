/**
 * Credential-resolution tests: the explicit-config, environment, and opencode
 * auth-store chain for the api key, plus the workspace/cookie web-mode sources.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  OPENCODE_GO_AUTH_COOKIE_ENV,
  OPENCODE_GO_API_KEY_ENV,
  OPENCODE_GO_WORKSPACE_ID_ENV,
  opencodeAuthPath,
  readOpencodeAuthApiKey,
  resolveCredentials,
} from '../src/key-source.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-opencode-key-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const AUTH_JSON = JSON.stringify({
  'sensenova': { type: 'api', key: 'sk-other' },
  'opencode-go': { type: 'api', key: 'sk-from-auth-json' },
})

async function writeAuthJson(content: string): Promise<void> {
  await mkdir(join(dir, 'opencode'), { recursive: true })
  await writeFile(join(dir, 'opencode', 'auth.json'), content)
}

describe('opencodeAuthPath', () => {
  it('resolves under the data home with the opencode segment', () => {
    expect(opencodeAuthPath({ dataHome: '/data' })).toBe(join('/data', 'opencode', 'auth.json'))
  })

  it('honors XDG_DATA_HOME over the default data home', () => {
    expect(opencodeAuthPath({ env: { XDG_DATA_HOME: '/xdg' } })).toBe(join('/xdg', 'opencode', 'auth.json'))
  })
})

describe('readOpencodeAuthApiKey', () => {
  it('reads the opencode-go api key from auth.json', async () => {
    await writeAuthJson(AUTH_JSON)
    expect(await readOpencodeAuthApiKey({ dataHome: dir })).toBe('sk-from-auth-json')
  })

  it('returns null when auth.json is missing', async () => {
    expect(await readOpencodeAuthApiKey({ dataHome: dir })).toBeNull()
  })

  it('returns null when auth.json is invalid JSON', async () => {
    await writeAuthJson('{not json')
    expect(await readOpencodeAuthApiKey({ dataHome: dir })).toBeNull()
  })

  it('returns null when the opencode-go entry is absent', async () => {
    await writeAuthJson(JSON.stringify({ sensenova: { type: 'api', key: 'sk-other' } }))
    expect(await readOpencodeAuthApiKey({ dataHome: dir })).toBeNull()
  })

  it('returns null for non-object auth.json roots', async () => {
    await writeAuthJson('null')
    expect(await readOpencodeAuthApiKey({ dataHome: dir })).toBeNull()
    await writeAuthJson('[]')
    expect(await readOpencodeAuthApiKey({ dataHome: dir })).toBeNull()
    await writeAuthJson('"sk-bare-string"')
    expect(await readOpencodeAuthApiKey({ dataHome: dir })).toBeNull()
  })

  it('returns null when the entry or key is malformed', async () => {
    await writeAuthJson(JSON.stringify({ 'opencode-go': { type: 'api' } }))
    expect(await readOpencodeAuthApiKey({ dataHome: dir })).toBeNull()
    await writeAuthJson(JSON.stringify({ 'opencode-go': 'sk-bare' }))
    expect(await readOpencodeAuthApiKey({ dataHome: dir })).toBeNull()
    await writeAuthJson(JSON.stringify({ 'opencode-go': { type: 'api', key: '' } }))
    expect(await readOpencodeAuthApiKey({ dataHome: dir })).toBeNull()
  })
})

describe('resolveCredentials', () => {
  it('prefers the explicit config api key over env and the auth store', async () => {
    await writeAuthJson(AUTH_JSON)
    const credentials = await resolveCredentials({
      apiKey: 'sk-config',
      env: { [OPENCODE_GO_API_KEY_ENV]: 'sk-env' },
      dataHome: dir,
    })
    expect(credentials.apiKey).toBe('sk-config')
  })

  it('prefers the environment over the auth store', async () => {
    await writeAuthJson(AUTH_JSON)
    const credentials = await resolveCredentials({
      env: { [OPENCODE_GO_API_KEY_ENV]: 'sk-env' },
      dataHome: dir,
    })
    expect(credentials.apiKey).toBe('sk-env')
  })

  it('falls back to the opencode auth store', async () => {
    await writeAuthJson(AUTH_JSON)
    const credentials = await resolveCredentials({ dataHome: dir })
    expect(credentials.apiKey).toBe('sk-from-auth-json')
  })

  it('skips the auth store when readOpencodeAuth is false', async () => {
    await writeAuthJson(AUTH_JSON)
    const credentials = await resolveCredentials({ readOpencodeAuth: false, dataHome: dir })
    expect(credentials.apiKey).toBeNull()
  })

  it('honors a custom apiKeyEnv name', async () => {
    const credentials = await resolveCredentials({ apiKeyEnv: 'MY_GO_KEY', env: { MY_GO_KEY: 'sk-custom-env' } })
    expect(credentials.apiKey).toBe('sk-custom-env')
  })

  it('resolves web-mode credentials from config, then environment', async () => {
    const fromConfig = await resolveCredentials({ workspaceId: 'ws-config', authCookie: 'cookie-config' })
    expect(fromConfig.workspaceId).toBe('ws-config')
    expect(fromConfig.authCookie).toBe('cookie-config')
    const fromEnv = await resolveCredentials({
      env: {
        [OPENCODE_GO_WORKSPACE_ID_ENV]: 'ws-env',
        [OPENCODE_GO_AUTH_COOKIE_ENV]: 'cookie-env',
      },
    })
    expect(fromEnv.workspaceId).toBe('ws-env')
    expect(fromEnv.authCookie).toBe('cookie-env')
  })

  it('trims surrounding whitespace from every source', async () => {
    const credentials = await resolveCredentials({
      apiKey: '  sk-config  ',
      workspaceId: '  ws-1  ',
      authCookie: '  cookie-1  ',
    })
    expect(credentials.apiKey).toBe('sk-config')
    expect(credentials.workspaceId).toBe('ws-1')
    expect(credentials.authCookie).toBe('cookie-1')
  })

  it('leaves absent sources null', async () => {
    const credentials = await resolveCredentials({ dataHome: dir })
    expect(credentials).toEqual({ apiKey: null, workspaceId: null, authCookie: null })
  })
})
