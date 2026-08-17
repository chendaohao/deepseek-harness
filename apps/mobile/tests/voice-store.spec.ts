// The voice store: controller lifecycle, snapshot publishing, and action
// passthroughs, against a recording controller stub.
import { describe, expect, it, vi } from 'vitest'

// The store's default wiring imports the expo speech modules; mocking them
// keeps this node spec free of the react-native transform.
vi.mock('expo/fetch', () => ({ fetch: vi.fn() }))
vi.mock('expo-speech', () => ({ speak: vi.fn(), stop: vi.fn() }))
vi.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: {} }))

import { VoiceStore, type VoiceStoreDeps } from '../src/state/voice'
import type {
  MobileApiClient, PairingRecord, SpeechRecognizerPort, SpeechSpeakerPort,
  VoiceChatController, VoiceChatOptions, VoiceChatSnapshot,
} from '@deepseek-ai/dsh-client-mobile'

interface StubController extends VoiceChatController {
  readonly calls: string[]
  fireSnapshot(snapshot: VoiceChatSnapshot): void
}

/** A recording controller stub plus the deps that hand it out. */
function stubWorld(): { deps: VoiceStoreDeps; controller: StubController; client: MobileApiClient } {
  const calls: string[] = []
  let onSnapshot: ((snapshot: VoiceChatSnapshot) => void) | null = null
  const controller = {
    calls,
    connect: vi.fn(() => { calls.push('connect') }),
    dispose: vi.fn(() => { calls.push('dispose') }),
    reconnect: vi.fn(() => { calls.push('reconnect') }),
    startListening: vi.fn(() => { calls.push('startListening') }),
    stopListening: vi.fn(() => { calls.push('stopListening') }),
    submitText: vi.fn((text: string) => { calls.push('submitText:' + text) }),
    submitContent: vi.fn(() => { calls.push('submitContent') }),
    cancelTurn: vi.fn(async () => { calls.push('cancelTurn') }),
    stopSpeaking: vi.fn(() => { calls.push('stopSpeaking') }),
    acknowledgeNotice: vi.fn(() => { calls.push('acknowledgeNotice') }),
    setLanguage: vi.fn(() => { calls.push('setLanguage') }),
    setAutoSpeak: vi.fn(() => { calls.push('setAutoSpeak') }),
    setAutoListen: vi.fn(() => { calls.push('setAutoListen') }),
    setTtsRate: vi.fn(() => { calls.push('setTtsRate') }),
    setTtsPitch: vi.fn(() => { calls.push('setTtsPitch') }),
    listSessions: vi.fn(async () => { calls.push('listSessions'); return [] }),
    switchSession: vi.fn(() => { calls.push('switchSession') }),
    createSession: vi.fn(async () => { calls.push('createSession'); return null }),
    listModels: vi.fn(async () => { calls.push('listModels'); return [] }),
    selectModel: vi.fn(async () => { calls.push('selectModel') }),
    downloadImage: vi.fn(async () => { calls.push('downloadImage'); return null }),
    answerApproval: vi.fn(() => { calls.push('answerApproval') }),
    answerQuestion: vi.fn(() => { calls.push('answerQuestion') }),
    fireSnapshot: (snapshot: VoiceChatSnapshot) => { onSnapshot?.(snapshot) },
  }
  const client = {} as MobileApiClient
  const deps: VoiceStoreDeps = {
    createClient: () => client,
    createRecognizer: () => ({}) as SpeechRecognizerPort,
    createSpeaker: () => ({}) as SpeechSpeakerPort,
    createController: (options: VoiceChatOptions) => {
      onSnapshot = options.onSnapshot
      calls.push('createController')
      return controller as unknown as VoiceChatController
    },
  }
  return { deps, controller: controller as unknown as StubController, client }
}

const RECORD: PairingRecord = { baseUrl: 'https://pair.example', cookie: 'tok' }

describe('VoiceStore', () => {
  it('creates and connects one controller per store, wired to the deps', () => {
    const { deps, controller, client } = stubWorld()
    const store = new VoiceStore(RECORD, deps)
    expect(store.snapshot).toBeNull()
    store.connect()
    expect(controller.calls).toEqual(['createController', 'connect'])
    expect(store.controller).toBe(controller as unknown as VoiceChatController)
    // Idempotent: a second connect must not create another controller.
    store.connect()
    expect(controller.calls.filter(c => c === 'createController')).toHaveLength(1)
    expect(client).toBeDefined()
  })

  it('publishes snapshots to subscribers and lets them unsubscribe', () => {
    const { deps, controller } = stubWorld()
    const store = new VoiceStore(RECORD, deps)
    const seen: (VoiceChatSnapshot | null)[] = []
    const unsubscribe = store.subscribe(() => seen.push(store.snapshot))
    store.connect()
    // Subscribers fire only on snapshot publishes, not on connect.
    expect(seen).toEqual([])
    const snapshot = { sessionId: 's1' } as VoiceChatSnapshot
    controller.fireSnapshot(snapshot)
    expect(store.snapshot).toBe(snapshot)
    expect(seen).toEqual([snapshot])
    unsubscribe()
    controller.fireSnapshot({ sessionId: 's2' } as VoiceChatSnapshot)
    expect(seen).toEqual([snapshot])
  })

  it('delegates actions to the live controller', async () => {
    const { deps, controller } = stubWorld()
    const store = new VoiceStore(RECORD, deps)
    store.connect()
    store.startListening()
    store.submitText('你好')
    store.answerApproval('ap1', 'allowed-once')
    await store.cancelTurn()
    await store.listSessions()
    await store.selectModel({ id: 'm1', name: 'M1', provider: 'test' })
    expect(controller.calls).toContain('startListening')
    expect(controller.calls).toContain('submitText:你好')
    expect(controller.calls).toContain('answerApproval')
    expect(controller.calls).toContain('cancelTurn')
    expect(controller.calls).toContain('listSessions')
    expect(controller.calls).toContain('selectModel')
  })

  it('disposes the controller and settles actions into safe no-ops', async () => {
    const { deps, controller } = stubWorld()
    const store = new VoiceStore(RECORD, deps)
    store.connect()
    store.dispose()
    expect(controller.calls).toContain('dispose')
    expect(store.controller).toBeNull()
    store.startListening()
    store.answerApproval('ap1', 'rejected')
    expect(await store.cancelTurn()).toBeUndefined()
    expect(await store.listSessions()).toEqual([])
    expect(await store.createSession()).toBeNull()
    // No action reaches the disposed controller.
    expect(controller.calls.filter(c => c === 'startListening')).toHaveLength(0)
  })
})
