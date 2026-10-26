/**
 * The run chip's Host route and its wire form: the Git branch checked out at the
 * viewed Session's working directory, shown beside the floating controls while
 * a turn runs. The answer is read-only — nothing here switches branches.
 *
 * @module @deepseek-ai/dsh-client-ui-chat/branch
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Authenticated GET route serving one Session's current Git branch. */
export const CHAT_BRANCH_PATH = '/api/chat.branch'

/**
 * Browser-relative form of {@link CHAT_BRANCH_PATH}; see
 * .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md.
 */
export const CHAT_BRANCH_ROUTE = CHAT_BRANCH_PATH.slice(1)

/** The route's answer: the branch name, or `null` outside a repository or on a detached HEAD. */
export interface ChatBranch {
  readonly branch: string | null
}

/**
 * Validate one decoded answer.
 * @param value - decoded JSON.
 * @returns whether the value carries a branch name or an explicit `null`.
 */
export function isChatBranch(value: unknown): value is ChatBranch {
  if (typeof value !== 'object' || value === null || !('branch' in value)) return false
  const { branch } = value
  return branch === null || (typeof branch === 'string' && branch !== '')
}

/**
 * Authenticated URL of one Session's branch answer.
 * @param sessionId - viewed Session.
 * @returns document-relative request URL.
 */
export function chatBranchUrl(sessionId: SessionId): string {
  return `${CHAT_BRANCH_ROUTE}?${new URLSearchParams({ sessionId })}`
}
