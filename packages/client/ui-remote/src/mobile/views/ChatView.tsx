/**
 * Chat level: one session. The live-event client's `session/follow` snapshot
 * supplies the opening tail (and the page cursor for loadOlder); appended
 * events fold in live as `session/event` frames; older pages load through
 * `session/page` below the snapshot cursor. Rendering derives only from the
 * follow snapshot, page pulls, and live frames — no local model-visible state.
 *
 * Small-screen parity with the desktop fold: reasoning text hides behind a
 * collapsed "深度思考" disclosure, tool calls behind a collapsed tool
 * disclosure, very long assistant text collapses with an explicit expand
 * toggle, and a toolbar above the composer carries the model picker as a
 * bottom sheet. The header rename affordance calls `session.rename`.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ModelCatalog, ModelSelection } from '../api.ts'
import { modelCatalog, pageSessions, prompt, renameSession, selectModel } from '../api.ts'
import type { EventsClient, SessionEventFrame, SessionSnapshotFrame } from '../events.ts'
import { foldEvents, type RenderMessage, type ToolCallInfo } from '../messages.ts'
import { modelMatchesQuery, useRecentModels } from '@deepseek-ai/dsh-client-ui-primitives'
import { ThemeToggle } from '../ThemeToggle.tsx'
import { errorText, formatTime, staleHostHint, type SessionView } from './App.tsx'
import { zh as mobileCopy } from '../../client/locales.ts'

/** Props for the chat view. */
export interface ChatViewProps {
  session: SessionView
  /** The page-lifetime live-event client (undefined before the first effect tick). */
  events?: EventsClient | undefined
  onBack: () => void
}

/** The session's model-selection projection (the wire's `{ lastUsed, next }`). */
function readProjectedModel(value: unknown): ModelSelection | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { lastUsed?: unknown; next?: unknown }
  const pick = (candidate: unknown): ModelSelection | undefined => {
    if (typeof candidate !== 'object' || candidate === null) return undefined
    const selection = candidate as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    if (typeof selection['provider'] !== 'string' || typeof selection['model'] !== 'string') return undefined
    return {
      provider: selection['provider'],
      model: selection['model'],
      ...(typeof selection['reasoningEffort'] === 'string' ? { reasoningEffort: selection['reasoningEffort'] } : {}),
    }
  }
  // `next` is the selection the next request takes; `lastUsed` is the fallback.
  return pick(record['next']) ?? pick(record['lastUsed'])
}

/** First non-empty line of reasoning text (the collapsed summary). */
function firstMeaningfulLine(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  const newline = trimmed.indexOf('\n')
  return newline === -1 ? trimmed : trimmed.slice(0, newline)
}

/** Latest non-empty line of a streaming reasoning buffer. */
function lastLine(text: string): string {
  const trimmed = text.trimEnd()
  if (trimmed === '') return ''
  const newline = trimmed.lastIndexOf('\n')
  const line = newline === -1 ? trimmed : trimmed.slice(newline + 1)
  return line.trim() === '' ? '' : line
}

/**
 * Render one session's chat.
 * @param props - the session, the live-event client, and the back action.
 * @returns the chat surface.
 */
export function ChatView({ session, events, onBack }: ChatViewProps) {
  const [messages, setMessages] = useState<RenderMessage[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(session.title)
  const [renameError, setRenameError] = useState<string | undefined>(undefined)
  const [currentModel, setCurrentModel] = useState<ModelSelection | undefined>(undefined)
  const [sheet, setSheet] = useState<'model' | null>(null)
  const [title, setTitle] = useState(session.title)
  /** True once the transport has stayed non-open past the banner delay. */
  const [stalled, setStalled] = useState(false)
  const scrollRef = useRef<HTMLDivElement | undefined>(undefined)
  const pendingRef = useRef(false)
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The snapshot and frame legs race: a live frame can arrive before the open
  // snapshot resolves. Buffer those frames and fold them over the tail when it
  // lands — folding them before would be wiped by the tail's replace, and
  // folding the tail over them would suppress the whole tail under their newer
  // seq watermark.
  const pendingLiveRef = useRef<SessionEventFrame[]>([])
  /** Whether the opening snapshot has been applied; live frames fold directly after. */
  const tailAppliedRef = useRef(false)
  /** The follow snapshot's inclusive cursor — the session/page throughSeq. */
  const cursorRef = useRef<number | undefined>(undefined)

  // Reset per open session; the subscribe effect below then refills from the
  // follow snapshot. Declared first so the reset runs before the subscription.
  useEffect(() => {
    setLoading(true)
    setError(undefined)
    setMessages([])
    setHasOlder(false)
    setStalled(false)
    tailAppliedRef.current = false
    pendingLiveRef.current = []
    cursorRef.current = undefined
  }, [session.sessionId])

  // Follow snapshot (content loads when the observed session's stream opens)
  // and transport status. The snapshot supplies the tail records, the page
  // cursor, hasMore, and the current-model projection.
  useEffect(() => {
    if (events === undefined) return
    const applySnapshot = (snapshot: SessionSnapshotFrame): void => {
      if (snapshot.sessionId !== session.sessionId) return
      cursorRef.current = snapshot.cursor
      setHasOlder(snapshot.hasMore)
      const projected = readProjectedModel(snapshot.projections.values['modelSelection'])
      if (projected !== undefined) setCurrentModel(projected)
      setError(undefined)
      if (tailAppliedRef.current) {
        // A fresh generation's records sit at or below the fold watermark, so
        // this only backfills anything the previous generation missed.
        setMessages(previous => foldEvents(snapshot.records, previous))
        return
      }
      const buffered = pendingLiveRef.current
      pendingLiveRef.current = []
      // Mark applied before scheduling the merge so any frame racing this
      // task folds onto the merged tail (React preserves update order and
      // the fold watermark dedups overlap).
      tailAppliedRef.current = true
      setMessages(buffered.reduce((acc, frame) => foldEvents([frame.event], acc), foldEvents(snapshot.records)))
      setLoading(false)
    }
    const unsubscribeSnapshot = events.onSnapshot(applySnapshot)
    const unsubscribeStatus = events.onStatus((status) => {
      if (status === 'open') {
        if (stallTimerRef.current !== undefined) {
          clearTimeout(stallTimerRef.current)
          stallTimerRef.current = undefined
        }
        setStalled(false)
        return
      }
      if (stallTimerRef.current === undefined) {
        stallTimerRef.current = setTimeout(() => {
          stallTimerRef.current = undefined
          setStalled(true)
        }, STALL_BANNER_DELAY_MS)
      }
      if (status !== 'down' || tailAppliedRef.current) return
      setError(mobileCopy['transport.retrying'])
      setLoading(false)
    })
    return () => {
      unsubscribeSnapshot()
      unsubscribeStatus()
      if (stallTimerRef.current !== undefined) {
        clearTimeout(stallTimerRef.current)
        stallTimerRef.current = undefined
      }
    }
  }, [events, session.sessionId])

  // Live frames: fold session events for this session in as they arrive.
  useEffect(() => {
    if (events === undefined) return
    return events.onFrame((frame: SessionEventFrame) => {
      if (frame.sessionId !== session.sessionId) return
      if (!tailAppliedRef.current) {
        pendingLiveRef.current.push(frame)
        return
      }
      setMessages(previous => foldEvents([frame.event], previous))
    })
  }, [events, session.sessionId])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el === undefined) return
    el.scrollTop = el.scrollHeight
  }, [])

  // Keep the newest content visible (initial tail, live chunks, finalization).
  const lastMessageKeyRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (last === undefined) return
    const key = `${last.seq}:${last.pending === true ? 'p' : 'f'}`
    if (key === lastMessageKeyRef.current) return
    lastMessageKeyRef.current = key
    scrollToBottom()
  }, [messages, scrollToBottom])

  /** Load one older page and prepend it (host page boundaries never cut a message). */
  const loadOlder = useCallback(() => {
    if (pendingRef.current) return
    const first = messages[0]
    const cursor = cursorRef.current
    if (first === undefined || cursor === undefined) return
    pendingRef.current = true
    setLoading(true)
    void pageSessions(session.sessionId, cursor, first.seq).then(
      (result) => {
        pendingRef.current = false
        setLoading(false)
        if (result.ok) {
          const older = foldEvents(result.value.events)
          setMessages(previous => [...older, ...previous])
          setHasOlder(result.value.hasMore)
        } else {
          setError(errorText(result.error))
        }
      },
      (reason: unknown) => {
        pendingRef.current = false
        setLoading(false)
        setError(errorText(reason))
      },
    )
  }, [session.sessionId, messages])

  /** Send the drafted prompt (the echoed user/message arrives over the live stream). */
  const send = useCallback(() => {
    const text = input.trim()
    if (text === '' || sending) return
    setSending(true)
    void prompt(session.sessionId, text).then(
      (result) => {
        setSending(false)
        if (result.ok) setInput('')
        else setError(errorText(result.error))
      },
      (reason: unknown) => {
        setSending(false)
        setError(errorText(reason))
      },
    )
  }, [input, sending, session.sessionId])

  /** Commit the rename and update the header title. */
  const commitRename = useCallback(() => {
    const titleValue = renameValue.trim()
    if (titleValue === '' || titleValue === title) {
      setRenaming(false)
      return
    }
    setRenameError(undefined)
    void renameSession(session.sessionId, titleValue).then(
      (result) => {
        if (result.ok) {
          setTitle(result.value.title)
          setRenameValue(result.value.title)
          setRenaming(false)
        } else {
          setRenameError(errorText(result.error))
        }
      },
      () => {
        setRenameError('重命名失败')
      },
    )
  }, [renameValue, title, session.sessionId])

  const modelLabel = currentModel?.model ?? '模型'

  return (
    <div className="chat">
      <header className="mobile-header">
        <button type="button" className="mobile-back" aria-label="返回" onClick={onBack}>‹</button>
        <h1 className="mobile-title mobile-titleInline">{renaming ? '重命名会话' : title}</h1>
        <button
          type="button"
          className="mobile-rename"
          aria-label="重命名会话"
          onClick={() => { setRenaming(value => !value); setRenameValue(title); setRenameError(undefined) }}
        >
          ✎
        </button>
        <ThemeToggle />
      </header>
      {renaming && (
        <div className="rename-row">
          <input
            type="text"
            className="rename-input"
            value={renameValue}
            placeholder="输入新标题…"
            onChange={(event) => { setRenameValue(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); commitRename() }
              if (event.key === 'Escape') setRenaming(false)
            }}
          />
          <button type="button" className="rename-save" onClick={() => { commitRename() }}>
            保存
          </button>
        </div>
      )}
      {renameError !== undefined && <p className="mobile-error mobile-pad">{renameError}</p>}
      {error !== undefined && <p className="mobile-error mobile-pad">{error}</p>}
      {stalled && messages.length > 0 && (
        <p className="mobile-muted mobile-pad">{mobileCopy['transport.reconnecting']}</p>
      )}
      <div className="chat-scroll" ref={(ref) => { scrollRef.current = ref ?? undefined }}>
        {hasOlder && (
          <button type="button" className="chat-load-older" disabled={loading} onClick={() => { loadOlder() }}>
            {loading ? '加载中…' : '加载更早的消息'}
          </button>
        )}
        {messages.map(message => <MessageRow key={message.id} message={message} />)}
        {loading && messages.length === 0 && <p className="chat-typing">加载中…</p>}
        {!loading && messages.length === 0 && <p className="chat-typing">还没有消息，发一句话开始吧</p>}
      </div>
      <div className="chat-tools">
        <button type="button" className="chat-chip" onClick={() => { setSheet('model') }} aria-haspopup="dialog">
          <span className="chat-chip-label">模型</span>
          <span className="chat-chip-value">{modelLabel}</span>
          <span className="chat-chip-chevron" aria-hidden>›</span>
        </button>
      </div>
      <div className="chat-inputbar">
        <textarea
          className="chat-input"
          rows={1}
          value={input}
          placeholder="输入消息，Enter 发送…"
          enterKeyHint="send"
          onChange={(event) => { setInput(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
        />
        <button type="button" className="chat-send" disabled={sending || input.trim() === ''} onClick={() => { send() }}>
          {sending ? '发送中…' : '发送'}
        </button>
      </div>
      {sheet === 'model' && (
        <ModelSheet
          sessionId={session.sessionId}
          current={currentModel}
          onCurrent={(selection) => { setCurrentModel(selection) }}
          onClose={() => { setSheet(null) }}
        />
      )}
    </div>
  )
}

/* ── message rows ─────────────────────────────────────────────────────── */

/** One rendered message row (user bubble or assistant bubble with folds). */
function MessageRow({ message }: { message: RenderMessage }) {
  return (
    <div className={`chat-msg chat-msg-${message.kind}${message.pending === true ? ' chat-msg-pending' : ''}${message.failed === true ? ' chat-msg-failed' : ''}`}>
      {message.kind === 'assistant' && message.reasoning !== undefined && message.reasoning !== '' && (
        <ReasoningDisclosure text={message.reasoning} pending={message.pending === true} />
      )}
      {message.kind === 'assistant' && message.tools !== undefined && message.tools.length > 0 && (
        <ToolDisclosure tools={message.tools} />
      )}
      <CollapsibleText text={message.text} />
      {message.failed === true && <span className="chat-msg-failtag">本次回复失败</span>}
      <span className="chat-msg-time">{formatTime(message.time)}</span>
    </div>
  )
}

/** Collapsed-by-default reasoning disclosure. */
function ReasoningDisclosure({ text, pending }: { text: string; pending: boolean }) {
  const [open, setOpen] = useState(false)
  const summary = pending ? lastLine(text) : firstMeaningfulLine(text)
  return (
    <div className={`chat-disclosure chat-reasoning${open ? ' chat-disclosure-open' : ''}`} data-pending={pending || undefined}>
      <button
        type="button"
        className="chat-disclosure-head"
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className="chat-disclosure-caret" aria-hidden>›</span>
        <span className="chat-disclosure-label">{pending ? '思考中…' : '深度思考'}</span>
        {!open && <span className="chat-disclosure-summary">{summary}</span>}
      </button>
      {open && <div className="chat-disclosure-body">{text}</div>}
    </div>
  )
}

/** Collapsed-by-default tool-call disclosure: summary row + expandable details. */
function ToolDisclosure({ tools }: { tools: ToolCallInfo[] }) {
  const [open, setOpen] = useState(false)
  const names = [...new Set(tools.map(tool => tool.name))].join(' / ')
  return (
    <div className={`chat-disclosure chat-tools${open ? ' chat-disclosure-open' : ''}`}>
      <button
        type="button"
        className="chat-disclosure-head"
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className="chat-disclosure-caret" aria-hidden>›</span>
        <span className="chat-disclosure-label">工具</span>
        {!open && <span className="chat-disclosure-summary">{names}</span>}
        <span className="chat-disclosure-count">{tools.length} 次</span>
      </button>
      {open && (
        <div className="chat-disclosure-body chat-tools-body">
          {tools.map((tool, index) => (
            <div className="chat-tool-item" key={`${tool.callId}-${index}`}>
              <span className="chat-tool-name">{tool.name}</span>
              {tool.arguments !== undefined && <pre className="chat-tool-args">{tool.arguments}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const LONG_TEXT_LIMIT = 1600
const LONG_TEXT_PREVIEW = 800
/**
 * How long the transport may stay non-open before the chat shows the stall
 * line. Healthy idle recycles pass through down → connecting → open within
 * one round trip and must not flash it.
 */
const STALL_BANNER_DELAY_MS = 3_000

/** Long assistant text collapses behind an explicit expand toggle. */
function CollapsibleText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (text.length <= LONG_TEXT_LIMIT) {
    return <span className="chat-msg-text">{text}</span>
  }
  const shown = open ? text : text.slice(0, LONG_TEXT_PREVIEW)
  return (
    <span className="chat-msg-text">
      {shown}{!open ? '…' : ''}
      <button type="button" className="chat-msg-toggle" onClick={() => { setOpen(value => !value) }}>
        {open ? '收起' : `展开全文（${text.length} 字）`}
      </button>
    </span>
  )
}

/* ── bottom sheet ─────────────────────────────────────────────────────── */

/** Shared bottom-sheet chrome (backdrop + slide-up panel); `header` pins above the scroll body. */
function Sheet({ title, header, onClose, children }: {
  title: string
  header?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="sheet-handle" aria-hidden />
        <div className="sheet-title">{title}</div>
        {header}
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  )
}

/** The model + thinking-effort picker (fresh advisory directory per open). */
function ModelSheet({ sessionId, current, onCurrent, onClose }: {
  sessionId: string
  current: ModelSelection | undefined
  onCurrent: (selection: ModelSelection) => void
  onClose: () => void
}) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: ModelCatalog }>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const { recent, record } = useRecentModels()
  const [hint, setHint] = useState<string | undefined>(undefined)

  const load = useCallback(() => {
    setState({ status: 'loading' })
    void modelCatalog().then(
      (result) => {
        if (result.ok) setState({ status: 'ready', data: result.value })
        else setState({ status: 'error', message: errorText(result.error) })
      },
      () => { setState({ status: 'error', message: '模型目录加载失败' }) },
    )
  }, [])

  useEffect(() => { load() }, [load])

  /** Select model/effort and close on success (one-shot action per sheet). */
  const apply = useCallback((selection: ModelSelection) => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    void selectModel(sessionId, selection).then(
      (result) => {
        setBusy(false)
        if (result.ok) {
          record({ provider: selection.provider, model: selection.model })
          // A pick the model cannot take is normalized by the host to its
          // declared default; keep the sheet open so the fallback is visible.
          const requested = selection.reasoningEffort
          const landed = result.value.reasoningEffort
          if (requested !== undefined && landed !== undefined && landed !== requested) {
            setHint(`该模型不支持所选思考等级，已回退到 ${landed}`)
            onCurrent(result.value)
            return
          }
          onCurrent(result.value)
          onClose()
        } else {
          setError(errorText(result.error))
        }
      },
      () => {
        setBusy(false)
        setError('切换模型失败')
      },
    )
  }, [busy, sessionId, onCurrent, onClose, record])

  if (state.status === 'loading') {
    return (
      <Sheet title="模型与思考强度" onClose={onClose}>
        <div className="sheet-status">正在加载模型目录…</div>
      </Sheet>
    )
  }
  if (state.status === 'error') {
    return (
      <Sheet title="模型与思考强度" onClose={onClose}>
        <div className="sheet-status sheet-status-error">
          <span>{state.message}</span>
          {staleHostHint(state.message) !== undefined && <span className="sheet-hint">{staleHostHint(state.message)}</span>}
          <button type="button" className="chat-load-older" onClick={load}>重试</button>
        </div>
      </Sheet>
    )
  }

  const { data } = state
  // An unset session projection falls back to the deployment default: the
  // host resolves an unconfigured session to exactly that catalog default.
  const selected = current ?? data.default ?? { provider: '', model: '' }
  const choices = data.groups.flatMap(group => group.models.map(model => ({ group, model })))
  const searching = query.trim() !== ''
  const filtered = searching
    ? choices.filter(({ group, model }) => modelMatchesQuery(group, model, query))
    : []
  const recentChoices = recent
    .map(entry => choices.find(choice => choice.group.id === entry.provider && choice.model.id === entry.model))
    .filter((choice): choice is NonNullable<typeof choice> => choice !== undefined)
  const currentChoice = choices.find(choice => choice.group.id === selected.provider && choice.model.id === selected.model)
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = selected.reasoningEffort ?? reasoning?.defaultEffort
  const effortChoices: { key: string; effort: string | undefined; label: string; description?: string }[] =
    reasoning === undefined
      ? []
      : [
        ...(reasoning.defaultEffort === undefined
          ? [{ key: 'provider-default', effort: undefined as string | undefined, label: '跟随模型默认' }]
          : []),
        ...reasoning.efforts.map(effort => ({
          key: `effort:${effort.id}`,
          effort: effort.id as string | undefined,
          label: effort.name,
          ...(effort.description !== undefined ? { description: effort.description } : {}),
        })),
      ]

  /** One sheet option row (model or effort): title + optional description, trailing check. */
  const sheetOption = (
    title: string,
    description: string | undefined,
    isSelected: boolean,
    rowKey: string,
    select: () => void,
  ): ReactNode => {
    return (
      <button
        type="button"
        key={rowKey}
        className={`sheet-option${isSelected ? ' sheet-option-selected' : ''}`}
        disabled={busy}
        onClick={select}
      >
        <span className="sheet-option-copy">
          <span className="sheet-option-title">{title}</span>
          {description !== undefined && <span className="sheet-option-desc">{description}</span>}
        </span>
        {isSelected && <span className="sheet-option-check" aria-hidden>√</span>}
      </button>
    )
  }

  /** One model row (search hit, recent, or in-group) wired to {@link apply}. */
  const modelSheetOption = (
    group: { id: string; name: string },
    model: { id: string; name: string; description?: string; reasoning?: { defaultEffort?: string } },
    description: string | undefined,
    rowKey: string,
  ): ReactNode => {
    const isSelected = selected.provider === group.id && selected.model === model.id
    return sheetOption(model.name, description, isSelected, rowKey, () => {
      apply({
        provider: group.id,
        model: model.id,
        ...(model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: model.reasoning.defaultEffort }),
      })
    })
  }

  return (
    <Sheet
      title="模型与思考强度"
      onClose={onClose}
      header={
        <input
          type="search"
          className="mobile-search"
          value={query}
          placeholder="搜索模型…"
          aria-label="搜索模型"
          onChange={(event) => { setQuery(event.target.value) }}
        />
      }
    >
      {error !== undefined && <p className="sheet-error">{error}</p>}
      {error !== undefined && staleHostHint(error) !== undefined && <p className="sheet-hint">{staleHostHint(error)}</p>}
      {hint !== undefined && <p className="sheet-hint">{hint}</p>}
      {data.failures.map(failure => (
        <p className="sheet-error" key={failure.id}>{failure.name}: {failure.message}</p>
      ))}
      {!searching && data.groups.length === 0 && choices.length === 0 && (
        <div className="sheet-status">没有可用的模型</div>
      )}
      {searching ? (
        filtered.length === 0
          ? <div className="sheet-status">没有匹配的模型</div>
          : filtered.map(({ group, model }) => modelSheetOption(group, model, group.name, `${group.id}/${model.id}`))
      ) : (
        <>
          {recentChoices.length > 0 && (
            <div className="sheet-section">
              <div className="sheet-section-title">最近使用</div>
              {recentChoices.map(({ group, model }) => modelSheetOption(group, model, group.name, `${group.id}/${model.id}`))}
            </div>
          )}
          {data.groups.map((group) => {
            const isCollapsed = collapsed.has(group.id)
            const modelsId = `models-${group.id}`
            return (
              <div className="sheet-section" key={group.id}>
                <button
                  type="button"
                  className="sheet-section-title sheet-section-toggle"
                  aria-expanded={!isCollapsed}
                  aria-controls={modelsId}
                  onClick={() => {
                    setCollapsed((previous) => {
                      const next = new Set(previous)
                      if (next.has(group.id)) { next.delete(group.id); return next }
                      return next.add(group.id)
                    })
                  }}
                >
                  <span>{group.name}</span>
                  <span className="sheet-section-count">{group.models.length}</span>
                  <span className="sheet-section-chevron" aria-hidden>{isCollapsed ? '›' : '⌄'}</span>
                </button>
                <div id={modelsId} hidden={isCollapsed}>
                  {group.models.map(model => modelSheetOption(group, model, model.description, model.id))}
                </div>
              </div>
            )
          })}
        </>
      )}
      {effortChoices.length > 0 && (
        <div className="sheet-section">
          <div className="sheet-section-title">思考强度</div>
          {effortChoices.map((choice) => {
            const isSelected = effectiveEffort === choice.effort
            return sheetOption(choice.label, choice.description, isSelected, choice.key, () => {
              apply({
                provider: selected.provider,
                model: selected.model,
                ...(choice.effort !== undefined ? { reasoningEffort: choice.effort } : {}),
              })
            })
          })}
        </div>
      )}
    </Sheet>
  )
}
