/**
 * VoiceChatController: the voice conversation state machine over one paired
 * host session. It owns session selection, history reconstruction, live event
 * folding (watermark-deduplicated), the listen -> transcript -> auto-send
 * loop, barge-in (stop speech + cancel the running turn), and the speak
 * queue. Transport concerns live in MobileConnection; device speech lives in
 * the injected recognizer/speaker ports.
 * @module @deepseek-ai/dsh-client-mobile
 */

import type { AttachmentIdType, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { MuxFrame, RpcId, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm/types'
// The plan-mode package augments the session event map with 'plan/mode'.
import type {} from '@deepseek-ai/dsh-plan-mode'
// The title package augments the projection map with the 'title' key list rows read.
import type {} from '@deepseek-ai/dsh-session-title/client'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { MobileApiClient } from './client.ts'
import { MobileConnection } from './connection.ts'
import { UnauthorizedError } from './errors.ts'
import { SpeakQueue, type SpeakPort } from './speak-queue.ts'
import type {
  ApprovalOutcome, ChatMessage, ConnectionStatus, ListenerStatus, ModelOption,
  PendingApproval, PendingQuestion, PromptPart, QuestionAnswerItem,
  SessionSummary, SpeechRecognizerPort, SpeechSpeakerPort, TodoItemView,
  ToolStatusLine, VoiceChatSnapshot,
} from './types.ts'

/** Construction options for one controller. */
export interface VoiceChatOptions {
  /** The paired wire client. */
  client: MobileApiClient
  /** Device recognizer (expo-speech-recognition adapter). */
  recognizer: SpeechRecognizerPort
  /** Device speaker (expo-speech adapter). */
  speaker: SpeechSpeakerPort
  /** ASR/TTS language (BCP-47), e.g. "zh-CN". */
  language?: string
  /** Speak assistant replies automatically (voice conversation mode). */
  autoSpeak?: boolean
  /** Start listening automatically after each finished turn. */
  autoListen?: boolean
  /** TTS speech rate, 0.5..2.0. */
  ttsRate?: number
  /** TTS speech pitch, 0.5..2.0. */
  ttsPitch?: number
  /** Reuse this session instead of listing/creating one. */
  sessionId?: string
  /** Snapshot sink, called after every mutation. */
  onSnapshot(snapshot: VoiceChatSnapshot): void
}

/** Internal pending-approval record (carries the frame rpcId for the answer). */
interface PendingApprovalInternal extends PendingApproval {
  readonly frameRpcId: RpcId
}

/** Ask_user_question option as rendered by the app. */
interface PendingQuestionInternal extends PendingQuestion {
  readonly frameRpcId: RpcId
}

const DEFAULT_LANGUAGE = 'zh-CN'
const HISTORY_PAGE_MESSAGES = 50
/** Result-text cap kept on the view row's expanded detail. */
const TOOL_RESULT_SUMMARY_CAP = 300

/** Best-effort IANA zone for non-browser callers; omission stays valid. */
function currentTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return zone === '' ? undefined : zone
  } catch {
    return undefined
  }
}

/** Plain text of a content block list (text blocks only). */
function textOfContent(content: readonly ContentBlock[]): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Text carried by one stream chunk (only text deltas reach the view). */
function textOfChunk(chunk: StreamChunk): string | undefined {
  return chunk.type === 'text-delta' ? chunk.text : undefined
}

/** Image refs carried by a content list (top-level image blocks only). */
function imageRefsOf(content: readonly ContentBlock[]): ImageAttachmentRef[] {
  return content.filter(block => block.type === 'image').map(block => block.attachment)
}

/** First text block nested anywhere in a content list (tool-result blocks recurse). */
function firstTextBlock(content: readonly ContentBlock[]): string | null {
  for (const block of content) {
    if (block.type === 'text' && block.text !== '') return block.text
    if (block.type === 'tool-result') {
      const nested = firstTextBlock(block.content)
      if (nested !== null) return nested
    }
  }
  return null
}

/** Bounded first-text summary of a tool result for the row's expanded detail. */
function summarizeResult(content: readonly ContentBlock[]): string | null {
  const text = firstTextBlock(content)
  if (text === null) return null
  return text.length > TOOL_RESULT_SUMMARY_CAP ? text.slice(0, TOOL_RESULT_SUMMARY_CAP) + '…' : text
}

/**
 * The voice conversation machine.
 * @param options - client, ports, and behavior flags.
 */
export class VoiceChatController {
  private readonly client: MobileApiClient
  private readonly recognizer: SpeechRecognizerPort
  private readonly speaker: SpeechSpeakerPort
  private readonly onSnapshot: (snapshot: VoiceChatSnapshot) => void
  private connection: MobileConnection | null = null
  private connectionStatus: ConnectionStatus = 'connecting'
  private listener: ListenerStatus = 'idle'
  private turnRunning = false
  private interim = ''
  private notice: string | null = null
  private language: string
  private autoSpeak: boolean
  private autoListen: boolean
  private ttsRate: number
  private ttsPitch: number
  private planActive = false
  private todos: TodoItemView[] = []
  private selectedModel: string | null = null
  private selectedProvider: string | null = null
  private sessionId: SessionId | null = null
  private watermark = -1
  private messages: ChatMessage[] = []
  private toolLines: ToolStatusLine[] = []
  private pendingApproval: PendingApprovalInternal | null = null
  private pendingQuestion: PendingQuestionInternal | null = null
  private speakQueue: SpeakQueue
  private speaking = false
  /** Optimistically-sent user texts awaiting their live echo, in send order. */
  private pendingTexts: string[] = []
  /** A stopListening finalize is awaiting the recognizer's final result. */
  private finalizing = false
  private historyChain: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(options: VoiceChatOptions) {
    this.client = options.client
    this.recognizer = options.recognizer
    this.speaker = options.speaker
    this.onSnapshot = (snapshot) => { options.onSnapshot(snapshot) }
    this.language = options.language ?? DEFAULT_LANGUAGE
    this.autoSpeak = options.autoSpeak ?? true
    this.autoListen = options.autoListen ?? false
    this.ttsRate = options.ttsRate ?? 1
    this.ttsPitch = options.ttsPitch ?? 1
    this.sessionId = options.sessionId === undefined ? null : options.sessionId as SessionId
    this.speakQueue = this.buildSpeakQueue(this.autoSpeak)
  }

  /** Build the queue with the live callbacks; shared by construction and toggles. */
  private buildSpeakQueue(autoSpeak: boolean): SpeakQueue {
    return new SpeakQueue({
      autoSpeak,
      port: this.speakPort(),
      onSpeakingChange: (speaking) => {
        this.speaking = speaking
        if (!speaking) this.maybeAutoListen()
        this.publish()
      },
    })
  }

  /** The speak port the queue consumes: closes over the live language and TTS settings. */
  private speakPort(): SpeakPort {
    return {
      speak: (text, onDone, onError) => {
        this.speaker.speak(text, this.language, this.ttsRate, this.ttsPitch, onDone, onError)
      },
      stop: () => { this.speaker.stop() },
    }
  }

  /** Start listening after a finished turn when autoListen is on and nothing blocks. */
  private maybeAutoListen(): void {
    if (!this.autoListen || this.disposed) return
    if (this.pendingApproval !== null || this.pendingQuestion !== null) return
    if (this.speaking || this.turnRunning || this.listener !== 'idle') return
    this.startListening()
  }

  /** Open the stream and rebuild the conversation for the selected session. */
  connect(): void {
    if (this.disposed) throw new Error('VoiceChatController was disposed')
    const connection = new MobileConnection({
      client: this.client,
      callbacks: {
        onFrame: (envelope) => { this.onFrame(envelope) },
        onStatus: (status) => { this.onStatus(status) },
      },
    })
    this.connection = connection
    this.publish()
    void this.ensureSession().then(() => { connection.start() })
  }

  /** Reopen the stream after a spent retry budget (fresh attempt budget). */
  reconnect(): void {
    if (this.disposed || this.connection === null) return
    this.connection.start()
  }

  /** Tear the controller down: stream, speech, and pending recognition stop. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.connection?.stop()
    this.connection = null
    this.speakQueue.clear()
    void this.recognizer.stop().catch(() => undefined)
  }

  /** Tap the microphone: barge-in on speech/turns, then start listening. */
  startListening(): void {
    if (this.listener !== 'idle' || this.disposed) return
    this.finalizing = false
    // Barge-in: the user taking the mic ends current speech and the turn.
    this.speakQueue.clear()
    if (this.turnRunning) void this.cancelTurn()
    this.listener = 'listening'
    this.interim = ''
    this.publish()
    void this.recognizer.start({
      onInterim: (text) => {
        if (this.disposed || this.listener !== 'listening') return
        this.interim = text
        this.publish()
      },
      onFinal: (text) => {
        // Accepted from 'listening' (auto final) and from the finalize that
        // stopListening's native stop() delivers (listener 'processing' with
        // finalizing set); any other final is a stale duplicate.
        if (this.disposed) return
        if (this.listener !== 'listening' && !(this.finalizing && this.listener === 'processing')) return
        this.finalizing = false
        this.interim = ''
        this.listener = 'processing'
        this.publish()
        const trimmed = text.trim()
        if (trimmed === '') {
          this.listener = 'idle'
          this.publish()
          return
        }
        void this.sendPrompt([{ type: 'text', text: trimmed }])
      },
      onError: (message) => {
        if (this.disposed) return
        this.finalizing = false
        this.listener = 'idle'
        this.notice = message
        this.publish()
      },
    }, this.language).catch(() => {
      if (this.disposed) return
      this.listener = 'idle'
      this.publish()
    })
  }

  /**
   * End listening (tap-again): the device recognizer still delivers its
   * final result after stop(), and that final goes through the normal
   * onFinal -> auto-send path; an empty final resets to idle.
   */
  stopListening(): void {
    if (this.disposed || this.listener !== 'listening') return
    this.finalizing = true
    this.listener = 'processing'
    this.interim = ''
    this.publish()
    void this.recognizer.stop().catch(() => {
      if (this.disposed) return
      this.finalizing = false
      this.listener = 'idle'
      this.publish()
    })
  }

  /**
   * Send one text prompt (typed input path).
   * @param text - the prompt text to send.
   */
  submitText(text: string): void {
    if (this.disposed) return
    void this.sendPrompt([{ type: 'text', text }])
  }

  /**
   * Send one prompt with text and/or canonical-base64 image parts.
   * @param parts - the ordered content parts of the prompt.
   */
  submitContent(parts: readonly PromptPart[]): void {
    if (this.disposed) return
    void this.sendPrompt(parts)
  }

  /** Stop the running agent turn (barge-in). */
  async cancelTurn(): Promise<void> {
    if (this.sessionId === null) return
    try {
      await this.client.sessions.cancel({ sessionId: this.sessionId })
    } catch (error) {
      this.handleCarrierError(error, 'cancel failed')
    }
  }

  /** Stop the active utterance immediately. */
  stopSpeaking(): void {
    this.speakQueue.clear()
  }

  /** Clear the one-shot notice. */
  acknowledgeNotice(): void {
    if (this.notice === null) return
    this.notice = null
    this.publish()
  }

  /**
   * Switch the ASR/TTS language (applies from the next utterance).
   * @param language - BCP-47 tag, e.g. "zh-CN".
   */
  setLanguage(language: string): void {
    this.language = language
    this.publish()
  }

  /**
   * Toggle automatic speaking of assistant replies.
   * @param enabled - whether replies are spoken.
   */
  setAutoSpeak(enabled: boolean): void {
    if (!enabled) this.speakQueue.clear()
    this.autoSpeak = enabled
    // The rebuilt queue carries the same speaking-complete hook (which also
    // drives autoListen), so continuous listening survives a toggle.
    this.speakQueue = this.buildSpeakQueue(enabled)
    this.publish()
  }

  /**
   * Toggle continuous listening: auto-start the mic after each finished turn.
   * @param enabled - whether the mic auto-restarts.
   */
  setAutoListen(enabled: boolean): void {
    this.autoListen = enabled
    if (enabled) this.maybeAutoListen()
    this.publish()
  }

  /**
   * Set the TTS speech rate (0.5..2.0; applies to the next utterance).
   * @param rate - speech rate, clamped to 0.5..2.0.
   */
  setTtsRate(rate: number): void {
    this.ttsRate = Math.min(2, Math.max(0.5, rate))
    this.publish()
  }

  /**
   * Set the TTS speech pitch (0.5..2.0; applies to the next utterance).
   * @param pitch - speech pitch, clamped to 0.5..2.0.
   */
  setTtsPitch(pitch: number): void {
    this.ttsPitch = Math.min(2, Math.max(0.5, pitch))
    this.publish()
  }

  /**
   * List the host's sessions (empty on failure; a notice reports the error).
   * @returns the session summaries, newest first; empty on failure.
   */
  async listSessions(): Promise<SessionSummary[]> {
    try {
      const listed = await this.client.sessions.list({})
      if (!listed.result.ok) {
        this.notice = listed.result.error.message
        this.publish()
        return []
      }
      return listed.result.value.items.map((item) => {
        // The projection values arrive as unknown over the wire (the record
        // schema stays wide); the title key is the one this view consumes.
        const title = item.projections?.values.title
        return {
          sessionId: String(item.sessionId),
          updatedAt: item.updatedAt,
          running: item.running,
          blank: item.blank,
          ...(item.cwd === undefined || item.cwd === '' ? {} : { cwd: item.cwd }),
          ...(typeof title === 'string' && title !== '' ? { title } : {}),
        }
      })
    } catch (error) {
      this.handleCarrierError(error, 'session list failed')
      return []
    }
  }

  /**
   * Switch to another session: reset the view and rebuild from its history.
   * @param sessionId - the session to switch to.
   */
  switchSession(sessionId: string): void {
    if (this.disposed || sessionId === this.sessionId) return
    this.connection?.stop()
    this.sessionId = sessionId as SessionId
    this.watermark = -1
    this.messages = []
    this.toolLines = []
    this.todos = []
    this.planActive = false
    this.selectedModel = null
    this.selectedProvider = null
    this.pendingApproval = null
    this.pendingQuestion = null
    this.notice = null
    // The view resets with the session; an in-flight optimistic echo belongs
    // to the abandoned session and must not dedupe away a new session's
    // identical-looking message.
    this.pendingTexts = []
    this.publish()
    if (this.connection !== null) this.connection.start()
  }

  /**
   * Create a new blank session and switch to it.
   * @returns the created summary, or null when creation fails.
   */
  async createSession(): Promise<SessionSummary | null> {
    try {
      const created = await this.client.sessions.create({})
      if (!created.result.ok) {
        this.notice = created.result.error.message
        this.publish()
        return null
      }
      const sessionId = String(created.result.value.sessionId)
      this.switchSession(sessionId)
      return { sessionId, updatedAt: Date.now(), running: false, blank: true }
    } catch (error) {
      this.handleCarrierError(error, 'session create failed')
      return null
    }
  }

  /**
   * The session's selectable models (empty when the catalog is unavailable).
   * @returns the flattened catalog; empty on failure.
   */
  async listModels(): Promise<ModelOption[]> {
    if (this.sessionId === null) return []
    try {
      const listed = await this.client.sessions.models({ sessionId: this.sessionId })
      if (!listed.result.ok) {
        this.notice = listed.result.error.message
        this.publish()
        return []
      }
      this.selectedModel = listed.result.value.current.model
      this.selectedProvider = listed.result.value.current.provider
      this.publish()
      return listed.result.value.groups.flatMap(group =>
        group.models.map(model => ({ id: model.id, name: model.name, provider: group.id })),
      )
    } catch (error) {
      this.handleCarrierError(error, 'model list failed')
      return []
    }
  }

  /**
   * Select the session's model (the host validates catalog membership).
   * @param model - the catalog entry to select.
   */
  async selectModel(model: ModelOption): Promise<void> {
    if (this.sessionId === null) return
    try {
      const result = await this.client.sessions.selectModel({
        sessionId: this.sessionId,
        provider: model.provider,
        model: model.id,
      })
      if (result.result.ok) {
        this.selectedModel = model.id
        this.selectedProvider = model.provider
        this.publish()
      } else {
        this.notice = result.result.error.message
        this.publish()
      }
    } catch (error) {
      this.handleCarrierError(error, 'model select failed')
    }
  }

  /**
   * Download one durable image as a data URI for rendering.
   * @param attachmentId - the durable image reference id.
   * @returns the data URI, or null when the download fails.
   */
  async downloadImage(attachmentId: string): Promise<string | null> {
    if (this.sessionId === null) return null
    try {
      const result = await this.client.sessions.attachment({
        sessionId: this.sessionId,
        attachmentId: attachmentId as AttachmentIdType,
      })
      if (!result.result.ok) {
        this.notice = result.result.error.message
        this.publish()
        return null
      }
      return 'data:' + result.result.value.attachment.mediaType + ';base64,' + result.result.value.data
    } catch (error) {
      this.handleCarrierError(error, 'image load failed')
      return null
    }
  }

  /**
   * Answer the pending approval (allowed-once or rejected).
   * @param approvalId - the approval being answered.
   * @param outcome - the decision to send.
   */
  answerApproval(approvalId: string, outcome: ApprovalOutcome): void {
    const pending = this.pendingApproval
    if (pending === null || pending.approvalId !== approvalId || this.sessionId === null) return
    this.pendingApproval = null
    this.publish()
    void this.client.respond({
      type: 'client-response',
      rpcId: pending.frameRpcId,
      result: {
        ok: true,
        value: { sessionId: this.sessionId, approvalId: pending.approvalId, outcome },
      },
    }).then((receipt) => {
      if (!receipt.accepted) {
        // The host already resolved or rejected this frame; the card stays
        // closed either way.
        this.notice = '主机未能接受该应答'
        this.publish()
      }
    }).catch((error: unknown) => {
      // A transport failure must not eat the approval: restore the card so
      // the user can answer again.
      this.pendingApproval = pending
      this.handleCarrierError(error, 'answer failed')
    })
  }

  /**
   * Answer the pending question batch.
   * @param questionRpcId - the pending batch's rpc id.
   * @param answers - one answer item per answered question.
   */
  answerQuestion(questionRpcId: string, answers: readonly QuestionAnswerItem[]): void {
    const pending = this.pendingQuestion
    if (pending === null || pending.questionRpcId !== questionRpcId || this.sessionId === null) return
    this.pendingQuestion = null
    this.publish()
    void this.client.respond({
      type: 'client-response',
      rpcId: pending.frameRpcId,
      result: {
        ok: true,
        value: { sessionId: this.sessionId, answer: { answers } },
      },
    }).then((receipt) => {
      if (!receipt.accepted) {
        this.notice = '主机未能接受该应答'
        this.publish()
      }
    }).catch((error: unknown) => {
      this.pendingQuestion = pending
      this.handleCarrierError(error, 'answer failed')
    })
  }

  /** Resolve the session (preset, list-reused, or created) or null when it fails. */
  private async ensureSession(): Promise<SessionId | null> {
    if (this.sessionId !== null) return this.sessionId
    try {
      const listed = await this.client.sessions.list({})
      const first = listed.result.ok ? listed.result.value.items[0] : undefined
      if (first !== undefined) {
        this.sessionId = first.sessionId
        this.publish()
        return this.sessionId
      }
    } catch (error) {
      this.handleCarrierError(error, 'session list failed')
      return null
    }
    try {
      const created = await this.client.sessions.create({})
      if (!created.result.ok) {
        this.notice = created.result.error.message
        this.publish()
        return null
      }
      this.sessionId = created.result.value.sessionId
      this.publish()
    } catch (error) {
      this.handleCarrierError(error, 'session create failed')
    }
    return this.sessionId
  }

  private onStatus(status: ConnectionStatus): void {
    this.connectionStatus = status
    if (status === 'online') {
      // Rebuild the gap: refetch the history tail; the watermark dedupes
      // anything the live stream already delivered.
      this.historyChain = this.historyChain.then(() => this.fetchHistoryPage()).catch((error: unknown) => {
        this.handleCarrierError(error, 'history failed')
      })
    }
    this.publish()
  }

  private async fetchHistoryPage(): Promise<void> {
    if (this.sessionId === null) return
    const response = await this.client.sessions.history({ sessionId: this.sessionId, maxMessages: HISTORY_PAGE_MESSAGES })
    if (!response.result.ok) {
      this.notice = response.result.error.message
      this.publish()
      return
    }
    for (const entry of response.result.value.events) {
      this.foldEvent(entry.event, false)
    }
    this.publish()
  }

  private onFrame(envelope: RpcRequest<MuxFrame>): void {
    const frame = envelope.payload
    if (frame.type === 'session/event') {
      if (frame.sessionId === this.sessionId) this.foldEvent(frame.event, true)
      return
    }
    if (frame.type === 'approval/requested' && frame.sessionId === this.sessionId) {
      this.pendingApproval = {
        frameRpcId: envelope.rpcId,
        approvalId: String(frame.approvalId),
        toolName: frame.toolName,
        ...(frame.reason === undefined || frame.reason === '' ? {} : { reason: frame.reason }),
        ...(frame.callId === undefined || frame.callId === '' ? {} : { callId: frame.callId }),
      }
      this.publish()
      return
    }
    if (frame.type === 'approval/resolved' && frame.sessionId === this.sessionId) {
      this.pendingApproval = null
      this.publish()
      return
    }
    if (frame.type === 'question/requested' && frame.sessionId === this.sessionId) {
      this.pendingQuestion = {
        frameRpcId: envelope.rpcId,
        questionRpcId: envelope.rpcId,
        questions: frame.questions.map(question => ({
          id: question.id,
          question: question.question,
          ...(question.header === undefined || question.header === '' ? {} : { header: question.header }),
          ...(question.detail === undefined || question.detail === '' ? {} : { detail: question.detail }),
          multiSelect: question.multiSelect ?? false,
          options: question.options?.map(option => ({
            label: option.label,
            ...(option.description === undefined || option.description === '' ? {} : { description: option.description }),
          })) ?? [],
        })),
      }
      this.publish()
      return
    }
    if (frame.type === 'question/resolved' && frame.sessionId === this.sessionId) {
      this.pendingQuestion = null
      this.publish()
      return
    }
    if (frame.type === 'stream/error') {
      this.notice = frame.error.message
      this.publish()
    }
    // session/subscribed, session/queue, session/jobs, session/projection and
    // heartbeats carry no chat-view state for this client.
  }

  /** Apply one session event; live=false marks history replay (never spoken). */
  private foldEvent(event: SessionEvent, live: boolean): void {
    if (event.seq <= this.watermark) return
    this.watermark = event.seq
    switch (event.type) {
      case 'turn/start':
        this.turnRunning = true
        break
      case 'turn/end':
        this.turnRunning = false
        // A finalize awaiting its recognizer final survives the turn end of
        // the canceled turn.
        if (this.listener === 'processing' && !this.finalizing) this.listener = 'idle'
        this.completeAssistantMessage()
        if (live) {
          this.speakQueue.flushRemainder()
          this.maybeAutoListen()
        }
        break
      case 'user/message': {
        const text = textOfContent(event.data.content)
        const images = imageRefsOf(event.data.content)
        // Image prompts skip the optimistic echo (no local refs to dedupe by);
        // text-only echoes dedupe against pendingTexts whether they arrive
        // live or through a post-reconnect history refetch — without the
        // history-side dedupe the same turn would render twice.
        if (images.length === 0) {
          const index = this.pendingTexts.indexOf(text)
          if (index !== -1) {
            this.pendingTexts.splice(index, 1)
            break
          }
        }
        if (text === '' && images.length === 0) break
        this.messages = [...this.messages, { kind: 'user', text, images, seq: event.seq }]
        break
      }
      case 'assistant/chunk': {
        const text = textOfChunk(event.data.chunk)
        if (text === undefined || text === '') break
        const last = this.messages[this.messages.length - 1]
        if (last !== undefined && last.kind === 'assistant' && !last.complete) {
          this.messages = [...this.messages.slice(0, -1), { kind: 'assistant', text: last.text + text, complete: false, seq: last.seq }]
        } else {
          this.messages = [...this.messages, { kind: 'assistant', text, complete: false, seq: event.seq }]
        }
        if (live) this.speakQueue.feed(text)
        break
      }
      case 'tool/call':
        if (!this.toolLines.some(line => line.id === event.data.callId)) {
          this.toolLines = [...this.toolLines, {
            id: event.data.callId,
            name: event.data.name,
            argumentsText: event.data.arguments,
            status: 'running',
            resultSummary: null,
            seq: event.seq,
          }]
        }
        break
      case 'tool/result': {
        // The result cites the call event's seq (sourceEventSeqs), the one
        // join the host's own view backscan uses.
        const callSeq = event.sourceEventSeqs?.[0]
        if (callSeq !== undefined) {
          this.toolLines = this.toolLines.map(line => line.seq === callSeq ? {
            ...line,
            status: event.data.error !== undefined ? 'error' : 'done',
            resultSummary: summarizeResult(event.data.message.content),
          } : line)
        }
        break
      }
      case 'plan/mode':
        this.planActive = event.data.active
        break
      case 'todo/write':
        this.todos = event.data.todos.map(todo => ({ content: todo.content, status: todo.status }))
        break
      default:
        // Unrecognized event types (step boundaries, compaction, context
        // notices, future plugins) do not change the chat view.
        break
    }
    this.publish()
  }

  /** Remove one pending-text entry (first match) after a failed prompt. */
  private dropPendingText(text: string): void {
    const index = this.pendingTexts.indexOf(text)
    if (index !== -1) this.pendingTexts.splice(index, 1)
  }

  private completeAssistantMessage(): void {
    const last = this.messages[this.messages.length - 1]
    if (last === undefined || last.kind !== 'assistant' || last.complete) return
    this.messages = [...this.messages.slice(0, -1), { ...last, complete: true }]
  }

  private async sendPrompt(parts: readonly PromptPart[]): Promise<void> {
    /* v8 ignore next -- every caller (onFinal, submitText, submitContent) guards disposed first */
    if (this.disposed) return
    const content = parts.flatMap<PromptPart>(part => part.type === 'text'
      ? (part.text.trim() === '' ? [] : [{ type: 'text', text: part.text.trim() }])
      : [part])
    if (content.length === 0) return
    const text = content
      .filter((part): part is Extract<PromptPart, { type: 'text' }> => part.type === 'text')
      .map(part => part.text).join('')
    const hasImages = content.some(part => part.type === 'image')
    let sessionId = this.sessionId
    if (sessionId === null) {
      sessionId = await this.ensureSession()
      if (sessionId === null) return
    }
    if (!hasImages) {
      // Text-only prompts echo verbatim: the optimistic message shows the send
      // instantly and the live echo dedupes against pendingTexts.
      this.pendingTexts.push(text)
      this.messages = [...this.messages, { kind: 'user', text, images: [], seq: this.watermark + 1 }]
      this.publish()
    }
    try {
      const timeZone = currentTimeZone()
      const response = await this.client.sessions.prompt({
        sessionId,
        mode: 'queue',
        content,
        ...timeZone === undefined ? {} : { clientTimeZone: timeZone },
      })
      if (!response.result.ok) {
        // No echo will come for a rejected prompt: drop the dedupe entry so a
        // later identical third-party message is not swallowed.
        if (!hasImages) this.dropPendingText(text)
        this.listener = 'idle'
        this.notice = response.result.error.message
        this.publish()
      }
    } catch (error) {
      if (!hasImages) this.dropPendingText(text)
      this.listener = 'idle'
      this.handleCarrierError(error, 'send failed')
    }
  }

  private handleCarrierError(error: unknown, context: string): void {
    if (error instanceof UnauthorizedError) {
      this.connectionStatus = 'needsPairing'
      this.connection?.stop()
      this.notice = 'pairing expired'
    } else {
      this.notice = context + ': ' + String(error)
    }
    this.publish()
  }

  private publish(): void {
    if (this.disposed) return
    this.onSnapshot({
      connection: this.connectionStatus,
      listener: this.listener,
      turnRunning: this.turnRunning,
      speaking: this.speaking,
      messages: this.messages,
      toolLines: this.toolLines,
      pendingApproval: this.pendingApproval === null
        ? null
        : {
          approvalId: this.pendingApproval.approvalId,
          toolName: this.pendingApproval.toolName,
          ...(this.pendingApproval.reason === undefined ? {} : { reason: this.pendingApproval.reason }),
          ...(this.pendingApproval.callId === undefined ? {} : { callId: this.pendingApproval.callId }),
        },
      pendingQuestion: this.pendingQuestion,
      interim: this.interim,
      notice: this.notice,
      autoSpeak: this.autoSpeak,
      autoListen: this.autoListen,
      ttsRate: this.ttsRate,
      ttsPitch: this.ttsPitch,
      planActive: this.planActive,
      todos: this.todos,
      selectedModel: this.selectedModel,
      selectedModelProvider: this.selectedProvider,
      language: this.language,
      sessionId: this.sessionId ?? '',
    })
  }
}
