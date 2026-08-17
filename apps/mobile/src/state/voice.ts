/**
 * Voice conversation store: owns the VoiceChatController lifecycle for one
 * paired host and publishes snapshots to subscribers, so screens never hold
 * the controller in component state. The controller's own logic (session
 * selection, history reconstruction, listen -> transcript -> auto-send loop,
 * barge-in, speak queue) lives in @deepseek-ai/dsh-client-mobile; this module
 * owns only lifecycle, wiring, and subscription.
 */

import {
  VoiceChatController, type ApprovalOutcome, type ModelOption,
  type PairingRecord, type PromptPart, type QuestionAnswerItem,
  type SessionSummary, type SpeechRecognizerPort, type SpeechSpeakerPort,
  type VoiceChatOptions, type VoiceChatSnapshot,
} from '@deepseek-ai/dsh-client-mobile'
import { DeviceRecognizer, DeviceSpeaker } from '../adapters/speech'
import { createApi } from '../lib/api'

/** Injectable pieces so tests can stub transport, speech, and the controller. */
export interface VoiceStoreDeps {
  /** Build the wire client for one paired host. */
  createClient(record: PairingRecord): VoiceChatOptions['client']
  /** Build the device recognizer (expo-speech-recognition adapter). */
  createRecognizer(): SpeechRecognizerPort
  /** Build the device speaker (expo-speech adapter). */
  createSpeaker(): SpeechSpeakerPort
  /** Build the controller; tests substitute a recording stub. */
  createController(options: VoiceChatOptions): VoiceChatController
}

/** Production wiring: transport, device speech, and the real controller. */
const defaultDeps: VoiceStoreDeps = {
  createClient: createApi,
  createRecognizer: () => new DeviceRecognizer(),
  createSpeaker: () => new DeviceSpeaker(),
  createController: options => new VoiceChatController(options),
}

/**
 * The voice conversation store for one pairing record.
 * Call {@link connect} to start the controller and {@link dispose} when the
 * host screen goes away; snapshot changes reach {@link subscribe} listeners.
 */
export class VoiceStore {
  private controllerValue: VoiceChatController | null = null
  private snapshotValue: VoiceChatSnapshot | null = null
  private readonly listeners = new Set<() => void>()

  /**
   * @param record - the paired host this store talks to.
   * @param deps - wiring overrides; defaults to transport + device speech.
   */
  constructor(
    private readonly record: PairingRecord,
    private readonly deps: VoiceStoreDeps = defaultDeps,
  ) {}

  /** Latest controller snapshot; null until the first publish. */
  get snapshot(): VoiceChatSnapshot | null {
    return this.snapshotValue
  }

  /** The live controller, or null before connect / after dispose. */
  get controller(): VoiceChatController | null {
    return this.controllerValue
  }

  /** Create and connect the controller for this store's pairing record. */
  connect(): void {
    if (this.controllerValue !== null) return
    const controller = this.deps.createController({
      client: this.deps.createClient(this.record),
      recognizer: this.deps.createRecognizer(),
      speaker: this.deps.createSpeaker(),
      onSnapshot: (snapshot) => {
        this.snapshotValue = snapshot
        this.emit()
      },
    })
    this.controllerValue = controller
    controller.connect()
  }

  /** Dispose the controller; snapshots stop and no listeners fire again. */
  dispose(): void {
    this.controllerValue?.dispose()
    this.controllerValue = null
  }

  /**
   * Subscribe to snapshot changes.
   * @param listener - called after every snapshot publish.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  reconnect(): void {
    this.controller?.reconnect()
  }

  startListening(): void {
    this.controller?.startListening()
  }

  stopListening(): void {
    this.controller?.stopListening()
  }

  submitText(text: string): void {
    this.controller?.submitText(text)
  }

  submitContent(parts: readonly PromptPart[]): void {
    this.controller?.submitContent(parts)
  }

  async cancelTurn(): Promise<void> {
    await this.controller?.cancelTurn()
  }

  stopSpeaking(): void {
    this.controller?.stopSpeaking()
  }

  acknowledgeNotice(): void {
    this.controller?.acknowledgeNotice()
  }

  setLanguage(language: string): void {
    this.controller?.setLanguage(language)
  }

  setAutoSpeak(enabled: boolean): void {
    this.controller?.setAutoSpeak(enabled)
  }

  setAutoListen(enabled: boolean): void {
    this.controller?.setAutoListen(enabled)
  }

  setTtsRate(rate: number): void {
    this.controller?.setTtsRate(rate)
  }

  setTtsPitch(pitch: number): void {
    this.controller?.setTtsPitch(pitch)
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.controller?.listSessions() ?? []
  }

  switchSession(sessionId: string): void {
    this.controller?.switchSession(sessionId)
  }

  async createSession(): Promise<SessionSummary | null> {
    return this.controller?.createSession() ?? null
  }

  async listModels(): Promise<ModelOption[]> {
    return this.controller?.listModels() ?? []
  }

  async selectModel(model: ModelOption): Promise<void> {
    await this.controller?.selectModel(model)
  }

  async downloadImage(attachmentId: string): Promise<string | null> {
    return this.controller?.downloadImage(attachmentId) ?? null
  }

  answerApproval(approvalId: string, outcome: ApprovalOutcome): void {
    this.controller?.answerApproval(approvalId, outcome)
  }

  answerQuestion(questionRpcId: string, answers: readonly QuestionAnswerItem[]): void {
    this.controller?.answerQuestion(questionRpcId, answers)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
