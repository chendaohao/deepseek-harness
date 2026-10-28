/** Process-local assistant state retained for reconnecting Web followers. */

import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm'
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SessionAssistantStreamAttempt,
  SessionAssistantStreamBaseline,
} from './types.ts'

interface MutableAttempt {
  readonly attemptId: SessionAssistantStreamAttempt['attemptId']
  readonly startedAfterSeq: SessionSeqCursor
  readonly turn: number
  readonly step: number
  readonly stream: AssistantStreamAccumulator
  nextIndex: number
}

const EMPTY_BASELINE: SessionAssistantStreamBaseline = { revision: 0 }

/**
 * Folds dense Agent frames and materializes one shared immutable reconnect
 * baseline per accepted revision.
 */
export class SessionAssistantStreamAccumulator {
  private activeAttempt: MutableAttempt | undefined
  private revision = 0
  private withStream: SessionAssistantStreamBaseline = EMPTY_BASELINE
  private metadataOnly: SessionAssistantStreamBaseline = EMPTY_BASELINE
  private dirty = false

  /**
   * Fold one trusted frame from the current attached Agent lifecycle.
   * @param frame - next dense process-local Assistant frame.
   * @param durableCursor - last committed Session seq when this frame was observed.
   */
  accept(frame: AssistantStreamFrame, durableCursor: SessionSeqCursor): void {
    if (frame.type === 'start' && frame.revision === 1 && this.revision !== 0) {
      this.activeAttempt = undefined
      this.revision = 0
    }
    if (frame.revision !== this.revision + 1) {
      this.activeAttempt = undefined
      this.revision = frame.revision
      this.dirty = true
      return
    }
    this.revision = frame.revision
    switch (frame.type) {
      case 'start':
        this.activeAttempt = {
          attemptId: frame.attemptId,
          startedAfterSeq: durableCursor,
          turn: frame.turn,
          step: frame.step,
          stream: new AssistantStreamAccumulator(),
          nextIndex: 0,
        }
        break
      case 'chunk': {
        const attempt = this.activeAttempt
        if (attempt === undefined
          || attempt.attemptId !== frame.attemptId
          || frame.index !== attempt.nextIndex) {
          this.activeAttempt = undefined
          break
        }
        attempt.stream.push({ time: frame.time, chunk: frame.chunk })
        attempt.nextIndex += 1
        break
      }
      case 'end':
        this.activeAttempt = undefined
        break
    }
    this.dirty = true
  }

  /**
   * Read the cached reconnect baseline, materializing it after a state change.
   * @returns the identity-stable baseline for the latest accepted revision.
   */
  snapshot(): SessionAssistantStreamBaseline {
    return this.materialize(true)
  }

  /**
   * Read the reconnect baseline without the accumulated stream.
   *
   * A caller that already holds the durable events this attempt preceded can
   * rebuild the transient prefix from its own log, so the compact copy of that
   * prefix only costs bytes on the wire and an expansion it cannot use. The
   * attempt's cursor metadata still lets it accept the frames that follow.
   * @returns the identity-stable metadata-only baseline for the latest accepted revision.
   */
  metadataSnapshot(): SessionAssistantStreamBaseline {
    return this.materialize(false)
  }

  private materialize(withStream: boolean): SessionAssistantStreamBaseline {
    if (!this.dirty) return withStream ? this.withStream : this.metadataOnly
    const activeAttempt = this.activeAttempt
    if (activeAttempt === undefined) {
      this.metadataOnly = { revision: this.revision }
      this.withStream = this.metadataOnly
    } else {
      const attempt: SessionAssistantStreamAttempt = {
        attemptId: activeAttempt.attemptId,
        startedAfterSeq: activeAttempt.startedAfterSeq,
        turn: activeAttempt.turn,
        step: activeAttempt.step,
        nextIndex: activeAttempt.nextIndex,
        stream: [],
      }
      this.metadataOnly = { revision: this.revision, activeAttempt: attempt }
      this.withStream = {
        revision: this.revision,
        activeAttempt: {
          ...attempt,
          stream: activeAttempt.stream.snapshot() as unknown as readonly JsonValue[],
        },
      }
    }
    this.dirty = false
    return withStream ? this.withStream : this.metadataOnly
  }
}
