/**
 * Serve one Session's current Git branch for the Chat run chip. Read-only:
 * `git` is asked for the checked-out branch of the Session's working
 * directory and nothing else is run. A deployment without Connection (a
 * non-Web profile) simply has no route to serve.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CHAT_BRANCH_PATH, type ChatBranch } from './branch.ts'

/** Milliseconds one `git` answer may take before the chip reports no branch. */
const GIT_TIMEOUT_MS = 2_000
/** Bytes of `git` output retained; a branch name is far shorter. */
const GIT_OUTPUT_MAX_BYTES = 4_096

/**
 * Register the branch route inside Connection's authentication fence.
 * @param ctx - Session lookup, subprocess capability, and route lifetime.
 */
export function registerChatBranch(ctx: Context): void {
  ctx.inject(['connection', 'sessions', 'subprocess'], (scope) => {
    const lifetime = new AbortController()
    scope.effect(() => () => {
      lifetime.abort()
      return Promise.resolve()
    }, 'ui-chat: branch route lifetime')
    scope.effect(() => scope.connection.fetch.register({
      path: CHAT_BRANCH_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => handleChatBranch(scope, request, lifetime.signal),
    }), 'ui-chat: branch route')
  })
}

/**
 * Answer one branch request.
 * @param ctx - Session lookup and subprocess capability.
 * @param request - the authenticated GET.
 * @param lifetime - plugin cancellation.
 * @returns the branch answer, which is `null` when no branch is checked out.
 */
async function handleChatBranch(ctx: Context, request: Request, lifetime: AbortSignal): Promise<Response> {
  const id = new URL(request.url).searchParams.get('sessionId')
  if (id === null || id === '') return new Response('Missing session id.', { status: 400 })
  const cwd = ctx.sessions.get(id as SessionId)?.header.cwd
  const branch = cwd === undefined ? null : await currentBranch(ctx, cwd, AbortSignal.any([request.signal, lifetime]))
  return Response.json({ branch } satisfies ChatBranch, { headers: { 'cache-control': 'no-store' } })
}

/**
 * Read the branch checked out at one directory.
 * @param ctx - subprocess capability.
 * @param cwd - the Session's working directory.
 * @param signal - request cancellation.
 * @returns the branch name, or `null` outside a repository, on a detached HEAD, or without git.
 */
async function currentBranch(ctx: Context, cwd: string, signal: AbortSignal): Promise<string | null> {
  let executable: string
  try {
    executable = await ctx.subprocess.resolveExecutable('git', undefined, signal)
  } catch {
    // No git in the Host's execution world: the chip stays absent rather than failing the turn view.
    return null
  }
  const timeout = AbortSignal.timeout(GIT_TIMEOUT_MS)
  const handle = ctx.subprocess.spawn({
    argv: [executable, '--no-optional-locks', 'symbolic-ref', '--short', '--quiet', 'HEAD'],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: GIT_OUTPUT_MAX_BYTES },
      stderr: { maxBytes: GIT_OUTPUT_MAX_BYTES },
    },
    graceMs: 500,
    signal: AbortSignal.any([signal, timeout]),
    // A read must not prompt, and must not take an optional lock.
    env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  })
  const outcome = await handle.done.catch(() => ({ exitCode: null }))
  const stdout = handle.collected.stdout?.readFrom(0).text.trim() ?? ''
  // Outside a repository and on a detached HEAD git exits non-zero with no
  // answer; either way there is no branch to show.
  if (outcome.exitCode !== 0) return null
  return stdout === '' ? null : stdout
}
