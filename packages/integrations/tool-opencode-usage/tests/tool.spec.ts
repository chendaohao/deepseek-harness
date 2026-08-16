/**
 * Tool-level tests: the REAL plugin body mounted on a real ToolRuntime and
 * SystemPrompt, invoked through ctx.tools.execute against a stub OpenCode Go
 * server. Only the network boundary is mocked.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import * as tool from '../src/index.ts'
import { presentCall, presentResult } from '../src/index.ts'
import { DATA_SLOT_HTML_FIXTURE, SSR_HTML_FIXTURE, StubServer, USAGE_API_FIXTURE } from './harness.ts'

const testToolSignal = new AbortController().signal

async function setup(config: tool.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // Hermetic by default: never read the developer machine's real opencode auth.json.
  await ctx.plugin(tool, Object.assign({ readOpencodeAuth: false }, config))
  return ctx
}

let callCounter = 0
function callTool(ctx: Context, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name: 'opencode_usage',
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Narrow a successful tool result value to the canonical usage shape. */
function usageValue(value: unknown): {
  mode: 'api-key' | 'web'
  queriedAt: string
  windows: {
    rolling: { percentUsed: number; percentRemaining: number; resetsAt: string } | null
    weekly: { percentUsed: number; percentRemaining: number; resetsAt: string } | null
    monthly: { percentUsed: number; percentRemaining: number; resetsAt: string } | null
  }
} {
  return value as {
    mode: 'api-key' | 'web'
    queriedAt: string
    windows: {
      rolling: { percentUsed: number; percentRemaining: number; resetsAt: string } | null
      weekly: { percentUsed: number; percentRemaining: number; resetsAt: string } | null
      monthly: { percentUsed: number; percentRemaining: number; resetsAt: string } | null
    }
  }
}

describe('dsh-tool-opencode-usage', () => {
  it('registers an opencode_usage tool with the declared schema', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'opencode_usage')
    expect(schema).toBeDefined()
    const parameters = schema!.parameters as { properties?: Record<string, { type: string; enum?: string[] }> }
    expect(Object.keys(parameters.properties ?? {})).toEqual(['mode'])
    expect(parameters.properties?.mode?.enum).toEqual(['auto', 'api-key', 'web'])
    await ctx.fiber.dispose()
  })

  it('does not register the tool when enabled is false', async () => {
    const ctx = await setup({ enabled: false })
    expect(ctx.tools.schemas().some(s => s.name === 'opencode_usage')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('unregisters the tool when the contributing fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(tool, {})
    expect(ctx.tools.schemas().some(s => s.name === 'opencode_usage')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'opencode_usage')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('executes the api-key query and returns the canonical windows', async () => {
    const stub = new StubServer(() => ({ status: 200, body: JSON.stringify(USAGE_API_FIXTURE) }))
    const baseUrl = await stub.start()
    try {
      const ctx = await setup({ apiKey: 'sk-test', baseUrl })
      const result = await callTool(ctx, {})
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = usageValue(result.value)
      expect(value.queriedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(value).toEqual({
        mode: 'api-key',
        queriedAt: value.queriedAt,
        windows: {
          rolling: { percentUsed: 6, percentRemaining: 94, resetsAt: '2026-08-16T04:06:35.215Z' },
          weekly: { percentUsed: 67, percentRemaining: 33, resetsAt: '2026-08-17T00:00:00.215Z' },
          monthly: { percentUsed: 59, percentRemaining: 41, resetsAt: '2026-08-22T10:15:52.215Z' },
        },
      })
      expect(text(result)).toContain('5h rolling: 6% used')
      expect(text(result)).toContain('Weekly: 67% used')
      expect(text(result)).toContain('Monthly: 59% used')
      await ctx.fiber.dispose()
    } finally {
      await stub.stop()
    }
  })

  it('prefers the api key in auto mode and falls back to the dashboard scrape', async () => {
    const apiStub = new StubServer(() => ({ status: 200, body: JSON.stringify(USAGE_API_FIXTURE) }))
    const webStub = new StubServer(() => ({ status: 200, body: SSR_HTML_FIXTURE }))
    const apiBaseUrl = await apiStub.start()
    const webBaseUrl = await webStub.start()
    try {
      const withKey = await setup({ apiKey: 'sk-test', baseUrl: apiBaseUrl })
      const apiResult = await callTool(withKey, {})
      expect(apiResult.isError).toBe(false)
      if (apiResult.isError) throw new Error('expected success')
      expect(usageValue(apiResult.value).mode).toBe('api-key')
      await withKey.fiber.dispose()

      const withCookie = await setup({ workspaceId: 'ws-1', authCookie: 'cookie-1', baseUrl: webBaseUrl })
      const webResult = await callTool(withCookie, {})
      expect(webResult.isError).toBe(false)
      if (webResult.isError) throw new Error('expected success')
      expect(usageValue(webResult.value).mode).toBe('web')
      expect(usageValue(webResult.value).windows.rolling?.percentUsed).toBe(6)
      await withCookie.fiber.dispose()
    } finally {
      await apiStub.stop()
      await webStub.stop()
    }
  })

  it('honors an explicit mode argument over config and auto selection', async () => {
    const webStub = new StubServer(() => ({ status: 200, body: DATA_SLOT_HTML_FIXTURE }))
    const webBaseUrl = await webStub.start()
    try {
      const ctx = await setup({ apiKey: 'sk-test', workspaceId: 'ws-1', authCookie: 'cookie-1', baseUrl: webBaseUrl })
      const result = await callTool(ctx, { mode: 'web' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(usageValue(result.value).mode).toBe('web')
      await ctx.fiber.dispose()
    } finally {
      await webStub.stop()
    }
  })

  it('fails with a credential hint when nothing is configured', async () => {
    const ctx = await setup()
    const result = await callTool(ctx, {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no usable OpenCode Go credentials')
    expect(text(result)).toContain('OPENCODE_GO_API_KEY')
    await ctx.fiber.dispose()
  })

  it('fails when web mode is requested without dashboard credentials', async () => {
    const ctx = await setup({ apiKey: 'sk-test' })
    const result = await callTool(ctx, { mode: 'web' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("mode 'web' needs credentials")
    expect(text(result)).toContain('workspaceId')
    await ctx.fiber.dispose()
  })

  it('fails when api-key mode is requested with only dashboard credentials', async () => {
    const ctx = await setup({ workspaceId: 'ws-1', authCookie: 'cookie-1' })
    const result = await callTool(ctx, { mode: 'api-key' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("mode 'api-key' needs credentials")
    await ctx.fiber.dispose()
  })

  it('propagates the upstream deadline into the query', async () => {
    const stub = new StubServer(() => ({ status: 200, body: '{}', delayMs: 300 }))
    const baseUrl = await stub.start()
    try {
      const ctx = await setup({ apiKey: 'sk-test', baseUrl, timeoutMs: 50 })
      const result = await callTool(ctx, {})
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('OPENCODE_USAGE_TIMEOUT')
      await ctx.fiber.dispose()
    } finally {
      await stub.stop()
    }
  })

  it('runs concurrent invocations without interference (read-only query)', async () => {
    const stub = new StubServer(() => ({ status: 200, body: JSON.stringify(USAGE_API_FIXTURE) }))
    const baseUrl = await stub.start()
    try {
      const ctx = await setup({ apiKey: 'sk-test', baseUrl })
      const [first, second] = await Promise.all([callTool(ctx, {}), callTool(ctx, {})])
      expect(first.isError).toBe(false)
      expect(second.isError).toBe(false)
      if (first.isError || second.isError) throw new Error('expected success')
      const windows = (value: unknown): { rolling?: { percentUsed: number } | null } =>
        (value as { windows: { rolling?: { percentUsed: number } | null } }).windows
      expect(windows(first.value).rolling?.percentUsed).toBe(6)
      expect(windows(second.value).rolling?.percentUsed).toBe(6)
      await ctx.fiber.dispose()
    } finally {
      await stub.stop()
    }
  })

  it('renders an unavailable line for a window the response omits', async () => {
    const body = { usage: { rolling: USAGE_API_FIXTURE.usage.rolling, monthly: USAGE_API_FIXTURE.usage.monthly } }
    const stub = new StubServer(() => ({ status: 200, body: JSON.stringify(body) }))
    const baseUrl = await stub.start()
    try {
      const ctx = await setup({ apiKey: 'sk-test', baseUrl })
      const result = await callTool(ctx, {})
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(usageValue(result.value).windows.weekly).toBeNull()
      expect(text(result)).toContain('Weekly: unavailable')
      await ctx.fiber.dispose()
    } finally {
      await stub.stop()
    }
  })

  it('reports exactly which dashboard credential is missing', async () => {
    const missingWorkspace = await setup({ authCookie: 'cookie-only' })
    const workspaceResult = await callTool(missingWorkspace, { mode: 'web' })
    expect(workspaceResult.isError).toBe(true)
    expect(text(workspaceResult)).toContain('set workspaceId')
    await missingWorkspace.fiber.dispose()

    const missingCookie = await setup({ workspaceId: 'ws-only' })
    const cookieResult = await callTool(missingCookie, { mode: 'web' })
    expect(cookieResult.isError).toBe(true)
    expect(text(cookieResult)).toContain('set authCookie')
    await missingCookie.fiber.dispose()
  })

  it('projects the pending and completed cards as pure functions', () => {
    expect(presentCall({})).toEqual({ card: 'generic', title: 'Query OpenCode Go usage', kind: 'search' })
    expect(presentCall({ mode: 'web' }).card).toBe('generic')
    const content = [{ type: 'text' as const, text: 'OpenCode Go usage via api-key at SNAPSHOT:' }]
    expect(presentResult({}, { content, isError: false })).toEqual({ card: 'generic', title: 'OpenCode Go usage', content })
  })

  it('classifies the read-only query as parallel-safe through the registry', async () => {
    const ctx = await setup({ apiKey: 'sk-test' })
    expect(ctx.tools.executionMode({ name: 'opencode_usage', arguments: {}, callId: CallId('mode-call'), signal: testToolSignal }))
      .toEqual({ kind: 'parallel' })
    await ctx.fiber.dispose()
  })

  it('threads an explicit apiKeyEnv through the credential chain', async () => {
    const stub = new StubServer(() => ({ status: 200, body: JSON.stringify(USAGE_API_FIXTURE) }))
    const baseUrl = await stub.start()
    try {
      const ctx = await setup({ apiKeyEnv: 'MY_GO_KEY', apiKey: 'sk-from-config', baseUrl })
      const result = await callTool(ctx, {})
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(usageValue(result.value).mode).toBe('api-key')
      expect(stub.lastRequest?.headers.authorization).toBe('Bearer sk-from-config')
      await ctx.fiber.dispose()
    } finally {
      await stub.stop()
    }
  })
})
