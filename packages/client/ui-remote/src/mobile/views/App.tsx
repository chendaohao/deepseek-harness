/**
 * Mobile surface root: the view state machine (workspaces → sessions → chat)
 * and the page-lifetime live-event client. Deliberately plain React state —
 * no router, no state library: the surface is three fixed levels with a back
 * affordance, and every piece of data is fetched on demand. All rendering
 * derives from `session.history` pulls and `session/event` frames; nothing
 * model-visible is held locally.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionSummary, WorkspaceView as WorkspaceRow } from '../api.ts'
import { listWorkspaces } from '../api.ts'
import { EventsClient } from '../events.ts'
import { ChatView } from './ChatView.tsx'
import { SessionListView } from './SessionListView.tsx'
import { WorkspaceView as WorkspaceRoster } from './WorkspaceView.tsx'

/** One navigation level. */
type Route =
  | { kind: 'workspaces' }
  | { kind: 'sessions'; workspace: WorkspaceRow }
  | { kind: 'chat'; session: SessionView; workspace: WorkspaceRow }

/** The session-list row model (the list and chat share it). */
export interface SessionView {
  sessionId: string
  title: string
  cwd?: string
  updatedAt: number
  running: boolean
  blank: boolean
}

/** Map a list row to the surface model; the title comes from projections when present. */
export function toSessionView(item: SessionSummary): SessionView {
  const titleValue = item.projections?.values?.['title']
  const title = typeof titleValue === 'string' && titleValue !== ''
    ? titleValue
    : item.cwd !== undefined ? item.cwd.split('/').filter(Boolean).at(-1) ?? item.cwd : '新会话'
  return {
    sessionId: item.sessionId,
    title,
    ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
    updatedAt: item.updatedAt,
    running: item.running,
    blank: item.blank,
  }
}

/** Human clock, e.g. "14:05" or "昨天 20:31". */
export function formatTime(epochMs: number): string {
  const date = new Date(epochMs)
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return clock
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${clock}`
  return `${String(date.getMonth() + 1)}月${String(date.getDate())}日 ${clock}`
}

/** Shared error text for the surface's small failure affordances. */
export function errorText(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown })['message'] === 'string') {
    return (error as { message: string })['message']
  }
  if (error instanceof Error) return error.message
  return String(error)
}

/** Actionable hint for transport-level 403s on host-gated channels. */
export function staleHostHint(message: string): string | undefined {
  return /^HTTP 403/.test(message)
    ? '宿主端插件可能仍在运行旧版本：请重启 dsh web 后再试。'
    : undefined
}

/**
 * The surface root.
 * @returns the app tree.
 */
export function App() {
  const [route, setRoute] = useState<Route>({ kind: 'workspaces' })
  const eventsRef = useRef<EventsClient | undefined>(undefined)

  // The live-event client lives for the page lifetime: session events keep
  // the open chat live, and reconnect is automatic.
  useEffect(() => {
    const events = new EventsClient()
    eventsRef.current = events
    events.start()
    return () => { events.stop() }
  }, [])

  // Keep the live-event client pointed at the session currently on screen so
  // its polling fallback can keep that chat fresh when the socket is down.
  useEffect(() => {
    eventsRef.current?.observe(route.kind === 'chat' ? route.session.sessionId : undefined)
  }, [route])

  const back = useCallback(() => {
    setRoute((previous) => {
      if (previous.kind === 'chat') return { kind: 'sessions', workspace: previous.workspace }
      if (previous.kind === 'sessions') return { kind: 'workspaces' }
      return previous
    })
  }, [])

  return (
    <div className="mobile">
      {route.kind === 'workspaces'
        ? <WorkspaceRoster onPick={(workspace) => { setRoute({ kind: 'sessions', workspace }) }} />
        : route.kind === 'sessions'
          ? (
            <SessionListView
              workspace={route.workspace}
              onBack={back}
              onPick={(session) => { setRoute({ kind: 'chat', session, workspace: route.workspace }) }}
            />
          )
          : <ChatView session={route.session} events={eventsRef.current} onBack={back} />}
    </div>
  )
}

export { listWorkspaces }
