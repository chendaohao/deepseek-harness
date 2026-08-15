/**
 * Mobile voice client view types: the JSON-compatible vocabulary the Expo app
 * renders. These are pure projections of wire events — host types never cross
 * this package's public boundary.
 * @module @deepseek-ai/dsh-client-mobile
 */

/** One chat message in the conversation view. */
export type ChatMessage =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string; readonly complete: boolean }

/** One tool activity line shown while the agent works. */
export interface ToolStatusLine {
  /** Tool call id echoed across the matching call/result events. */
  readonly id: string
  /** Tool name, e.g. "bash". */
  readonly name: string
  /** Whether the matching result has arrived. */
  readonly done: boolean
}

/** A pending approval the user must answer for the agent to continue. */
export interface PendingApproval {
  readonly approvalId: string
  readonly toolName: string
}

/** One question inside a pending ask_user_question batch. */
export interface PendingQuestionItem {
  readonly id: string
  readonly question: string
  readonly options: readonly { readonly label: string }[]
}

/** A pending question batch the agent asked through ask_user_question. */
export interface PendingQuestion {
  readonly questionRpcId: string
  readonly questions: readonly PendingQuestionItem[]
}

/** How the transport currently stands. */
export type ConnectionStatus = 'connecting' | 'online' | 'reconnecting' | 'needsPairing' | 'failed'

/** What the microphone loop is doing. */
export type ListenerStatus = 'idle' | 'listening' | 'processing'

/** Snapshot published after every state mutation. */
export interface VoiceChatSnapshot {
  readonly connection: ConnectionStatus
  readonly listener: ListenerStatus
  /** An agent turn is running. */
  readonly turnRunning: boolean
  /** The speaker is currently producing audio. */
  readonly speaking: boolean
  readonly messages: readonly ChatMessage[]
  readonly toolLines: readonly ToolStatusLine[]
  readonly pendingApproval: PendingApproval | null
  readonly pendingQuestion: PendingQuestion | null
  /** Current interim transcript while listening. */
  readonly interim: string
  /** One-shot notice for the user; cleared by acknowledgeNotice(). */
  readonly notice: string | null
  readonly autoSpeak: boolean
  readonly language: string
  readonly sessionId: string
}

/** Answer accepted for an approval request. */
export type ApprovalOutcome = 'allowed-once' | 'rejected'

/** One answer inside a question batch answer. */
export interface QuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** Device speech recognizer, injected by the app (expo-speech-recognition). */
export interface SpeechRecognizerPort {
  /** Whether the platform can recognize speech at all. */
  readonly available: boolean
  /**
   * Begin recognition. Interim results flow to onInterim; the platform's final
   * result (or manual stop) flows to onFinal once; onError reports a
   * user-visible failure and ends the session.
   * @param handlers - interim/final/error callbacks.
   * @param language - BCP-47 language tag, e.g. "zh-CN".
   */
  start(handlers: RecognizerHandlers, language: string): Promise<void>
  /** End recognition; pending final results still fire through onFinal. */
  stop(): Promise<void>
}

/** Callbacks a recognizer reports through. */
export interface RecognizerHandlers {
  onInterim(text: string): void
  onFinal(text: string): void
  onError(message: string): void
}

/** Device speech synthesizer, injected by the app (expo-speech). */
export interface SpeechSpeakerPort {
  /** Speak one utterance; exactly one of onDone/onError fires per call. */
  speak(text: string, language: string, onDone: () => void, onError: (message: string) => void): void
  /** Stop the current utterance immediately (its onDone never fires). */
  stop(): void
}

/** fetch-shaped transport the app injects (expo/fetch on device, global fetch in tests). */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>
