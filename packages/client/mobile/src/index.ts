/**
 * Public API of the DSH mobile voice client core.
 *
 * The package is a plain library for the native Expo app, not a cordis
 * plugin: it reuses the host's wire protocol (AbstractApiClient + apiproxy
 * schemas) and the remote-access pairing gate, and contributes the voice
 * conversation state machines. The app injects device speech (recognizer /
 * speaker), fetch, and secure storage; everything here is platform-neutral
 * and fully unit-testable.
 * @module @deepseek-ai/dsh-client-mobile
 */

export { MobileApiClient, type MobileApiClientOptions, type SocketFactory, type SocketLike } from './client.ts'
export { MobileConnection, type MobileConnectionCallbacks, type MobileConnectionOptions } from './connection.ts'
export { PairingError, UnauthorizedError, type PairingFailure } from './errors.ts'
export {
  extractSessionCookie, pairWithHost, parsePairingUrl,
  type PairingRecord, type ParsedPairingUrl,
} from './pairing.ts'
export { ensureAbortSignalStatics, randomUuid } from './shims.ts'
export { SpeakQueue, speakableText, splitSentences, type SpeakPort, type SpeakQueueOptions } from './speak-queue.ts'
export { VoiceChatController, type VoiceChatOptions } from './voice-chat.ts'
export type {
  ApprovalOutcome, ChatMessage, ConnectionStatus, FetchLike, ListenerStatus,
  ModelOption, PendingApproval, PendingQuestion, PendingQuestionItem, PromptPart,
  QuestionAnswerItem, RecognizerHandlers, SessionSummary, SpeechRecognizerPort,
  SpeechSpeakerPort, TodoItemView, ToolStatusLine, VoiceChatSnapshot,
} from './types.ts'
