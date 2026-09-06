// @vitest-environment jsdom
/** Mobile views: navigation, roster and session lists, and the chat surface (snapshot tail, live frames, prompt, model sheet, rename). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RECENT_MODELS_KEY, readRecentModels } from '@deepseek-ai/dsh-client-ui-primitives'
import { App, toSessionView } from '../src/mobile/views/App.tsx'
import { WorkspaceView } from '../src/mobile/views/WorkspaceView.tsx'
import { SessionListView } from '../src/mobile/views/SessionListView.tsx'
import { ChatView } from '../src/mobile/views/ChatView.tsx'
import type { EventsClient, SessionSnapshotFrame } from '../src/mobile/events.ts'
import type { WireEvent } from '../src/mobile/messages.ts'
import type { ModelCatalog, SessionSearchItem, SessionSummary, WorkspaceView as WorkspaceRow } from '../src/mobile/api.ts'
import { createSession, fetchWorkspaceRoster, listSessions, modelCatalog, pageSessions, prompt, renameSession, searchSessions, selectModel } from '../src/mobile/api.ts'
import { foldEvents, recordsToWireEvents } from '../src/mobile/messages.ts'

vi.mock('../src/mobile/api.ts', () => ({
  fetchWorkspaceRoster: vi.fn(),
  listSessions: vi.fn(),
  searchSessions: vi.fn(),
  createSession: vi.fn(),
  pageSessions: vi.fn(),
  prompt: vi.fn(),
  modelCatalog: vi.fn(),
  selectModel: vi.fn(),
  renameSession: vi.fn(),
}))

// The page-lifetime live-event client is created inside App; the hoisted stub
// records instances so tests can drive the follow snapshot and live frames of
// the chat that is currently on screen. Listener faces stay structural so the
// hoisted block never references the mocked module's types.
const { StubEventsClient } = vi.hoisted(() => {
  class StubEventsClient {
    static instances: StubEventsClient[] = []
    frameListeners = new Set<(frame: { sessionId: string; event: unknown }) => void>()
    snapshotListeners = new Set<(snapshot: unknown) => void>()
    statusListeners = new Set<(status: string) => void>()
    constructor() {
      StubEventsClient.instances.push(this)
    }
    onFrame(listener: (frame: { sessionId: string; event: unknown }) => void): () => void {
      this.frameListeners.add(listener)
      return () => { this.frameListeners.delete(listener) }
    }
    onSnapshot(listener: (snapshot: unknown) => void): () => void {
      this.snapshotListeners.add(listener)
      return () => { this.snapshotListeners.delete(listener) }
    }
    onStatus(listener: (status: string) => void): () => void {
      this.statusListeners.add(listener)
      return () => { this.statusListeners.delete(listener) }
    }
    start(): void {}
    stop(): void {}
    observe(): void {}
    resumes = 0
    resume(): void { this.resumes += 1 }
    emit(frame: { type?: unknown; sessionId: string; event: unknown }): void {
      act(() => { for (const listener of [...this.frameListeners]) listener(frame) })
    }
    emitSnapshot(snapshot: unknown): void {
      act(() => { for (const listener of [...this.snapshotListeners]) listener(snapshot) })
    }
    emitStatus(status: string): void {
      act(() => { for (const listener of [...this.statusListeners]) listener(status) })
    }
  }
  return { StubEventsClient }
})

vi.mock('../src/mobile/events.ts', () => ({ EventsClient: StubEventsClient }))

/** The stub satisfies the client face at runtime; the real class is the declared prop type. */
function asEventsClient(stub: InstanceType<typeof StubEventsClient>): EventsClient {
  return stub as unknown as EventsClient
}

const mockFetchWorkspaceRoster = vi.mocked(fetchWorkspaceRoster)
const mockListSessions = vi.mocked(listSessions)
const mockSearchSessions = vi.mocked(searchSessions)
const mockCreateSession = vi.mocked(createSession)
const mockPageSessions = vi.mocked(pageSessions)
const mockPrompt = vi.mocked(prompt)
const mockModelCatalog = vi.mocked(modelCatalog)
const mockSelectModel = vi.mocked(selectModel)
const mockRenameSession = vi.mocked(renameSession)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
  StubEventsClient.instances.length = 0
})

function workspace(id: string, title: string, sessionIds: string[]): WorkspaceRow {
  return { workspaceId: id, path: `/home/dev/${id}`, title, sessionIds, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
}

function sessionRow(id: string, title: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { sessionId: id, updatedAt: 1_700_000_000_000, running: false, blank: false, cwd: `/home/dev/${id}`, projections: { values: { title } }, ...overrides }
}

function userEvent(seq: number, text: string): WireEvent {
  return { type: 'user/message', seq, time: 1_700_000_000_000, data: { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: {} } }
}

function assistantEvent(seq: number, text: string): WireEvent {
  return { type: 'assistant/message', seq, time: 1_700_000_000_000, data: { turn: 1, step: 0, message: { id: `a${seq}`, content: [{ type: 'text', text }] } } }
}

function snapshotFrame(records: WireEvent[], options: { cursor?: number; hasMore?: boolean } = {}): SessionSnapshotFrame {
  const cursor = options.cursor ?? records.at(-1)?.seq ?? 0
  return {
    type: 'session/snapshot',
    sessionId: 's1',
    cursor,
    hasMore: options.hasMore ?? false,
    projections: { asOfSeq: cursor, values: {} },
    records,
  }
}

const directory: ModelCatalog = {
  default: { provider: 'deepseek', model: 'deepseek-chat' },
  groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }],
  failures: [],
}

const multiDirectory: ModelCatalog = {
  default: { provider: 'deepseek', model: 'deepseek-chat' },
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-r1', name: 'DeepSeek R1' }],
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: [{ id: 'claude-sonnet', name: 'Claude Sonnet' }, { id: 'claude-opus', name: 'Claude Opus' }],
    },
  ],
  failures: [],
}

/** The live-event client instance App mounted (one per render). */
function lastEventsClient(): InstanceType<typeof StubEventsClient> {
  const instances = StubEventsClient.instances
  const instance = instances[instances.length - 1]
  if (instance === undefined) throw new Error('no EventsClient mounted')
  return instance
}

describe('App state machine', () => {
  it('navigates workspaces → sessions → chat and back', async () => {
    const w1 = workspace('w1', 'project-alpha', ['s1'])
    mockFetchWorkspaceRoster.mockResolvedValue({ ok: true, value: [w1] })
    mockListSessions.mockResolvedValue({ ok: true, value: [sessionRow('s1', '我的项目')] })
    mockPrompt.mockResolvedValue({ ok: true, value: { accepted: true } })

    render(<App />)

    expect(await screen.findByText('project-alpha')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /project-alpha/ }))

    expect(await screen.findByRole('button', { name: /\+ 新建会话/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /我的项目/ }))

    expect(await screen.findByPlaceholderText('输入消息，Enter 发送…')).toBeTruthy()
    // The chat fills from the follow snapshot of the mounted events client.
    lastEventsClient().emitSnapshot(snapshotFrame([userEvent(1, '你好'), assistantEvent(2, '你好，有什么可以帮你？')]))
    expect(await screen.findByText('你好，有什么可以帮你？')).toBeTruthy()

    // Back to sessions, then back to workspaces.
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(await screen.findByRole('button', { name: /\+ 新建会话/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(await screen.findByText('project-alpha')).toBeTruthy()
  })

  it('resumes the live-event client when the page returns to the foreground', () => {
    mockFetchWorkspaceRoster.mockResolvedValue({ ok: true, value: [] })
    render(<App />)
    const client = lastEventsClient()
    expect(client.resumes).toBe(0)

    const setVisibility = (value: string): void => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value })
    }
    // Hidden transitions must not dial.
    setVisibility('hidden')
    fireEvent(document, new Event('visibilitychange'))
    expect(client.resumes).toBe(0)
    // The visible transition is the one deterministic re-sync moment: a
    // suspended mobile page loses frames (and often the socket) silently.
    setVisibility('visible')
    fireEvent(document, new Event('visibilitychange'))
    expect(client.resumes).toBe(1)
    // A bfcache restore delivers pageshow with persisted=true.
    fireEvent(window, Object.assign(new Event('pageshow'), { persisted: true }))
    expect(client.resumes).toBe(2)
  })
})

describe('WorkspaceView', () => {
  it('renders the workspace roster', async () => {
    mockFetchWorkspaceRoster.mockResolvedValue({ ok: true, value: [workspace('w1', '项目甲', []), workspace('w2', '项目乙', [])] })
    const { container } = render(<WorkspaceView onPick={() => {}} />)
    await screen.findByText('项目甲')
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('renders an error state with retry', async () => {
    mockFetchWorkspaceRoster.mockResolvedValue({ ok: false, error: { code: 'http', message: 'HTTP 403' } })
    render(<WorkspaceView onPick={() => {}} />)
    expect(await screen.findByText(/加载失败：HTTP 403/)).toBeTruthy()
  })
})

describe('SessionListView', () => {
  it('shows only the sessions owned by the workspace', async () => {
    const w1 = workspace('w1', '项目甲', ['s1', 's3'])
    mockListSessions.mockResolvedValue({ ok: true, value: [sessionRow('s1', 'A'), sessionRow('s2', 'B'), sessionRow('s3', 'C')] })
    mockFetchWorkspaceRoster.mockResolvedValue({ ok: true, value: [w1] })
    render(<SessionListView workspace={w1} onBack={() => {}} onPick={() => {}} />)
    expect(await screen.findByText('A')).toBeTruthy()
    expect(screen.queryByText('B')).toBeNull()
    expect(screen.getByText('C')).toBeTruthy()
  })

  it('creates a session in the workspace and opens it', async () => {
    const w1 = workspace('w1', '项目甲', [])
    mockListSessions.mockResolvedValue({ ok: true, value: [] })
    mockFetchWorkspaceRoster.mockResolvedValue({ ok: true, value: [w1] })
    mockCreateSession.mockResolvedValue({ ok: true, value: { sessionId: 's9' } })
    const onPick = vi.fn()
    render(<SessionListView workspace={w1} onBack={() => {}} onPick={onPick} />)
    await screen.findByRole('button', { name: /\+ 新建会话/ })
    fireEvent.click(screen.getByRole('button', { name: /\+ 新建会话/ }))
    await waitFor(() => { expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's9', blank: true })) })
  })

  it('searches all sessions and opens a hit', async () => {
    const w1 = workspace('w1', '项目甲', [])
    mockListSessions.mockResolvedValue({ ok: true, value: [] })
    mockFetchWorkspaceRoster.mockResolvedValue({ ok: true, value: [w1] })
    const hit: SessionSearchItem = { sessionId: 's42', snippet: '权限检查片段' }
    mockSearchSessions.mockResolvedValue({ ok: true, value: [hit] })
    const onPick = vi.fn()
    render(<SessionListView workspace={w1} onBack={() => {}} onPick={onPick} />)
    fireEvent.change(screen.getByPlaceholderText('搜索全部会话…'), { target: { value: '权限' } })
    await screen.findByText('权限检查片段')
    fireEvent.click(screen.getByRole('button', { name: /权限检查片段/ }))
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's42' }))
  })
})

describe('ChatView', () => {
  const session = { sessionId: 's1', title: '我的项目', cwd: '/home/dev/s1', updatedAt: 1_700_000_000_000, running: false, blank: false }

  it('renders the follow snapshot, sends a prompt, and folds live events', async () => {
    mockPrompt.mockResolvedValue({ ok: true, value: { accepted: true } })
    const live = new StubEventsClient()
    render(<ChatView session={session} events={asEventsClient(live)} onBack={() => { }} />)

    live.emitSnapshot(snapshotFrame([userEvent(1, '你好'), assistantEvent(2, '收到')]))
    expect(await screen.findByText('你好')).toBeTruthy()
    expect(screen.getByText('收到')).toBeTruthy()

    // Live streaming: a new turn's chunk folds in as a pending assistant message.
    live.emit({
      type: 'session/event',
      sessionId: 's1',
      event: { type: 'user/message', seq: 3, time: 1_700_000_000_001, data: { id: 'u3', role: 'user', content: [{ type: 'text', text: '再来' }], source: {} } },
    })
    live.emit({
      type: 'session/event',
      sessionId: 's1',
      event: { type: 'assistant/chunk', seq: 4, time: 1_700_000_000_002, data: { turn: 2, step: 0, chunk: { type: 'text-delta', index: 0, text: '正在' } } },
    })
    await screen.findByText('正在')

    // Send a prompt through session.prompt.
    fireEvent.change(screen.getByPlaceholderText('输入消息，Enter 发送…'), { target: { value: '继续' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => { expect(mockPrompt).toHaveBeenCalledWith('s1', '继续') })
    expect(screen.getByPlaceholderText('输入消息，Enter 发送…')).toHaveProperty('value', '')
  })

  it('keeps a live frame that arrives before the follow snapshot resolves', async () => {
    const live = new StubEventsClient()
    render(<ChatView session={session} events={asEventsClient(live)} onBack={() => { }} />)
    // A live frame lands before the snapshot — the snapshot and frame legs race.
    // It must survive the tail's replace.
    live.emit({
      type: 'session/event',
      sessionId: 's1',
      event: { type: 'user/message', seq: 3, time: 1_700_000_000_001, data: { id: 'u3', role: 'user', content: [{ type: 'text', text: '竞态帧' }], source: {} } },
    })
    live.emitSnapshot(snapshotFrame([userEvent(1, '你好'), userEvent(2, '收到')]))
    expect(await screen.findByText('你好')).toBeTruthy()
    expect(screen.getByText('收到')).toBeTruthy()
    expect(screen.getByText('竞态帧')).toBeTruthy()
  })

  it('shows the transport banner while down before the snapshot, and clears it on reconnect', async () => {
    const live = new StubEventsClient()
    render(<ChatView session={session} events={asEventsClient(live)} onBack={() => { }} />)
    live.emitStatus('down')
    expect(await screen.findByText('实时连接不可用，正在重试…')).toBeTruthy()
    live.emitSnapshot(snapshotFrame([userEvent(1, '你好')]))
    expect(await screen.findByText('你好')).toBeTruthy()
    expect(screen.queryByText('实时连接不可用，正在重试…')).toBeNull()
  })

  it('shows the stall line only after the transport stays non-open past the banner delay', () => {
    vi.useFakeTimers()
    const live = new StubEventsClient()
    render(<ChatView session={session} events={asEventsClient(live)} onBack={() => { }} />)
    live.emitSnapshot(snapshotFrame([userEvent(1, '你好')]))
    expect(screen.getByText('你好')).toBeTruthy()

    // A healthy idle recycle passes through down → connecting → open within
    // one round trip and must not flash the stall line.
    live.emitStatus('down')
    expect(screen.queryByText('实时连接已断开，正在重连…')).toBeNull()
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.queryByText('实时连接已断开，正在重连…')).toBeNull()
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(screen.getByText('实时连接已断开，正在重连…')).toBeTruthy()

    live.emitStatus('open')
    expect(screen.queryByText('实时连接已断开，正在重连…')).toBeNull()
    vi.useRealTimers()
  })

  it('derives the current model from the snapshot projection', async () => {
    mockModelCatalog.mockResolvedValue({ ok: true, value: directory })
    mockSelectModel.mockResolvedValue({ ok: true, value: { provider: 'deepseek', model: 'deepseek-chat' } })
    const live = new StubEventsClient()
    render(<ChatView session={session} events={asEventsClient(live)} onBack={() => { }} />)
    live.emitSnapshot({
      ...snapshotFrame([]),
      projections: { asOfSeq: 0, values: { modelSelection: { lastUsed: null, next: { provider: 'deepseek', model: 'deepseek-chat' } } } },
    })
    expect(await screen.findByText('deepseek-chat')).toBeTruthy()
  })

  it('loads older pages below the snapshot cursor', async () => {
    mockPageSessions.mockResolvedValue({ ok: true, value: { events: [userEvent(1, '更早')], hasMore: false } })
    const live = new StubEventsClient()
    render(<ChatView session={session} events={asEventsClient(live)} onBack={() => { }} />)
    live.emitSnapshot(snapshotFrame([assistantEvent(2, '收到')], { cursor: 5, hasMore: true }))
    fireEvent.click(await screen.findByRole('button', { name: '加载更早的消息' }))
    await screen.findByText('更早')
    expect(mockPageSessions).toHaveBeenCalledWith('s1', 5, 2)
  })

  it('switches the model through the bottom sheet', async () => {
    mockModelCatalog.mockResolvedValue({ ok: true, value: directory })
    mockSelectModel.mockResolvedValue({ ok: true, value: { provider: 'deepseek', model: 'deepseek-chat' } })
    const live = new StubEventsClient()
    render(<ChatView session={session} events={asEventsClient(live)} onBack={() => { }} />)
    live.emitSnapshot(snapshotFrame([]))

    fireEvent.click(await screen.findByRole('button', { name: /模型/ }))
    expect(await screen.findByText('DeepSeek Chat')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /DeepSeek Chat/ }))
    await waitFor(() => {
      expect(mockSelectModel).toHaveBeenCalledWith('s1', { provider: 'deepseek', model: 'deepseek-chat' })
    })
  })

  it('filters the model sheet by provider and model name', async () => {
    mockModelCatalog.mockResolvedValue({ ok: true, value: multiDirectory })
    mockSelectModel.mockResolvedValue({ ok: true, value: { provider: 'deepseek', model: 'deepseek-chat' } })
    const live = new StubEventsClient()
    render(<ChatView session={session} events={asEventsClient(live)} onBack={() => { }} />)
    live.emitSnapshot(snapshotFrame([]))

    fireEvent.click(await screen.findByRole('button', { name: /模型/ }))
    await screen.findByText('DeepSeek Chat')
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'sonnet' } })
    expect(screen.queryByText('DeepSeek Chat')).toBeNull()
    expect(screen.getByText('Claude Sonnet')).toBeTruthy()
    expect(screen.queryByText('Claude Opus')).toBeNull()
    fireEvent.change(search, { target: { value: 'anthropic' } })
    expect(screen.getByText('Claude Sonnet')).toBeTruthy()
    expect(screen.getByText('Claude Opus')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText('没有匹配的模型')).toBeTruthy()
  })

  it('shows a recently used section and records an accepted pick', async () => {
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify([
      { provider: 'anthropic', model: 'claude-opus' },
      { provider: 'old', model: 'gone' },
    ]))
    mockModelCatalog.mockResolvedValue({ ok: true, value: multiDirectory })
    mockSelectModel.mockResolvedValue({ ok: true, value: { provider: 'deepseek', model: 'deepseek-chat' } })
    const live = new StubEventsClient()
    render(<ChatView session={session} events={asEventsClient(live)} onBack={() => { }} />)
    live.emitSnapshot(snapshotFrame([]))

    fireEvent.click(await screen.findByRole('button', { name: /模型/ }))
    await screen.findByText('最近使用')
    expect(screen.queryByText('gone')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: /Claude Opus/ })[0]!)
    await waitFor(() => {
      expect(mockSelectModel).toHaveBeenCalledWith('s1', { provider: 'anthropic', model: 'claude-opus' })
      expect(readRecentModels()[0]).toEqual({ provider: 'anthropic', model: 'claude-opus' })
    })
  })

  it('collapses and expands a provider group in the sheet', async () => {
    mockModelCatalog.mockResolvedValue({ ok: true, value: multiDirectory })
    mockSelectModel.mockResolvedValue({ ok: true, value: { provider: 'deepseek', model: 'deepseek-chat' } })
    const live = new StubEventsClient()
    render(<ChatView session={session} events={asEventsClient(live)} onBack={() => { }} />)
    live.emitSnapshot(snapshotFrame([]))

    fireEvent.click(await screen.findByRole('button', { name: /模型/ }))
    await screen.findByText('DeepSeek Chat')
    fireEvent.click(screen.getByRole('button', { name: /DeepSeek/, expanded: true }))
    expect(screen.queryByRole('button', { name: /DeepSeek Chat/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /DeepSeek/, expanded: false }))
    expect(screen.getByRole('button', { name: /DeepSeek Chat/ })).toBeTruthy()
  })

  it('renames the session through session.rename', async () => {
    mockRenameSession.mockResolvedValue({ ok: true, value: { title: '新标题', seq: 9 } })
    const live = new StubEventsClient()
    render(<ChatView session={session} events={asEventsClient(live)} onBack={() => { }} />)
    live.emitSnapshot(snapshotFrame([]))

    fireEvent.click(screen.getByRole('button', { name: '重命名会话' }))
    const input = screen.getByPlaceholderText('输入新标题…')
    fireEvent.change(input, { target: { value: '新标题' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(mockRenameSession).toHaveBeenCalledWith('s1', '新标题') })
    expect(await screen.findByText('新标题')).toBeTruthy()
  })
})

describe('fold helpers', () => {
  it('derives a session view title from the persisted projection', () => {
    const view = toSessionView(sessionRow('s1', '题目', { cwd: '/home/dev/other' }))
    expect(view.title).toBe('题目')
    expect(view.cwd).toBe('/home/dev/other')
  })

  it('folds an incremental chunk onto an existing list without duplication', () => {
    const first = foldEvents([userEvent(1, '你好')])
    const next = foldEvents([{ type: 'assistant/chunk', seq: 2, time: 0, data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } } }], first)
    expect(next.map(message => message.text)).toEqual(['你好', 'hi'])
    const replayed = foldEvents([{ type: 'assistant/chunk', seq: 2, time: 0, data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } } }], next)
    expect(replayed.map(message => message.text)).toEqual(['你好', 'hi'])
  })

  it('drops a packed chunk-row record: the pre-format-v2 transport has no codec on this side', () => {
    const records = [
      { type: 'event', event: userEvent(1, '你好') },
      {
        type: 'chunks',
        event: {
          type: 'chunkrow/text-chunks',
          seq: 2,
          time: 1_000,
          data: { turn: 1, step: 0, index: 0, dt: [5, 7], texts: ['你', '好', '！'] },
        },
      },
    ]
    const page = foldEvents(recordsToWireEvents(records))
    expect(page.map(message => message.text)).toEqual(['你好'])
  })

  it('drops malformed records instead of blanking the page', () => {
    const records = [
      { type: 'event', event: userEvent(1, '你好') },
      { type: 'chunks', event: { type: 'chunkrow/text-chunks', seq: 'x', time: 0, data: {} } },
      { type: 'chunks', event: { type: 'chunkrow/unknown-tag', seq: 2, time: 0, data: {} } },
      'garbage',
    ]
    expect(recordsToWireEvents(records).map(event => event.seq)).toEqual([1])
  })
})
