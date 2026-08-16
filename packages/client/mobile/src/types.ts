/**
 * Mobile voice client view types: the JSON-compatible vocabulary the Expo app
 * renders. These are pure projections of wire events — host types never cross
 * this package's public boundary.
 * @module @deepseek-ai/dsh-client-mobile
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** One chat message in the conversation view. */
export type ChatMessage =
  | {
    readonly kind: 'user'
    readonly text: string
    /** Durable image refs the host saved from the prompt's image parts. */
    readonly images: readonly ImageAttachmentRef[]
    readonly seq: number
  }
  | {
    readonly kind: 'assistant'
    readonly text: string
    readonly complete: boolean
    /** Event seq of the message's first chunk; orders the message in the flow. */
    readonly seq: number
  }

/** One tool activity row shown in the conversation flow (web-style inline row). */
export interface ToolStatusLine {
  /** Tool call id echoed across the matching call/result events. */
  readonly id: string
  /** Tool name, e.g. "bash". */
  readonly name: string
  /** 'running' while the tool works; 'done' on success; 'error' when the result reports a failure. */
  readonly status: 'running' | 'done' | 'error'
  /** Raw arguments JSON exactly as the model produced them. */
  readonly argumentsText: string
  /** First text block of the result, bounded for the row's expanded detail; null while running. */
  readonly resultSummary: string | null
  /** Event seq of the tool/call; orders the row in the flow and joins the result. */
  readonly seq: number
}

/** A pending approval the user must answer for the agent to continue. */
export interface PendingApproval {
  readonly approvalId: string
  readonly toolName: string
  /** Model-authored justification carried by the approval frame; absent when the model wrote none. */
  readonly reason?: string
  /** Id of the tool call this approval gates; joins ToolStatusLine.id so the card can show the command. */
  readonly callId?: string
}

/** One question inside a pending ask_user_question batch. */
export interface PendingQuestionItem {
  readonly id: string
  readonly question: string
  /** Short heading the model asked to show above the question. */
  readonly header?: string
  /** Supporting detail rendered under the question text. */
  readonly detail?: string
  /** Whether several options may be selected at once (the answer then carries them together). */
  readonly multiSelect: boolean
  readonly options: readonly { readonly label: string; readonly description?: string }[]
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

/** One session in the host's session list. */
export interface SessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  /** Current normalized title (the 'title' projection the host lists); absent while none has landed. */
  readonly title?: string
  /** Session working directory as the host recorded it; absent when unrecorded. */
  readonly cwd?: string
}

/** One selectable model in the session's model catalog. */
export interface ModelOption {
  readonly id: string
  readonly name: string
  readonly provider: string
}

/** One todo item shown in the flow's todo panel. */
export interface TodoItemView {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** One content part of a prompt: text or a canonical-base64 image. */
export type PromptPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    readonly data: string
    readonly name?: string
  }

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
  /** Start listening automatically after each finished turn. */
  readonly autoListen: boolean
  /** TTS speech rate, 0.5..2.0. */
  readonly ttsRate: number
  /** TTS pitch, 0.5..2.0. */
  readonly ttsPitch: number
  /** Plan mode is in force for the current session. */
  readonly planActive: boolean
  /** Latest todo/write projection for the current session. */
  readonly todos: readonly TodoItemView[]
  /** Last selected model id (memory only; the host's default applies on start). */
  readonly selectedModel: string | null
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
  /**
   * Speak one utterance with the given rate/pitch; exactly one of onDone/onError fires per call.
   * @param text - utterance text.
   * @param language - BCP-47 language tag.
   * @param rate - speech rate, 0.5..2.0.
   * @param pitch - speech pitch, 0.5..2.0.
   * @param onDone - fired when the utterance finishes.
   * @param onError - fired with a user-visible message when the utterance fails.
   */
  speak(text: string, language: string, rate: number, pitch: number, onDone: () => void, onError: (message: string) => void): void
  /** Stop the current utterance immediately (its onDone never fires). */
  stop(): void
}

/** fetch-shaped transport the app injects (expo/fetch on device, global fetch in tests). */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>
