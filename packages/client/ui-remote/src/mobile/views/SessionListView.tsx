/**
 * Sessions level: one workspace's sessions, filtered from the session.list
 * roster by the workspace's owned session ids, plus a full-text search across
 * all sessions and the new-session action. Creating a session attaches it to
 * the workspace and lands the user straight in the new chat — the same "new
 * session opens" flow as the desktop UI.
 */

import { useCallback, useEffect, useState } from 'react'
import type { SessionSearchItem, SessionSummary, WorkspaceView as WorkspaceRow } from '../api.ts'
import { createSession, listSessions, listWorkspaces, searchSessions } from '../api.ts'
import { ThemeToggle } from '../ThemeToggle.tsx'
import { errorText, formatTime, toSessionView, type SessionView } from './App.tsx'

/** Props for the session list. */
export interface SessionListViewProps {
  workspace: WorkspaceRow
  onBack: () => void
  onPick: (session: SessionView) => void
}

/** Rows that belong to the opened workspace (its owned session id set). */
function ownedItems(items: SessionSummary[], workspace: WorkspaceRow): SessionView[] {
  const owned = new Set(workspace.sessionIds)
  return items.filter(item => owned.has(item.sessionId)).map(item => toSessionView(item))
}

/**
 * Render one workspace's session list with search and create.
 * @param props - the workspace, back action, and pick action.
 * @returns the session list.
 */
export function SessionListView({ workspace, onBack, onPick }: SessionListViewProps) {
  const [rows, setRows] = useState<SessionView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<SessionSearchItem[] | undefined>(undefined)
  const [searchError, setSearchError] = useState<string | undefined>(undefined)

  // First page on mount. The workspace roster is re-read alongside so the
  // owned-id set is fresh: a session created (or attached) since this
  // workspace row was captured must not vanish from the filter.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    void Promise.all([listSessions(), listWorkspaces()]).then(
      ([sessions, workspaces]) => {
        if (cancelled) return
        if (!sessions.ok) {
          setError(errorText(sessions.error))
          setLoading(false)
          return
        }
        if (!workspaces.ok) {
          setError(errorText(workspaces.error))
          setLoading(false)
          return
        }
        const fresh = workspaces.value.find(candidate => candidate.workspaceId === workspace.workspaceId)
        const current = fresh ?? workspace
        setRows(ownedItems(sessions.value, current))
        setLoading(false)
      },
      (reason: unknown) => {
        if (cancelled) return
        setError(errorText(reason))
        setLoading(false)
      },
    )
    return () => { cancelled = true }
  }, [workspace])

  // Debounced full-text search across all sessions (the surface keeps the
  // workspace's own list until a query is typed).
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed === '') {
      setResults(undefined)
      setSearching(false)
      setSearchError(undefined)
      return
    }
    setSearching(true)
    setSearchError(undefined)
    const timer = setTimeout(() => {
      void searchSessions(trimmed).then(
        (result) => {
          setSearching(false)
          if (result.ok) setResults(result.value)
          else {
            setResults(undefined)
            setSearchError(errorText(result.error))
          }
        },
        () => {
          setSearching(false)
          setResults(undefined)
        },
      )
    }, 250)
    return () => { clearTimeout(timer) }
  }, [query])

  /** Create a blank session in this workspace and open it immediately. */
  const handleCreate = useCallback(() => {
    if (creating) return
    setCreating(true)
    setCreateError(undefined)
    void createSession(workspace.workspaceId).then(
      (result) => {
        setCreating(false)
        if (result.ok) {
          const view: SessionView = {
            sessionId: result.value.sessionId,
            title: '新会话',
            updatedAt: Date.now(),
            running: false,
            blank: true,
          }
          setRows(previous => [view, ...previous])
          onPick(view)
        } else {
          setCreateError(errorText(result.error))
        }
      },
      () => {
        setCreating(false)
        setCreateError('创建失败')
      },
    )
  }, [creating, workspace, onPick])

  /** Open one search hit's chat (the snippet stands in for its title). */
  const pickSearchHit = useCallback((item: SessionSearchItem) => {
    onPick({
      sessionId: item.sessionId,
      title: item.snippet === '' ? '会话' : item.snippet,
      updatedAt: Date.now(),
      running: false,
      blank: false,
    })
  }, [onPick])

  const searchingActive = query.trim() !== ''

  return (
    <div className="mobile">
      <header className="mobile-header">
        <button type="button" className="mobile-back" aria-label="返回" onClick={onBack}>‹</button>
        <h1 className="mobile-title mobile-titleInline">{workspace.title}</h1>
        <ThemeToggle />
      </header>
      {error !== undefined && <p className="mobile-error mobile-pad">{error}</p>}
      <div className="mobile-pad">
        <button
          type="button"
          className="mobile-new"
          disabled={creating}
          onClick={() => { handleCreate() }}
        >
          {creating ? '创建中…' : '+ 新建会话'}
        </button>
      </div>
      <input
        type="search"
        className="mobile-search"
        placeholder="搜索全部会话…"
        value={query}
        onChange={(event) => { setQuery(event.target.value) }}
      />
      {searchError !== undefined && <p className="mobile-error mobile-pad">{searchError}</p>}
      {createError !== undefined && <p className="mobile-error mobile-pad">{createError}</p>}
      {searchingActive && results !== undefined && (
        <div className="mobile-searchResult">
          {results.length === 0 && !searching && <p className="mobile-muted mobile-pad">没有匹配的会话</p>}
          {results.map(item => (
            <button type="button" key={item.sessionId} onClick={() => { pickSearchHit(item) }}>
              <span className="mobile-rowTitle">{item.snippet === '' ? '会话' : item.snippet}</span>
              <span className="mobile-searchResultSnippet">{item.sessionId}</span>
            </button>
          ))}
        </div>
      )}
      {searchingActive && searching && <p className="mobile-muted mobile-pad">搜索中…</p>}
      {!searchingActive && (
        <ul className="mobile-list">
          {rows.map(row => (
            <li key={row.sessionId}>
              <button type="button" className="mobile-row" onClick={() => { onPick(row) }}>
                <span className="mobile-rowMain">
                  <span className="mobile-rowTitle">
                    {row.blank ? '新会话' : row.title}
                    {row.running ? <span className="mobile-live">●</span> : null}
                  </span>
                  <span className="mobile-rowMeta">{formatTime(row.updatedAt)}</span>
                </span>
                <span className="mobile-chevron">›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!searchingActive && rows.length === 0 && !loading && (
        <div className="mobile-empty">
          <p className="mobile-muted">该工作区还没有会话，点上方按钮新建一个</p>
        </div>
      )}
    </div>
  )
}
