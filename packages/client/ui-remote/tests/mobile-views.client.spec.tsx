// @vitest-environment jsdom
/** Mobile views: App navigation, workspace/session lists, and the chat surface (history, live events, prompt, model sheet, rename). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App, toSessionView } from '../src/mobile/views/App.tsx'
import { WorkspaceView } from '../src/mobile/views/WorkspaceView.tsx'
import { SessionListView } from '../src/mobile/views/SessionListView.tsx'
import { ChatView } from '../src/mobile/views/ChatView.tsx'
import type { EventsClient, SessionEventFrame } from '../src/mobile/events.ts'
import type { WireEvent } from '../src/mobile/messages.ts'
import type { HistoryPage, SessionModels, SessionSearchItem, SessionSummary, WorkspaceView as WorkspaceRow } from '../src/mobile/api.ts'
import { createSession, history, listSessions, listWorkspaces, models, prompt, renameSession, searchSessions, selectModel } from '../src/mobile/api.ts'
import { foldEvents } from '../src/mobile/messages.ts'

vi.mock('../src/mobile/api.ts', () => ({
  listWorkspaces: vi.fn(),
  listSessions: vi.fn(),
  searchSessions: vi.fn(),
  createSession: vi.fn(),
  history: vi.fn(),
  prompt: vi.fn(),
  models: vi.fn(),
  selectModel: vi.fn(),
  renameSession: vi.fn(),
}))

// The page-lifetime live-event client is created inside App; a no-op stub keeps
// jsdom from dialing out to a WebSocket during navigation tests.
vi.mock('../src/mobile/events.ts', () => ({
  EventsClient: class {
    start(): void {}
    stop(): void {}
    observe(): void {}
    onFrame(): () => void { return () => {} }
  },
}))

const mockListWorkspaces = vi.mocked(listWorkspaces)
const mockListSessions = vi.mocked(listSessions)
const mockSearchSessions = vi.mocked(searchSessions)
const mockCreateSession = vi.mocked(createSession)
const mockHistory = vi.mocked(history)
const mockPrompt = vi.mocked(prompt)
const mockModels = vi.mocked(models)
const mockSelectModel = vi.mocked(selectModel)
const mockRenameSession = vi.mocked(renameSession)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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

function historyPage(events: WireEvent[], hasMore = false): HistoryPage {
  return { events: events.map(event => ({ event })), hasMore }
}

const directory: SessionModels = {
  current: { provider: 'deepseek', model: 'deepseek-chat' },
  routable: true,
  groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }],
  failures: [],
}

/** A hand-built live-event client stub that records subscribers for later dispatch. */
function eventsStub() {
  const listeners = new Set<(frame: SessionEventFrame) => void>()
  return {
    client: {
      onFrame: (listener: (frame: SessionEventFrame) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    } as unknown as EventsClient,
    emit(frame: SessionEventFrame) {
      act(() => { for (const listener of [...listeners]) listener(frame) })
    },
  }
}

describe('App state machine', () => {
  it('navigates workspaces → sessions → chat and back', async () => {
    const w1 = workspace('w1', 'project-alpha', ['s1'])
    mockListWorkspaces.mockResolvedValue({ ok: true, value: [w1] })
    mockListSessions.mockResolvedValue({ ok: true, value: [sessionRow('s1', '我的项目')] })
    mockHistory.mockResolvedValue({ ok: true, value: historyPage([userEvent(1, '你好'), assistantEvent(2, '你好，有什么可以帮你？')]) })
    mockModels.mockResolvedValue({ ok: true, value: directory })
    mockPrompt.mockResolvedValue({ ok: true, value: { accepted: true } })

    render(<App />)

    expect(await screen.findByText('project-alpha')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /project-alpha/ }))

    expect(await screen.findByRole('button', { name: /\+ 新建会话/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /我的项目/ }))

    expect(await screen.findByPlaceholderText('输入消息，Enter 发送…')).toBeTruthy()
    expect(screen.getByText('你好')).toBeTruthy()
    expect(screen.getByText('你好，有什么可以帮你？')).toBeTruthy()

    // Back to sessions, then back to workspaces.
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(await screen.findByRole('button', { name: /\+ 新建会话/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(await screen.findByText('project-alpha')).toBeTruthy()
  })
})

describe('WorkspaceView', () => {
  it('renders the workspace roster', async () => {
    mockListWorkspaces.mockResolvedValue({ ok: true, value: [workspace('w1', '项目甲', []), workspace('w2', '项目乙', [])] })
    const { container } = render(<WorkspaceView onPick={() => {}} />)
    await screen.findByText('项目甲')
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('renders an error state with retry', async () => {
    mockListWorkspaces.mockResolvedValue({ ok: false, error: { code: 'http', message: 'HTTP 403' } })
    render(<WorkspaceView onPick={() => {}} />)
    expect(await screen.findByText(/加载失败：HTTP 403/)).toBeTruthy()
  })
})

describe('SessionListView', () => {
  it('shows only the sessions owned by the workspace', async () => {
    const w1 = workspace('w1', '项目甲', ['s1', 's3'])
    mockListSessions.mockResolvedValue({ ok: true, value: [sessionRow('s1', 'A'), sessionRow('s2', 'B'), sessionRow('s3', 'C')] })
    mockListWorkspaces.mockResolvedValue({ ok: true, value: [w1] })
    render(<SessionListView workspace={w1} onBack={() => {}} onPick={() => {}} />)
    expect(await screen.findByText('A')).toBeTruthy()
    expect(screen.queryByText('B')).toBeNull()
    expect(screen.getByText('C')).toBeTruthy()
  })

  it('creates a session in the workspace and opens it', async () => {
    const w1 = workspace('w1', '项目甲', [])
    mockListSessions.mockResolvedValue({ ok: true, value: [] })
    mockListWorkspaces.mockResolvedValue({ ok: true, value: [w1] })
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
    mockListWorkspaces.mockResolvedValue({ ok: true, value: [w1] })
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

  it('renders history, sends a prompt, and folds live events', async () => {
    mockHistory.mockResolvedValue({ ok: true, value: historyPage([userEvent(1, '你好'), assistantEvent(2, '收到')]) })
    mockModels.mockResolvedValue({ ok: true, value: directory })
    mockPrompt.mockResolvedValue({ ok: true, value: { accepted: true } })
    const live = eventsStub()
    render(<ChatView session={session} events={live.client} onBack={() => {}} />)

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

  it('switches the model through the bottom sheet', async () => {
    mockHistory.mockResolvedValue({ ok: true, value: historyPage([]) })
    mockModels.mockResolvedValue({ ok: true, value: directory })
    mockSelectModel.mockResolvedValue({ ok: true, value: { provider: 'deepseek', model: 'deepseek-chat' } })
    const live = eventsStub()
    render(<ChatView session={session} events={live.client} onBack={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: /模型/ }))
    expect(await screen.findByText('DeepSeek Chat')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /DeepSeek Chat/ }))
    await waitFor(() => {
      expect(mockSelectModel).toHaveBeenCalledWith('s1', { provider: 'deepseek', model: 'deepseek-chat' })
    })
  })

  it('renames the session through session.rename', async () => {
    mockHistory.mockResolvedValue({ ok: true, value: historyPage([]) })
    mockModels.mockResolvedValue({ ok: true, value: directory })
    mockRenameSession.mockResolvedValue({ ok: true, value: { title: '新标题', seq: 9 } })
    const live = eventsStub()
    render(<ChatView session={session} events={live.client} onBack={() => {}} />)

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
})
