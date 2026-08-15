import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileApiClient } from '../src/client.ts'
import { VoiceChatController } from '../src/voice-chat.ts'
import type {
  RecognizerHandlers, SpeechRecognizerPort, SpeechSpeakerPort, VoiceChatSnapshot,
} from '../src/types.ts'
import { echoServerError, echoServerResponse, fakeFetch, historyEntry, jsonResponse, sessionEvent, socketFactoryRig, userMessageData, type FakeFetch, type SocketMock } from './helpers.client.ts'

const BASE = 'https://fake-slug.trycloudflare.com'

interface FakeRecognizer extends SpeechRecognizerPort {
  startCalls: { handlers: RecognizerHandlers; language: string }[]
  stopCalls: number
  interim(text: string): void
  final(text: string): void
  error(message: string): void
}

interface FakeSpeaker extends SpeechSpeakerPort {
  spoken: { text: string; language: string }[]
}

interface Rig {
  controller: VoiceChatController
  fetch: FakeFetch
  sockets: SocketMock[]
  recognizer: FakeRecognizer
  speaker: FakeSpeaker
  snapshots: VoiceChatSnapshot[]
  historyRoute(body: (init: RequestInit | undefined) => unknown): void
  promptBody(): { method: string; payload: Record<string, unknown> }
  promptBodies(): { method: string; payload: Record<string, unknown> }[]
  latest(): VoiceChatSnapshot
}

interface RigOptions {
  autoSpeak?: boolean
  /** session.list answer: an existing summary id or none. */
  existingSessionId?: string
  /** Preset the session on the controller (default true); false exercises the list-reuse path. */
  preset?: boolean
  /** events served by session.history. */
  historyEvents?: unknown[]
  /** custom prompt handler. */
  prompt?: (init: RequestInit | undefined) => Response | Promise<Response>
}

function summaryOf(sessionId: string): unknown {
  return { sessionId, updatedAt: 1, running: false, blank: false }
}

function defaultHistory(): unknown[] {
  return [
    historyEntry('turn/start', 1, { turn: 1 }),
    historyEntry('step/start', 2, { turn: 1, step: 1 }),
    historyEntry('user/message', 3, userMessageData('历史提问')),
    historyEntry('assistant/chunk', 4, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '历史回答。' } }),
    historyEntry('tool/call', 5, { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' }),
    historyEntry('tool/result', 6, { turn: 1, step: 1, message: { id: 'r1', role: 'user', content: [{ type: 'tool-result' }], source: { kind: 'tool' } } }, { sourceEventSeqs: [5] }),
    historyEntry('turn/end', 7, { turn: 1, reason: 'done' }),
  ]
}

function rig(options: RigOptions = {}): Rig {
  const fetch = fakeFetch()
  const sockets: SocketMock[] = []
  const historyEvents = options.historyEvents ?? defaultHistory()
  fetch.routes.set('/api/session.list', init => echoServerResponse(init, {
    items: options.existingSessionId === undefined ? [] : [summaryOf(options.existingSessionId)],
  }))
  fetch.routes.set('/api/session.create', init => echoServerResponse(init, { sessionId: 's-new' }))
  fetch.routes.set('/api/session.history', init => echoServerResponse(init, { events: historyEvents, hasMore: false }))
  fetch.routes.set('/api/session.prompt', options.prompt ?? (init => echoServerResponse(init, { accepted: true })))
  fetch.routes.set('/api/session.cancel', init => echoServerResponse(init, { accepted: true }))
  fetch.routes.set('/api/respond', () => jsonResponse({ accepted: true }))
  const socketRig = socketFactoryRig()
  const openSocket = (url: string, headers: Record<string, string>): SocketMock => {
    const socket = socketRig.factory(url, headers)
    sockets.push(socket)
    queueMicrotask(() => { socket.open() })
    return socket
  }
  const recognizer: FakeRecognizer = {
    available: true,
    startCalls: [],
    stopCalls: 0,
    interim(text) { this.startCalls[0]?.handlers.onInterim(text) },
    final(text) { this.startCalls[0]?.handlers.onFinal(text) },
    error(message) { this.startCalls[0]?.handlers.onError(message) },
    async start(handlers, language) { this.startCalls.push({ handlers, language }) },
    async stop() { this.stopCalls += 1 },
  }
  const speaker: FakeSpeaker = {
    spoken: [],
    speak(text, language, onDone) {
      this.spoken.push({ text, language })
      onDone()
    },
    stop() { /* the recording queue asserts via its own port state */ },
  }
  const snapshots: VoiceChatSnapshot[] = []
  const controller = new VoiceChatController({
    client: new MobileApiClient({ baseUrl: BASE, cookie: 'c1', fetchImpl: fetch.impl, openSocket }),
    recognizer,
    speaker,
    ...options.autoSpeak === undefined ? {} : { autoSpeak: options.autoSpeak },
    ...(options.existingSessionId === undefined || options.preset === false) ? {} : { sessionId: options.existingSessionId },
    onSnapshot: snapshot => snapshots.push(snapshot),
  })
  return {
    controller, fetch, sockets, recognizer, speaker, snapshots,
    historyRoute: body => fetch.routes.set('/api/session.history', init => echoServerResponse(init, body(init))),
    promptBody: () => {
      const call = fetch.calls.find(entry => entry.url.endsWith('/api/session.prompt'))!
      const body = JSON.parse(call.init?.body as string) as { method: string; payload: Record<string, unknown> }
      return { method: body.method, payload: body.payload }
    },
    promptBodies: () => fetch.calls
      .filter(entry => entry.url.endsWith('/api/session.prompt'))
      .map((entry) => {
        const body = JSON.parse(entry.init?.body as string) as { method: string; payload: Record<string, unknown> }
        return { method: body.method, payload: body.payload }
      }),
    latest: () => snapshots[snapshots.length - 1]!,
  }
}

async function settle(r: Rig): Promise<void> {
  r.controller.connect()
  await vi.waitFor(() => { expect(r.latest().connection).toBe('online') })
}

function liveEvent(seq: number, data: unknown, extra: Record<string, unknown> = {}): unknown {
  return { type: 'session/event', sessionId: 's1', event: { ...sessionEvent('user/message', seq, data), ...extra } }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('VoiceChatController', () => {
  it('reuses the listed session and rebuilds the view from history without speaking it', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    expect(r.latest().sessionId).toBe('s1')
    expect(r.latest().messages).toEqual([
      { kind: 'user', text: '历史提问' },
      { kind: 'assistant', text: '历史回答。', complete: true },
    ])
    expect(r.latest().toolLines).toEqual([{ id: 'call-1', name: 'bash', done: true }])
    expect(r.latest().turnRunning).toBe(false)
    expect(r.speaker.spoken).toEqual([])
    r.controller.dispose()
  })

  it('reuses the listed session when none was preset', async () => {
    const r = rig({ existingSessionId: 's1', preset: false })
    r.controller.connect()
    await vi.waitFor(() => { expect(r.latest().sessionId).toBe('s1') })
    expect(r.fetch.calls.filter(entry => entry.url.endsWith('/api/session.create'))).toHaveLength(0)
    r.controller.dispose()
  })

  it('creates a session when the host has none', async () => {
    const r = rig()
    await settle(r)
    expect(r.latest().sessionId).toBe('s-new')
    r.controller.dispose()
  })

  it('runs the voice round: interim, final auto-send, live fold, speak, turn end flush', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.controller.startListening()
    expect(r.recognizer.startCalls).toHaveLength(1)
    expect(r.recognizer.startCalls[0]?.language).toBe('zh-CN')
    r.recognizer.interim('你')
    expect(r.latest().interim).toBe('你')
    expect(r.latest().listener).toBe('listening')
    r.recognizer.final('你好')
    await vi.waitFor(() => { expect(r.latest().listener).toBe('processing') })
    expect(r.latest().messages.at(-1)).toEqual({ kind: 'user', text: '你好' })
    const sent = r.promptBody()
    expect(sent.method).toBe('session.prompt')
    expect(sent.payload).toMatchObject({ sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: '你好' }] })
    expect(sent.payload.clientTimeZone).toEqual(expect.any(String))
    r.sockets[0]!.push(liveEvent(8, userMessageData('你好'), { type: 'turn/start', data: { turn: 2 } }))
    r.sockets[0]!.push(liveEvent(9, userMessageData('你好')))
    r.sockets[0]!.push({ type: 'session/event', sessionId: 's1', event: sessionEvent('assistant/chunk', 10, { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '好的，' } }) })
    r.sockets[0]!.push({ type: 'session/event', sessionId: 's1', event: sessionEvent('assistant/chunk', 11, { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '收到' } }) })
    r.sockets[0]!.push({ type: 'session/event', sessionId: 's1', event: sessionEvent('turn/end', 12, { turn: 2, reason: 'done' }) })
    await vi.waitFor(() => { expect(r.latest().messages.at(-1)).toEqual({ kind: 'assistant', text: '好的，收到', complete: true }) })
    expect(r.speaker.spoken).toEqual([{ text: '好的，收到', language: 'zh-CN' }])
    expect(r.latest().turnRunning).toBe(false)
    expect(r.latest().listener).toBe('idle')
    r.controller.dispose()
  })

  it('dedupes the echoed user message and appends third-party user messages', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.controller.submitText('重复')
    r.controller.submitText('重复')
    await vi.waitFor(() => { expect(r.latest().messages.filter(message => message.kind === 'user' && message.text === '重复')).toHaveLength(2) })
    r.sockets[0]!.push(liveEvent(8, userMessageData('重复')))
    r.sockets[0]!.push(liveEvent(9, userMessageData('重复')))
    r.sockets[0]!.push(liveEvent(10, userMessageData('别人发的')))
    await vi.waitFor(() => { expect(r.latest().messages.some(message => message.kind === 'user' && message.text === '别人发的')).toBe(true) })
    expect(r.latest().messages.filter(message => message.kind === 'user' && message.text === '重复')).toHaveLength(2)
    r.controller.dispose()
  })

  it('dedupes echoes of different interleaved sends and later third-party repeats', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    // The history pair already carries one user message ('历史提问').
    r.controller.submitText('甲')
    r.controller.submitText('乙')
    await vi.waitFor(() => { expect(r.latest().messages.filter(message => message.kind === 'user')).toHaveLength(3) })
    r.sockets[0]!.push(liveEvent(8, userMessageData('甲')))
    r.sockets[0]!.push(liveEvent(9, userMessageData('乙')))
    await vi.waitFor(() => { expect(r.latest().messages.filter(message => message.kind === 'user')).toHaveLength(3) })
    // A third-party repeat of an already-echoed text is a real message.
    r.sockets[0]!.push(liveEvent(10, userMessageData('甲')))
    await vi.waitFor(() => { expect(r.latest().messages.filter(message => message.kind === 'user' && message.text === '甲')).toHaveLength(2) })
    r.controller.dispose()
  })

  it('skips events at or below the history watermark', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.sockets[0]!.push(liveEvent(7, userMessageData('重复的历史')))
    await vi.waitFor(() => { expect(r.latest().connection).toBe('online') })
    expect(r.latest().messages.some(message => message.kind === 'user' && message.text === '重复的历史')).toBe(false)
    r.controller.dispose()
  })

  it('barge-in: taking the mic cancels a running turn; a second tap is ignored', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.sockets[0]!.push(liveEvent(8, userMessageData('x'), { type: 'turn/start', data: { turn: 2 } }))
    await vi.waitFor(() => { expect(r.latest().turnRunning).toBe(true) })
    r.controller.startListening()
    await vi.waitFor(() => { expect(r.fetch.calls.some(entry => entry.url.endsWith('/api/session.cancel'))).toBe(true) })
    expect(r.recognizer.startCalls).toHaveLength(1)
    // A second tap while listening is ignored.
    r.controller.startListening()
    expect(r.recognizer.startCalls).toHaveLength(1)
    r.controller.dispose()
  })

  it('tap-again-to-send: stopListening finalizes and sends the recognized text', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.controller.startListening()
    r.recognizer.interim('未完成')
    r.controller.stopListening()
    expect(r.recognizer.stopCalls).toBe(1)
    expect(r.latest().interim).toBe('')
    // The device recognizer still delivers its final result after stop();
    // it flows through the normal onFinal -> auto-send path.
    expect(r.latest().listener).toBe('processing')
    r.recognizer.final('未完成')
    await vi.waitFor(() => {
      expect(r.latest().messages.some(message => message.kind === 'user' && message.text === '未完成')).toBe(true)
    })
    const bodies = r.promptBodies()
    const payload = bodies[bodies.length - 1]!.payload as { content: { type: string; text: string }[] }
    expect(payload.content[0]!.text).toBe('未完成')
    // A second final after the finalize is a stale duplicate.
    r.recognizer.final('第二次')
    expect(r.latest().messages.filter(message => message.kind === 'user' && message.text === '未完成')).toHaveLength(1)
    expect(r.latest().messages.some(message => message.text === '第二次')).toBe(false)
    // The sent turn's end returns the listener to idle.
    r.sockets[0]!.push({ type: 'session/event', sessionId: 's1', event: sessionEvent('turn/end', 9, { turn: 2, reason: 'done' }) })
    await vi.waitFor(() => { expect(r.latest().listener).toBe('idle') })
    r.controller.dispose()
  })

  it('ignores recognizer callbacks after dispose', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.controller.startListening()
    r.controller.dispose()
    // Late device events after teardown are dropped without side effects.
    r.recognizer.interim('迟到')
    r.recognizer.final('迟到')
    r.recognizer.error('迟到错误')
    expect(r.latest().messages.some(message => message.text === '迟到')).toBe(false)
    expect(r.latest().notice).toBeNull()
  })

  it('swallows a recognizer start or stop rejecting after dispose', async () => {
    // A start that rejects after dispose: the catch observes disposed and stays quiet.
    const r1 = rig({ existingSessionId: 's1' })
    await settle(r1)
    r1.recognizer.start = async (handlers, language) => {
      r1.recognizer.startCalls.push({ handlers, language })
      throw new Error('start failed')
    }
    r1.controller.startListening()
    r1.controller.dispose()
    await vi.waitFor(() => { expect(r1.recognizer.startCalls).toHaveLength(1) })
    // A stop that rejects after dispose: the finalize catch observes disposed.
    const r2 = rig({ existingSessionId: 's1' })
    await settle(r2)
    r2.recognizer.stop = async () => { r2.recognizer.stopCalls += 1; throw new Error('stop failed') }
    r2.controller.startListening()
    r2.controller.stopListening()
    r2.controller.dispose()
    await vi.waitFor(() => { expect(r2.recognizer.stopCalls).toBeGreaterThanOrEqual(1) })
  })

  it('surfaces business errors from the prompt', async () => {
    const r = rig({ existingSessionId: 's1', prompt: init => echoServerError(init, 'sessions are sad') })
    await settle(r)
    r.controller.startListening()
    r.recognizer.final('测试')
    await vi.waitFor(() => { expect(r.latest().notice).toBe('sessions are sad') })
    expect(r.latest().listener).toBe('idle')
    r.controller.dispose()
  })

  it('lands on needsPairing when the gate rejects the cookie', async () => {
    const r = rig({ existingSessionId: 's1', prompt: () => new Response('pairing hint', { status: 401 }) })
    await settle(r)
    r.controller.submitText('测试')
    await vi.waitFor(() => { expect(r.latest().connection).toBe('needsPairing') })
    expect(r.latest().notice).toBe('pairing expired')
    r.controller.dispose()
  })

  it('reports transport failures with context', async () => {
    const r = rig({ existingSessionId: 's1', prompt: () => { throw new TypeError('fetch failed') } })
    await settle(r)
    r.controller.submitText('测试')
    await vi.waitFor(() => { expect(r.latest().notice).toMatch(/send failed: TypeError: fetch failed/) })
    r.controller.dispose()
  })

  it('handles the approval lifecycle through respond', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.sockets[0]!.push({ type: 'approval/requested', sessionId: 's1', approvalId: 'ap1', toolName: 'bash' }, 'a1')
    await vi.waitFor(() => { expect(r.latest().pendingApproval).toEqual({ approvalId: 'ap1', toolName: 'bash' }) })
    r.controller.answerApproval('other', 'allowed-once')
    expect(r.fetch.calls.filter(entry => entry.url.endsWith('/api/respond'))).toHaveLength(0)
    r.controller.answerApproval('ap1', 'allowed-once')
    await vi.waitFor(() => { expect(r.latest().pendingApproval).toBeNull() })
    const respond = r.fetch.calls.find(entry => entry.url.endsWith('/api/respond'))!
    const body = JSON.parse(respond.init?.body as string) as { rpcId: string }
    expect(body).toMatchObject({
      type: 'client-response', rpcId: 'a1',
      result: { ok: true, value: { sessionId: 's1', approvalId: 'ap1', outcome: 'allowed-once' } },
    })
    r.sockets[0]!.push({ type: 'approval/resolved', sessionId: 's1', approvalId: 'ap1', outcome: 'allowed-once' })
    await vi.waitFor(() => { expect(r.latest().pendingApproval).toBeNull() })
    r.controller.dispose()
  })

  it('handles the question lifecycle through respond', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.sockets[0]!.push({
      type: 'question/requested', sessionId: 's1',
      questions: [
        { id: 'q1', question: '真的？', options: [{ label: '是' }, { label: '否' }] },
        { id: 'q2', question: '再说？' },
      ],
    }, 'q1')
    await vi.waitFor(() => { expect(r.latest().pendingQuestion).toMatchObject({
      questionRpcId: 'q1',
      questions: [
        { id: 'q1', question: '真的？', options: [{ label: '是' }, { label: '否' }] },
        { id: 'q2', question: '再说？', options: [] },
      ],
    }) })
    r.controller.answerQuestion('q1', [{ id: 'q1', selected: ['是'] }])
    await vi.waitFor(() => { expect(r.latest().pendingQuestion).toBeNull() })
    const respond = r.fetch.calls.find(entry => entry.url.endsWith('/api/respond'))!
    const body = JSON.parse(respond.init?.body as string) as { rpcId: string }
    expect(body).toMatchObject({
      type: 'client-response', rpcId: 'q1',
      result: { ok: true, value: { sessionId: 's1', answer: { answers: [{ id: 'q1', selected: ['是'] }] } } },
    })
    r.sockets[0]!.push({ type: 'question/resolved', sessionId: 's1', questionRpcId: 'q1', outcome: 'answered' })
    await vi.waitFor(() => { expect(r.latest().pendingQuestion).toBeNull() })
    r.controller.dispose()
  })

  it('surfaces stream errors as a notice', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.sockets[0]!.push({ type: 'stream/error', error: { code: 'internal', message: 'stream broke', details: {} } })
    await vi.waitFor(() => { expect(r.latest().notice).toBe('stream broke') })
    r.controller.dispose()
  })

  it('reconnects after a stream drop and fills the gap from history', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    const historyCalls = () => r.fetch.calls.filter(entry => entry.url.endsWith('/api/session.history')).length
    expect(historyCalls()).toBe(1)
    r.sockets[0]!.close()
    await vi.waitFor(() => { expect(r.latest().connection).toBe('reconnecting') })
    await vi.waitFor(() => { expect(r.sockets).toHaveLength(2) })
    await vi.waitFor(() => { expect(r.latest().connection).toBe('online') })
    await vi.waitFor(() => { expect(historyCalls()).toBe(2) })
    // A live event whose seq sits past the watermark applies exactly once.
    r.sockets[1]!.push(liveEvent(9, userMessageData('断线后的消息')))
    await vi.waitFor(() => { expect(r.latest().messages.some(message => message.kind === 'user' && message.text === '断线后的消息')).toBe(true) })
    r.controller.dispose()
  })

  it('setAutoSpeak(false) stops the active utterance', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    let stopped = false
    const original = r.speaker.speak.bind(r.speaker)
    r.speaker.speak = (text, language, onDone, onError) => {
      if (text === '第一句。') return // stays active until stopped
      original(text, language, onDone, onError)
    }
    r.speaker.stop = () => { stopped = true }
    r.sockets[0]!.push({ type: 'session/event', sessionId: 's1', event: sessionEvent('assistant/chunk', 8, { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '第一句。第二句。' } }) })
    await vi.waitFor(() => { expect(r.latest().speaking).toBe(true) })
    r.controller.setAutoSpeak(false)
    expect(stopped).toBe(true)
    expect(r.latest().speaking).toBe(false)
    r.controller.dispose()
  })

  it('honours setLanguage and setAutoSpeak', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.controller.setLanguage('en-US')
    expect(r.latest().language).toBe('en-US')
    r.controller.setAutoSpeak(false)
    expect(r.latest().autoSpeak).toBe(false)
    r.sockets[0]!.push({ type: 'session/event', sessionId: 's1', event: sessionEvent('assistant/chunk', 8, { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'silent。' } }) })
    await vi.waitFor(() => { expect(r.latest().messages.at(-1)).toMatchObject({ kind: 'assistant', text: 'silent。' }) })
    expect(r.speaker.spoken).toEqual([])
    r.controller.setAutoSpeak(true)
    expect(r.latest().autoSpeak).toBe(true)
    r.controller.dispose()
  })

  it('handles recognizer failures and empty finals without sending', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.controller.startListening()
    r.recognizer.final('   ')
    await vi.waitFor(() => { expect(r.latest().listener).toBe('idle') })
    expect(r.fetch.calls.filter(entry => entry.url.endsWith('/api/session.prompt'))).toHaveLength(0)
    r.controller.startListening()
    r.recognizer.error('no microphone')
    await vi.waitFor(() => { expect(r.latest().notice).toBe('no microphone') })
    expect(r.latest().listener).toBe('idle')
    r.controller.dispose()
  })

  it('recovers when the recognizer start rejects', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.recognizer.start = async () => { throw new Error('native rejected') }
    r.controller.startListening()
    await vi.waitFor(() => { expect(r.latest().listener).toBe('idle') })
    r.controller.dispose()
  })

  it('reports session-list failures and retries through create on send', async () => {
    const r = rig()
    r.fetch.routes.set('/api/session.list', () => { throw new TypeError('network down') })
    r.controller.connect()
    await vi.waitFor(() => { expect(r.latest().notice).toMatch(/session list failed: TypeError: network down/) })
    expect(r.latest().sessionId).toBe('')
    // The list recovers by send time; ensureSession creates the session.
    r.fetch.routes.set('/api/session.list', init => echoServerResponse(init, { items: [] }))
    r.controller.submitText('重试')
    await vi.waitFor(() => { expect(r.latest().sessionId).toBe('s-new') })
    r.controller.dispose()
  })

  it('surfaces create failures as a notice', async () => {
    const r = rig()
    r.fetch.routes.set('/api/session.create', init => echoServerError(init, 'cannot create'))
    r.controller.connect()
    await vi.waitFor(() => { expect(r.latest().notice).toBe('cannot create') })
    r.controller.dispose()
  })

  it('drops the dedupe entry when a prompt fails after its echo arrived', async () => {
    const r = rig({ existingSessionId: 's1' })
    r.fetch.routes.set('/api/session.prompt', () => new Promise((_resolve, reject) => {
      setTimeout(() => { reject(new TypeError('late failure')) }, 15)
    }))
    await settle(r)
    r.controller.submitText('迟到的失败')
    // The live echo arrives before the prompt RPC settles: it consumes the
    // dedupe entry, so the failure path finds nothing to drop.
    r.sockets[0]!.push(liveEvent(8, userMessageData('迟到的失败')))
    await vi.waitFor(() => { expect(r.latest().notice).toMatch(/send failed: TypeError: late failure/) })
    r.controller.dispose()
  })

  it('reports session-create transport failures with context', async () => {
    const r = rig()
    r.fetch.routes.set('/api/session.create', () => { throw new TypeError('create exploded') })
    r.controller.connect()
    await vi.waitFor(() => { expect(r.latest().notice).toMatch(/session create failed: TypeError: create exploded/) })
    r.controller.dispose()
  })

  it('reports history transport failures with context', async () => {
    const r = rig({ existingSessionId: 's1' })
    r.fetch.routes.set('/api/session.history', () => { throw new TypeError('history exploded') })
    r.controller.connect()
    await vi.waitFor(() => { expect(r.latest().notice).toMatch(/history failed: TypeError: history exploded/) })
    r.controller.dispose()
  })

  it('surfaces history failures as a notice', async () => {
    const r = rig({ existingSessionId: 's1' })
    r.fetch.routes.set('/api/session.history', init => echoServerError(init, 'history unavailable'))
    r.controller.connect()
    await vi.waitFor(() => { expect(r.latest().notice).toBe('history unavailable') })
    r.controller.dispose()
  })

  it('reports cancel failures with context', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.fetch.routes.set('/api/session.cancel', () => { throw new TypeError('cancel exploded') })
    r.sockets[0]!.push(liveEvent(8, userMessageData('x'), { type: 'turn/start', data: { turn: 2 } }))
    await vi.waitFor(() => { expect(r.latest().turnRunning).toBe(true) })
    r.controller.startListening()
    await vi.waitFor(() => { expect(r.latest().notice).toMatch(/cancel failed: TypeError: cancel exploded/) })
    r.controller.dispose()
  })

  it('clears the notice through acknowledgeNotice', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.sockets[0]!.push({ type: 'stream/error', error: { code: 'internal', message: 'transient', details: {} } })
    await vi.waitFor(() => { expect(r.latest().notice).toBe('transient') })
    r.controller.acknowledgeNotice()
    expect(r.latest().notice).toBeNull()
    r.controller.acknowledgeNotice()
    expect(r.latest().notice).toBeNull()
    r.controller.dispose()
  })


  it('covers guard and projection branches', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)

    // currentTimeZone fallbacks: empty zone and a throwing Intl both omit the field.
    const real = Intl.DateTimeFormat
    vi.stubGlobal('Intl', { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: '' }) }) })
    r.controller.submitText('空时区')
    vi.unstubAllGlobals()
    vi.stubGlobal('Intl', { DateTimeFormat: () => { throw new Error('no Intl') } })
    r.controller.submitText('无时区')
    vi.unstubAllGlobals()
    vi.stubGlobal('Intl', { DateTimeFormat: real })
    await vi.waitFor(() => { expect(r.promptBodies()).toHaveLength(2) })
    expect(r.promptBodies()[0]!.payload.clientTimeZone).toBeUndefined()
    expect(r.promptBodies()[1]!.payload.clientTimeZone).toBeUndefined()

    // submitText guards.
    r.controller.submitText('   ')
    expect(r.promptBodies()).toHaveLength(2)

    // answer guards with nothing pending.
    r.controller.answerApproval('none', 'allowed-once')
    r.controller.answerQuestion('none', [])
    expect(r.fetch.calls.filter(entry => entry.url.endsWith('/api/respond'))).toHaveLength(0)

    // stopSpeaking is a plain clear.
    r.controller.stopSpeaking()

    // cancelTurn before any session resolves to a no-op (no RPC emitted).
    const bare = rig()
    await bare.controller.cancelTurn()
    expect(bare.fetch.calls.filter(entry => entry.url.endsWith('/api/session.cancel'))).toHaveLength(0)
    bare.controller.dispose()

    // stopListening while idle is a no-op.
    r.controller.stopListening()
    expect(r.recognizer.stopCalls).toBe(0)

    // Double dispose and post-dispose guards.
    r.controller.dispose()
    r.controller.dispose()
    r.controller.startListening()
    r.controller.submitText('之后')
    expect(r.recognizer.startCalls).toHaveLength(0)
    expect(r.promptBodies()).toHaveLength(2)
  })

  it('ignores frames and events outside the selected session or vocabulary', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.sockets[0]!.push({ type: 'stream/heartbeat' })
    r.sockets[0]!.push({ type: 'session/event', sessionId: 'other', event: sessionEvent('user/message', 8, userMessageData('别人的会话')) })
    r.sockets[0]!.push({ type: 'approval/resolved', sessionId: 'other', approvalId: 'ap1', outcome: 'allowed-once' })
    r.sockets[0]!.push({ type: 'question/resolved', sessionId: 'other', questionRpcId: 'q1', outcome: 'answered' })
    // Empty user message text: skipped.
    r.sockets[0]!.push(liveEvent(9, { id: 'm1', role: 'user', content: [], source: { kind: 'user' } }))
    // Empty and non-text chunks: skipped.
    r.sockets[0]!.push({ type: 'session/event', sessionId: 's1', event: sessionEvent('assistant/chunk', 10, { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '' } }) })
    r.sockets[0]!.push({ type: 'session/event', sessionId: 's1', event: sessionEvent('assistant/chunk', 11, { turn: 2, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '思考中' } }) })
    // Duplicate tool call is not re-appended; results without a join seq or a matching seq leave lines unchanged.
    r.sockets[0]!.push({ type: 'session/event', sessionId: 's1', event: sessionEvent('tool/call', 12, { turn: 2, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' }) })
    r.sockets[0]!.push({ type: 'session/event', sessionId: 's1', event: sessionEvent('tool/result', 13, { turn: 2, step: 1, message: { id: 'r2', role: 'user', content: [], source: { kind: 'tool' } } }) })
    r.sockets[0]!.push({ type: 'session/event', sessionId: 's1', event: sessionEvent('tool/result', 14, { turn: 2, step: 1, message: { id: 'r3', role: 'user', content: [], source: { kind: 'tool' } } }, { sourceEventSeqs: [999] }) })
    // Deterministic end marker: everything pushed above is processed before it.
    r.sockets[0]!.push({ type: 'stream/error', error: { code: 'internal', message: 'marker', details: {} } })
    await vi.waitFor(() => { expect(r.latest().notice).toBe('marker') })
    r.controller.acknowledgeNotice()
    // Nothing new entered the view: the history pair stays untouched.
    expect(r.latest().messages).toEqual([
      { kind: 'user', text: '历史提问' },
      { kind: 'assistant', text: '历史回答。', complete: true },
    ])
    expect(r.latest().toolLines.filter(line => line.id === 'call-1')).toHaveLength(1)
    r.controller.dispose()
  })

  it('ignores recognizer callbacks after the listening window and survives a rejecting stop', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.controller.startListening()
    r.recognizer.final('已结束')
    await vi.waitFor(() => { expect(r.latest().listener).toBe('processing') })
    // Late interim and a second final leave the state alone; a late error
    // still surfaces (the error handler has no listening-window guard).
    r.recognizer.interim('迟到')
    r.recognizer.final('第二次')
    expect(r.latest().interim).toBe('')
    r.recognizer.error('迟到错误')
    expect(r.latest().notice).toBe('迟到错误')
    // A rejecting recognizer stop stays swallowed, on both stop paths.
    r.recognizer.stop = async () => { r.recognizer.stopCalls += 1; throw new Error('stop failed') }
    r.controller.startListening()
    expect(r.latest().listener).toBe('listening')
    r.controller.stopListening()
    expect(r.latest().listener).toBe('processing')
    // The rejecting stop settles the finalize back to idle.
    await vi.waitFor(() => { expect(r.latest().listener).toBe('idle') })
    r.controller.dispose()
    await vi.waitFor(() => { expect(r.recognizer.stopCalls).toBeGreaterThan(0) })
  })

  it('turns on the speak queue callback after setAutoSpeak(true)', async () => {
    const r = rig({ existingSessionId: 's1', autoSpeak: false })
    await settle(r)
    r.controller.setAutoSpeak(true)
    r.sockets[0]!.push({ type: 'session/event', sessionId: 's1', event: sessionEvent('assistant/chunk', 8, { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '发声。' } }) })
    r.sockets[0]!.push({ type: 'session/event', sessionId: 's1', event: sessionEvent('turn/end', 9, { turn: 2, reason: 'done' }) })
    await vi.waitFor(() => { expect(r.latest().messages.at(-1)).toMatchObject({ kind: 'assistant', text: '发声。', complete: true }) })
    expect(r.speaker.spoken).toEqual([{ text: '发声。', language: 'zh-CN' }])
    r.controller.dispose()
  })

  it('stops active speech through the speak port on barge-in', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    // A speaker that stays active until stopped.
    let stopped = false
    const speak = vi.fn()
    const original = r.speaker.speak.bind(r.speaker)
    r.speaker.speak = (text, language, onDone, onError) => {
      speak(text)
      if (text === '第一句。') return // never completes: still speaking
      original.call(r.speaker, text, language, onDone, onError)
    }
    r.speaker.stop = () => { stopped = true }
    r.sockets[0]!.push({ type: 'session/event', sessionId: 's1', event: sessionEvent('assistant/chunk', 8, { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '第一句。第二句。' } }) })
    await vi.waitFor(() => { expect(speak).toHaveBeenCalledWith('第一句。') })
    expect(r.latest().speaking).toBe(true)
    r.controller.startListening()
    expect(stopped).toBe(true)
    expect(r.latest().speaking).toBe(false)
    r.controller.dispose()
  })

  it('skips the session-creation fallback return and completes a turn with no assistant text', async () => {
    const r = rig()
    r.fetch.routes.set('/api/session.create', init => echoServerError(init, 'cannot create'))
    r.controller.connect()
    await vi.waitFor(() => { expect(r.latest().notice).toBe('cannot create') })
    r.controller.submitText('无会话')
    await vi.waitFor(() => { expect(r.fetch.calls.filter(entry => entry.url.endsWith('/api/session.prompt'))).toHaveLength(0) })
    expect(r.latest().sessionId).toBe('')
    r.controller.dispose()
  })

  it('falls back to create when the list answers with a business error', async () => {
    const r = rig()
    r.fetch.routes.set('/api/session.list', init => echoServerError(init, 'list sad'))
    r.controller.connect()
    await vi.waitFor(() => { expect(r.latest().sessionId).toBe('s-new') })
    r.controller.dispose()
  })

  it('leaves a turn with no assistant message untouched at turn end', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.sockets[0]!.push(liveEvent(8, userMessageData('只有用户')))
    r.sockets[0]!.push({ type: 'session/event', sessionId: 's1', event: sessionEvent('turn/end', 9, { turn: 2, reason: 'cancelled' }) })
    await vi.waitFor(() => { expect(r.latest().messages.at(-1)).toEqual({ kind: 'user', text: '只有用户' }) })
    expect(r.latest().turnRunning).toBe(false)
    r.controller.dispose()
  })

  it('reconnect restarts the stream with a fresh budget after failure', async () => {
    const fetch = fakeFetch()
    fetch.routes.set('/api/session.list', init => echoServerResponse(init, { items: [summaryOf('s1')] }))
    fetch.routes.set('/api/session.history', init => echoServerResponse(init, { events: [], hasMore: false }))
    let serverUp = false
    const socketRig = socketFactoryRig()
    const openSocket = (_url: string, _headers: Record<string, string>): SocketMock => {
      const socket = socketRig.factory('wss://x/api/events.mux', { cookie: 'c1' })
      queueMicrotask(() => {
        if (serverUp) socket.open()
        else socket.close()
      })
      return socket
    }
    const snapshots: VoiceChatSnapshot[] = []
    const controller = new VoiceChatController({
      client: new MobileApiClient({ baseUrl: BASE, cookie: 'c1', fetchImpl: fetch.impl, openSocket }),
      recognizer: { available: true, start: async () => undefined, stop: async () => undefined },
      speaker: { speak: (_t, _l, onDone) => { onDone() }, stop: () => undefined },
      sessionId: 's1',
      onSnapshot: (snapshot) => { snapshots.push(snapshot) },
    })
    vi.useFakeTimers()
    controller.connect()
    await vi.advanceTimersByTimeAsync(0)
    // Linear backoff: 500+1000+1500+2000+2500ms before the budget is spent.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(snapshots.at(-1)?.connection).toBe('failed')
    // The server side recovers; a reconnect opens with a fresh budget.
    serverUp = true
    controller.reconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots.at(-1)?.connection).toBe('online')
    controller.dispose()
    vi.useRealTimers()
  })

  it('reconnect is a no-op before connect and after dispose', async () => {
    const r = rig({ existingSessionId: 's1' })
    r.controller.reconnect()
    await settle(r)
    r.controller.dispose()
    r.controller.reconnect()
    expect(r.snapshots.at(-1)?.connection).toBe('online')
  })

  it('reports answer delivery failures with context', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.fetch.routes.set('/api/respond', () => new Response('gone', { status: 410 }))
    r.sockets[0]!.push({ type: 'approval/requested', sessionId: 's1', approvalId: 'ap1', toolName: 'bash' }, 'a1')
    await vi.waitFor(() => { expect(r.latest().pendingApproval).not.toBeNull() })
    r.controller.answerApproval('ap1', 'allowed-once')
    await vi.waitFor(() => { expect(r.latest().notice).toMatch(/answer failed: Error: transport failure/) })
    // The transport failure restores the card so the user can retry.
    await vi.waitFor(() => { expect(r.latest().pendingApproval).toEqual({ approvalId: 'ap1', toolName: 'bash' }) })
    r.controller.acknowledgeNotice()
    r.sockets[0]!.push({ type: 'question/requested', sessionId: 's1', questions: [{ id: 'q1', question: '真的？' }] }, 'q1')
    await vi.waitFor(() => { expect(r.latest().pendingQuestion).not.toBeNull() })
    r.controller.answerQuestion('q1', [{ id: 'q1', selected: [] }])
    await vi.waitFor(() => { expect(r.latest().notice).toMatch(/answer failed: Error: transport failure/) })
    await vi.waitFor(() => { expect(r.latest().pendingQuestion).not.toBeNull() })
  })

  it('surfaces a rejected answer receipt without restoring the card', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.fetch.routes.set('/api/respond', () => jsonResponse({ accepted: false, reason: 'not-pending' }))
    r.sockets[0]!.push({ type: 'approval/requested', sessionId: 's1', approvalId: 'ap1', toolName: 'bash' }, 'a1')
    await vi.waitFor(() => { expect(r.latest().pendingApproval).not.toBeNull() })
    r.controller.answerApproval('ap1', 'allowed-once')
    await vi.waitFor(() => { expect(r.latest().notice).toBe('主机未能接受该应答') })
    // The host already settled the frame; the card stays closed.
    expect(r.latest().pendingApproval).toBeNull()
    // The same rejected-receipt path for questions.
    r.sockets[0]!.push({ type: 'question/requested', sessionId: 's1', questions: [{ id: 'q1', question: '真的？' }] }, 'q1')
    await vi.waitFor(() => { expect(r.latest().pendingQuestion).not.toBeNull() })
    r.controller.answerQuestion('q1', [{ id: 'q1', selected: [] }])
    await vi.waitFor(() => { expect(r.latest().notice).toBe('主机未能接受该应答') })
    expect(r.latest().pendingQuestion).toBeNull()
    r.controller.dispose()
  })

  it('dispose stops recognition and refuses a later connect', async () => {
    const r = rig({ existingSessionId: 's1' })
    await settle(r)
    r.controller.dispose()
    expect(r.recognizer.stopCalls).toBe(1)
    expect(() => { r.controller.connect() }).toThrow(/disposed/)
  })
})
