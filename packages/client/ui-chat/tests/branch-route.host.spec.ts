/** The run chip's branch route over a real Connection fence and a real git repository. */

import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { CHAT_BRANCH_PATH } from '../src/branch.ts'
import { registerChatBranch } from '../src/branch-host.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** One repo on `topic`, one plain directory, and the Session headers that point at them. */
async function fixture(subprocess?: object) {
  const repository = await scratch('dsh-chat-branch-')
  git(repository, 'init', '-q', '-b', 'main')
  await writeFile(join(repository, 'a.txt'), 'a\n')
  git(repository, 'add', '-A')
  git(repository, 'commit', '-q', '-m', 'init')
  git(repository, 'checkout', '-q', '-b', 'topic')
  const outside = await scratch('dsh-chat-branch-plain-')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  if (subprocess === undefined) await ctx.plugin(LocalSubprocessRuntime)
  else ctx.provide('subprocess', subprocess as never)
  const headers = new Map<string, { cwd?: string }>([
    ['repo', { cwd: repository }],
    ['plain', { cwd: outside }],
    ['nocwd', {}],
  ])
  ctx.provide('sessions', {
    get: (id: SessionId) => {
      const header = headers.get(id)
      return header === undefined ? undefined : { header }
    },
  } as never)
  // The constructor registers the `connection` service; the route plugin then injects it.
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const lifetime = ctx.plugin({
    inject: ['connection', 'sessions', 'subprocess'],
    apply: registerChatBranch,
  })
  await lifetime
  const handler = connection.createSharedFetchHandler('/api')
  const read = (query: string) => handler.fetch(
    new Request(`http://localhost${CHAT_BRANCH_PATH}${query}`),
    connection.browserPeer,
  )
  return { repository, outside, read, connection }
}

describe('branch route', () => {
  it('names the branch checked out at the Session working directory', async () => {
    const { read } = await fixture()
    const response = await read('?sessionId=repo')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ branch: 'topic' })
  })

  it('answers null outside a repository, without a working directory, and on a detached HEAD', async () => {
    const { read, repository } = await fixture()
    expect(await (await read('?sessionId=plain')).json()).toEqual({ branch: null })
    expect(await (await read('?sessionId=nocwd')).json()).toEqual({ branch: null })
    expect(await (await read('?sessionId=unknown')).json()).toEqual({ branch: null })
    git(repository, 'checkout', '-q', '--detach')
    expect(await (await read('?sessionId=repo')).json()).toEqual({ branch: null })
  })

  it('shows no branch when git cannot be found or the read fails', async () => {
    const missing = await fixture({ resolveExecutable: () => Promise.reject(new Error('spawn git ENOENT')) })
    expect(await (await missing.read('?sessionId=repo')).json()).toEqual({ branch: null })

    const failed = await fixture({
      resolveExecutable: () => Promise.resolve('/usr/bin/git'),
      spawn: () => ({ done: Promise.reject(new Error('spawn failed')), collected: {} }),
    })
    expect(await (await failed.read('?sessionId=repo')).json()).toEqual({ branch: null })
  })

  it('shows no branch when git succeeds without naming one', async () => {
    const silent = await fixture({
      resolveExecutable: () => Promise.resolve('/usr/bin/git'),
      spawn: () => ({
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: { stdout: { readFrom: () => ({ text: '  \n', nextOffset: 0, lossy: false }) } },
      }),
    })
    expect(await (await silent.read('?sessionId=repo')).json()).toEqual({ branch: null })
  })

  it('refuses a request without a session id', async () => {
    const { read } = await fixture()
    expect((await read('')).status).toBe(400)
    expect((await read('?sessionId=')).status).toBe(400)
  })
})
