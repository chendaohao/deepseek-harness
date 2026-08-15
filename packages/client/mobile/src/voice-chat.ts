/**
 * VoiceChatController: the voice conversation state machine over one paired
 * host session. It owns session selection, history reconstruction, live event
 * folding (watermark-deduplicated), the listen -> transcript -> auto-send
 * loop, barge-in (stop speech + cancel the running turn), and the speak
 * queue. Transport concerns live in MobileConnection; device speech lives in
 * the injected recognizer/speaker ports.
 * @module @deepseek-ai/dsh-client-mobile
 */

import type { MuxFrame, RpcId, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { MobileApiClient } from './client.ts'
import { MobileConnection } from './connection.ts'
import { UnauthorizedError } from './errors.ts'
import { SpeakQueue, type SpeakPort } from './speak-queue.ts'
import type {
  ApprovalOutcome, ChatMessage, ConnectionStatus, ListenerStatus, PendingApproval,
  PendingQuestion, QuestionAnswerItem, SpeechRecognizerPort, SpeechSpeakerPort,
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

/** First text block nested anywhere in a content list (tool-result blocks recurse). */
function firstTextBlock(content: readonly ContentBlock[]): string | null {
  for (const block of content) {
    if (block.type === 'text' && block.text !== '') return block.text
    if (block.type === 'tool-result' && block.content !== undefined) {
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
    this.sessionId = options.sessionId === undefined ? null : options.sessionId as SessionId
    this.speakQueue = new SpeakQueue({
      autoSpeak: this.autoSpeak,
      port: this.speakPort(),
      onSpeakingChange: (speaking) => {
        this.speaking = speaking
        this.publish()
      },
    })
  }

  /** The speak port the queue consumes: closes over the live language. */
  private speakPort(): SpeakPort {
    return {
      speak: (text, onDone, onError) => { this.speaker.speak(text, this.language, onDone, onError) },
      stop: () => { this.speaker.stop() },
    }
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
        void this.sendPrompt(trimmed)
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

  /** Send one text prompt (typed input path). */
  submitText(text: string): void {
    const trimmed = text.trim()
    if (trimmed === '' || this.disposed) return
    void this.sendPrompt(trimmed)
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

  /** Switch the ASR/TTS language (applies from the next utterance). */
  setLanguage(language: string): void {
    this.language = language
    this.publish()
  }

  /** Toggle automatic speaking of assistant replies. */
  setAutoSpeak(enabled: boolean): void {
    if (!enabled) this.speakQueue.clear()
    this.autoSpeak = enabled
    this.speakQueue = new SpeakQueue({
      autoSpeak: enabled,
      port: this.speakPort(),
      onSpeakingChange: (speaking) => {
        this.speaking = speaking
        this.publish()
      },
    })
    this.publish()
  }

  /** Answer the pending approval (allowed-once or rejected). */
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

  /** Answer the pending question batch. */
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
      this.pendingApproval = { frameRpcId: envelope.rpcId, approvalId: String(frame.approvalId), toolName: frame.toolName }
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
          options: question.options?.map(option => ({ label: option.label })) ?? [],
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
        if (live) this.speakQueue.flushRemainder()
        break
      case 'user/message': {
        const text = textOfContent(event.data.content)
        if (live) {
          const index = this.pendingTexts.indexOf(text)
          if (index !== -1) {
            this.pendingTexts.splice(index, 1)
            break
          }
        }
        if (text === '') break
        this.messages = [...this.messages, { kind: 'user', text, seq: event.seq }]
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

  private async sendPrompt(text: string): Promise<void> {
    /* v8 ignore next -- every caller (onFinal, submitText) guards disposed first */
    if (this.disposed) return
    let sessionId = this.sessionId
    if (sessionId === null) {
      sessionId = await this.ensureSession()
      if (sessionId === null) return
    }
    this.pendingTexts.push(text)
    this.messages = [...this.messages, { kind: 'user', text, seq: this.watermark + 1 }]
    this.publish()
    try {
      const timeZone = currentTimeZone()
      const response = await this.client.sessions.prompt({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        ...timeZone === undefined ? {} : { clientTimeZone: timeZone },
      })
      if (!response.result.ok) {
        // No echo will come for a rejected prompt: drop the dedupe entry so a
        // later identical third-party message is not swallowed.
        this.dropPendingText(text)
        this.listener = 'idle'
        this.notice = response.result.error.message
        this.publish()
      }
    } catch (error) {
      this.dropPendingText(text)
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
        : { approvalId: this.pendingApproval.approvalId, toolName: this.pendingApproval.toolName },
      pendingQuestion: this.pendingQuestion,
      interim: this.interim,
      notice: this.notice,
      autoSpeak: this.autoSpeak,
      language: this.language,
      sessionId: this.sessionId ?? '',
    })
  }
}
