/**
 * Per-session question-draft store: persists the ask_user_question composer's
 * in-progress answers by question key so a connection-generation death (which
 * unmounts the composer) or a full page reload does not discard what the user
 * already typed. Keyed by the stable `q:<rpcId>` question key, so an old
 * question's drafts never collide with a later one's (each ask mints a fresh
 * rpcId). The composer clears the keyed entry on settle or cancel; only a
 * question superseded within a live session without settling leaves an
 * orphaned entry, and it is never read again (session teardown prunes the
 * whole store).
 */
import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { QuestionDraftAnswer } from './contract/slots.ts'

/** Declared action set for the draft store (pure draft mutators). */
type QuestionDraftActions = {
  /** Save one question batch's drafts under its key. */
  setDrafts: (draft: QuestionDraftState, key: string, values: QuestionDraftAnswer[]) => void
  /** Record which question the user was last on, to resume the same step. */
  setPosition: (draft: QuestionDraftState, key: string, position: number) => void
  /** Drop one question batch's drafts (called on settle/cancel). */
  clearDrafts: (draft: QuestionDraftState, key: string) => void
}

/** Draft store state: question key -> the batch's per-question drafts. */
export interface QuestionDraftState {
  drafts: Record<string, QuestionDraftAnswer[]>
  /** Question key -> the last question index the user was on (resumed on remount). */
  positions: Record<string, number>
}

/**
 * Handle type of {@link createQuestionDraftStore}'s product, for the slot
 * `store:` seat and the component's `PropsStore` share.
 */
export type QuestionDraftStore = ReturnType<typeof createQuestionDraftStore>

/**
 * Declare the per-session question-draft store. Persisted under
 * `dsh.ui.userQuestions.drafts.<sessionId>` by the framework, so resync (same
 * session) and page reload both restore the drafts. Mirrors `createChatStore`.
 * @returns the store handle.
 */
export function createQuestionDraftStore(): ReturnType<typeof defineStore<QuestionDraftState, QuestionDraftActions>> {
  return defineStore({
    init: (): QuestionDraftState => ({ drafts: {}, positions: {} }),
    persist: 'dsh.ui.userQuestions.drafts',
    actions: {
      setDrafts: (draft, key, values) => {
        draft.drafts[key] = values
      },
      setPosition: (draft, key, position) => {
        draft.positions[key] = position
      },
      clearDrafts: (draft, key) => {
        draft.drafts = Object.fromEntries(
          Object.entries(draft.drafts).filter(([k]) => k !== key))
        draft.positions = Object.fromEntries(
          Object.entries(draft.positions).filter(([k]) => k !== key))
      },
    },
  })
}
