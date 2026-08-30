/** Node half: /m route registration gated by config.enabled, disposed with the fiber. */
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject } from '../src/index.ts'

// The bundle artifact may or may not be built when this spec runs; pin readFile
// so the 200/500 branches are deterministic either way.
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))

const mockReadFile = vi.mocked(readFile)

afterEach(() => {
  vi.clearAllMocks()
})

/** A minimal route-capturing webserver stand-in. */
function fakeWebServer() {
  const routes = new Map<string, { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }>()
  return {
    register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
    routes,
  }
}

/** A minimal ServerResponse stand-in that records the response. */
function fakeRes() {
  const state = { status: 0, body: '' }
  return {
    state,
    writeHead(status: number) {
      state.status = status
    },
    end(body?: string) {
      if (body !== undefined) state.body = body
    },
  }
}

/** A controllable browser-auth fence: pass all requests unless told otherwise. */
function fakeFence() {
  const state = { reject: false }
  return {
    state,
    requestRejection() {
      return state.reject ? (401 as const) : undefined
    },
  }
}

/** Mount the node half with a fake webserver and fence, returning the captured routes. */
async function mount(enabled: boolean) {
  const ctx = new Context()
  const webServer = fakeWebServer()
  const fence = fakeFence()
  ctx.provide('webServer', webServer as never)
  ctx.provide('connection', fence as never)
  const fiber = ctx.plugin({ inject, apply, Config }, { enabled })
  await fiber.await()
  return { webServer, fence, fiber }
}

describe('ui-remote node half', () => {
  it('declares the webserver service it uses', () => {
    expect(inject).toEqual(['webServer'])
  })

  it('registers no routes while disabled', async () => {
    const { webServer, fiber } = await mount(false)
    expect([...webServer.routes.keys()]).toEqual([])
    await fiber.dispose()
  })

  it('registers /m and /m/mobile.js when enabled, and removes them on disposal', async () => {
    const { webServer, fiber } = await mount(true)
    expect([...webServer.routes.keys()].sort()).toEqual(['/m', '/m/mobile.js'])
    await fiber.dispose()
    expect([...webServer.routes.keys()]).toEqual([])
  })

  it('refuses /m with 401 when the browser-auth fence rejects the request', async () => {
    const { webServer, fence, fiber } = await mount(true)
    fence.state.reject = true
    const res = fakeRes()
    await webServer.routes.get('/m')!.handler({} as never, res as unknown as ServerResponse)
    expect(res.state.status).toBe(401)
    await fiber.dispose()
  })

  it('refuses /m/mobile.js with 401 when the fence rejects the request', async () => {
    const { webServer, fence, fiber } = await mount(true)
    fence.state.reject = true
    const res = fakeRes()
    await webServer.routes.get('/m/mobile.js')!.handler({} as never, res as unknown as ServerResponse)
    expect(res.state.status).toBe(401)
    await fiber.dispose()
  })

  it('serves the mobile document shell at /m', async () => {
    const { webServer, fiber } = await mount(true)
    const res = fakeRes()
    await webServer.routes.get('/m')!.handler({} as never, res as unknown as ServerResponse)
    expect(res.state.status).toBe(200)
    expect(res.state.body).toContain('<html lang="zh-CN">')
    expect(res.state.body).toContain('<meta name="viewport"')
    expect(res.state.body).toContain('<title>移动端远程控制</title>')
    expect(res.state.body).toContain('src="/m/mobile.js"')
    await fiber.dispose()
  })

  it('answers the bundle route with the built mobile.js', async () => {
    mockReadFile.mockResolvedValueOnce('console.log("mobile")')
    const { webServer, fiber } = await mount(true)
    const res = fakeRes()
    await webServer.routes.get('/m/mobile.js')!.handler({} as never, res as unknown as ServerResponse)
    expect(res.state.status).toBe(200)
    expect(res.state.body).toBe('console.log("mobile")')
    await fiber.dispose()
  })

  it('answers the bundle route with 500 when lib/mobile.js is not built yet', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))
    const { webServer, fiber } = await mount(true)
    const res = fakeRes()
    await webServer.routes.get('/m/mobile.js')!.handler({} as never, res as unknown as ServerResponse)
    expect(res.state.status).toBe(500)
    expect(res.state.body).toContain('mobile bundle missing')
    await fiber.dispose()
  })
})
