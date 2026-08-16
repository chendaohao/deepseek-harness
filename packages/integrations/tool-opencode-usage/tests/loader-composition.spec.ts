/**
 * Real Loader composition: the plugin boots through a cordis.yml that carries
 * its config (including a stub baseUrl), and the registered tool executes end
 * to end. The config is real configurability — acquisition mode, credentials,
 * and endpoint all come from the file.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolOpencodeUsage from '@deepseek-ai/dsh-tool-opencode-usage'

import { SSR_HTML_FIXTURE, StubServer, USAGE_API_FIXTURE } from './harness.ts'

let root: string | undefined
let context: Context | undefined
let stub: StubServer | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await stub?.stop()
  stub = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const testToolSignal = new AbortController().signal

async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-opencode-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-opencode-usage'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-opencode-usage', ToolOpencodeUsage],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

function callTool(ctx: Context, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId('loader-call'),
    name: 'opencode_usage',
    arguments: args,
  })
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('tool-opencode-usage real Loader composition through cordis.yml', () => {
  it('boots without a default export (unwrapExports round trip)', () => {
    expect('default' in ToolOpencodeUsage).toBe(false)
    expect(ToolOpencodeUsage.name).toBe('tool-opencode-usage')
    expect(ToolOpencodeUsage.inject).toEqual(['tools', 'systemPrompt'])
  })

  it('executes the api-key query with config-driven credentials and endpoint', async () => {
    stub = new StubServer(() => ({ status: 200, body: JSON.stringify(USAGE_API_FIXTURE) }))
    const baseUrl = await stub.start()
    const ctx = await boot([
      '    apiKey: sk-from-config',
      `    baseUrl: ${baseUrl}`,
    ])
    const result = await callTool(ctx, {})
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect((result.value as { mode: string }).mode).toBe('api-key')
    expect((result.value as { windows: { monthly?: { percentUsed: number } | null } }).windows.monthly?.percentUsed).toBe(59)
    expect(stub.lastRequest?.headers.authorization).toBe('Bearer sk-from-config')
  })

  it('executes the web scrape with config-driven dashboard credentials', async () => {
    stub = new StubServer(() => ({ status: 200, body: SSR_HTML_FIXTURE }))
    const baseUrl = await stub.start()
    const ctx = await boot([
      '    mode: web',
      '    workspaceId: ws-loader',
      '    authCookie: cookie-loader',
      `    baseUrl: ${baseUrl}`,
    ])
    const result = await callTool(ctx, {})
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect((result.value as { mode: string }).mode).toBe('web')
    expect((result.value as { windows: { rolling?: { percentUsed: number } | null } }).windows.rolling?.percentUsed).toBe(6)
    expect(stub.lastRequest?.headers.cookie).toBe('auth=cookie-loader')
  })

  it('fails with the structured credential error when no source is configured', async () => {
    // readOpencodeAuth: false keeps the run hermetic — the fallback to the
    // developer machine's real opencode auth.json would otherwise succeed.
    const ctx = await boot(['    readOpencodeAuth: false'])
    const result = await callTool(ctx, {})
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('no usable OpenCode Go credentials')
  })
})
