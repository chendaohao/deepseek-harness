/**
 * Standalone before/after harness for the Assistant streaming path between the
 * Host's follow socket and the Client's event feed.
 *
 * Three fixed workloads, all measured through the production Client objects
 * (`SessionEventStream` -> `Session` -> `ClientAssistantStream` ->
 * `MutableSessionEventSource` -> `Notifier`), not through copies of that code:
 *
 *  1. burst      - 1000 chunks arriving back to back, framed exactly as the Host
 *                  currently frames them (one `assistant-stream` frame, then
 *                  `assistant-stream-batch` frames of `assistantStreamBatchSize`).
 *  2. paced      - the same chunks on a 20 ms cadence, reporting first/chunk/tail
 *                  latency and the number of wakeups that carried no work.
 *  3. reconnect  - a continued reconnect while a 100,000-delta reasoning prefix
 *                  is live, measuring the baseline bytes on the wire and the
 *                  `replace()` fold that currently expands the whole prefix.
 *
 * It is a diagnostic, not a gate: nothing here asserts a budget, so it runs
 * identically before and after a change. Compare the printed JSON.
 *
 *   pnpm vitest run --config repro/vitest.config.ts repro/assistant-stream-batching.spec.ts
 */

import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { SessionAssistantStreamAccumulator } from '../packages/api/session-controller/src/assistant-stream.ts'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest } from '../packages/test-support/client-runtime/src/assembly/vitest.ts'
import { webApp } from '../packages/test-support/client-runtime/src/assembly/bundle-roster.ts'
import type { SessionAssistantStreamFrame } from '../packages/api/session-controller/src/types.ts'
import { ClientAssistantStream } from '../packages/api/session-controller/src/client/sessions/assistant-stream.ts'
import type { SessionLiveEventEntry } from '../packages/api/session-controller/src/client/contract/events.ts'
import { sessionBench } from '../packages/api/session-controller/tests/remote/bench.client.ts'
import { FOLLOW, followScript, history } from '../packages/api/session-controller/tests/remote/session.client.ts'

const API_ROSTER = webApp.closure(['@deepseek-ai/dsh-api-gateway'])
const itLive = createClientTest({ roster: API_ROSTER })
const SID = 'repro-stream' as SessionId
const ATTEMPT = LlmAttemptId('repro-attempt')
/** Host default; the frame count below is derived from it, not assumed. */
const HOST_BATCH_SIZE = 64
const CHUNKS = 1000
const PACED_CHUNKS = 50
const PACED_INTERVAL_MS = 20
const RECONNECT_DELTAS = 100_000

function chunkFrame(revision: number, index: number): SessionAssistantStreamFrame {
  return {
    type: 'chunk',
    attemptId: ATTEMPT,
    revision,
    index,
    time: 1_700_000_000_000 + index,
    chunk: { type: 'text-delta', index: 0, text: 'token ' },
  }
}

function startFrame(): SessionAssistantStreamFrame {
  return {
    type: 'start',
    attemptId: ATTEMPT,
    revision: 1,
    startedAfterSeq: -1,
    turn: 1,
    step: 1,
  }
}

/**
 * Frames in the order the Host currently emits them: the attempt start, the
 * first chunk alone (the Host flushes and opens the batch on the first chunk),
 * then full batches and the remainder.
 */
function hostFrames(count: number): SessionAssistantStreamFrame[] {
  const frames: SessionAssistantStreamFrame[] = []
  let revision = 2
  for (let index = 0; index < count; index++) {
    frames.push(chunkFrame(revision, index))
    revision += 1
  }
  return frames
}

/** Group chunk frames the way `assistantStreamBatchSize` splits them. */
function hostBatches(frames: readonly SessionAssistantStreamFrame[]): SessionAssistantStreamFrame[][] {
  const batches: SessionAssistantStreamFrame[][] = []
  for (let index = 0; index < frames.length; index += HOST_BATCH_SIZE) {
    batches.push(frames.slice(index, index + HOST_BATCH_SIZE))
  }
  return batches
}

interface BurstReport {
  readonly chunks: number
  readonly transportFrames: number
  readonly eventPublications: number
  readonly subscriberNotifications: number
  readonly wireBytes: number
  readonly elapsedMs: number
}

describe('Assistant stream batching baseline', () => {
  itLive('measures a 1000-chunk burst through the assembled Client Session', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history([]), { assistantStream: { revision: 0 } }))
    await session.open()
    expect(session.getSnapshot().openState).toBe('open')

    const frames = hostFrames(CHUNKS)
    const batches = hostBatches(frames)
    const windowRevisionStart = session.eventSource.getSnapshot().revision
    let notifications = 0
    session.subscribe(() => { notifications += 1 })

    const transportFrames = batches.length + 1
    const wireBytes = JSON.stringify({ start: startFrame(), batches }).length

    const started = performance.now()
    mock.streams.push(FOLLOW, { type: 'assistant-stream', frame: startFrame() })
    for (const batch of batches) mock.streams.push(FOLLOW, { type: 'assistant-stream-batch', frames: batch })
    await mock.streams.drained(FOLLOW)
    await Promise.resolve()
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })
    const elapsedMs = performance.now() - started

    const report: BurstReport = {
      chunks: CHUNKS,
      transportFrames,
      eventPublications: session.eventSource.getSnapshot().revision - windowRevisionStart,
      subscriberNotifications: notifications,
      wireBytes,
      elapsedMs,
    }
    console.log(JSON.stringify({ benchmark: 'assistant-stream/burst', ...report }))
    // The fold must have accepted every chunk: one transient row per chunk is
    // what the publication count above is counting.
    expect(session.eventSource.getSnapshot().entries.filter(entry => entry.type === 'transient'))
      .toHaveLength(CHUNKS)
  })

  itLive('measures a paced 1000-chunk stream and its idle wakeups', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history([]), { assistantStream: { revision: 0 } }))
    await session.open()

    const frames = hostFrames(PACED_CHUNKS)
    let notifications = 0
    let publications = 0
    session.subscribe(() => { notifications += 1 })
    session.eventSource.subscribe(() => { publications += 1 })
    const windowRevisionStart = session.eventSource.getSnapshot().revision

    // One chunk per tick on the Host's own single-frame path: this is what a
    // paced producer looks like on the wire today, unaffected by batching.
    mock.streams.push(FOLLOW, { type: 'assistant-stream', frame: startFrame() })
    const arrivals: number[] = []
    const started = performance.now()
    for (const [index, frame] of frames.entries()) {
      const due = started + index * PACED_INTERVAL_MS
      const wait = due - performance.now()
      if (wait > 0) await new Promise<void>((resolve) => { setTimeout(resolve, wait) })
      mock.streams.push(FOLLOW, { type: 'assistant-stream', frame })
      await mock.streams.drained(FOLLOW)
      arrivals.push(performance.now() - started)
    }
    const totalMs = performance.now() - started
    const firstMs = arrivals[0]!
    const tailMs = arrivals.at(-1)!
    const budgetMs = (PACED_CHUNKS - 1) * PACED_INTERVAL_MS
    // Frames the consumer was woken for beyond the paced producer's own tick:
    // a wakeup that carries no new durable or transient work.
    const idleWakeups = notifications + publications
      - (session.eventSource.getSnapshot().revision - windowRevisionStart)

    console.log(JSON.stringify({
      benchmark: 'assistant-stream/paced',
      chunks: PACED_CHUNKS,
      intervalMs: PACED_INTERVAL_MS,
      totalMs,
      producerBudgetMs: budgetMs,
      firstChunkMs: firstMs,
      tailChunkMs: tailMs,
      eventPublications: session.eventSource.getSnapshot().revision - windowRevisionStart,
      subscriberNotifications: notifications,
      feedPublications: publications,
      idleWakeups,
    }))
    expect(session.eventSource.getSnapshot().entries.filter(entry => entry.type === 'transient'))
      .toHaveLength(PACED_CHUNKS)
  })

  it('measures a continued reconnect over a 100000-delta live prefix', () => {
    const accumulator = new SessionAssistantStreamAccumulator()
    let revision = 1
    accumulator.accept({ type: 'start', attemptId: ATTEMPT, revision, turn: 1, step: 1 }, 0)
    for (let index = 0; index < RECONNECT_DELTAS; index++) {
      revision += 1
      accumulator.accept({
        type: 'chunk',
        attemptId: ATTEMPT,
        revision,
        index,
        time: 1_700_000_000_001 + index,
        chunk: { type: 'reasoning-delta', index: 0, text: 'token ' },
      }, 0)
    }
    // Both baselines the Host can send: the ordinary opening's compact prefix
    // and the continuation's metadata-only one.
    const full = accumulator.snapshot()
    const metadataOnly = accumulator.metadataSnapshot()

    // The held durable window a `continueWindow` reseed runs over: the fold
    // re-publishes exactly one durable entry per held event.
    const held = Array.from({ length: 100 }, (_, index): SessionLiveEventEntry => ({
      type: 'event',
      event: {
        type: 'turn/start',
        seq: index,
        time: index,
        data: { turn: 1 },
      } as never,
    }))

    // The ordinary opening: the prefix is expanded into transient rows.
    const replacing = new ClientAssistantStream()
    const replaceStart = performance.now()
    const visible = replacing.replace(held, full)
    const replaceMs = performance.now() - replaceStart

    // The continuation: the client holds the durable window and discards a
    // reconstructed prefix, so it skips the expansion entirely.
    const reseeding = new ClientAssistantStream()
    const reseedStart = performance.now()
    const reseeded = reseeding.replace(held, metadataOnly, false)
    const reseedMs = performance.now() - reseedStart

    console.log(JSON.stringify({
      benchmark: 'assistant-stream/continued-reconnect',
      deltas: RECONNECT_DELTAS,
      heldEntries: held.length,
      full: {
        baselineBytes: JSON.stringify(full.activeAttempt?.stream ?? []).length,
        baselineRecords: full.activeAttempt?.stream.length ?? 0,
        replaceMs,
        reconstructedTransients: visible.filter(entry => entry.type === 'transient').length,
        visibleEntries: visible.length,
      },
      metadataOnly: {
        baselineBytes: JSON.stringify(metadataOnly.activeAttempt?.stream ?? []).length,
        baselineRecords: metadataOnly.activeAttempt?.stream.length ?? 0,
        reseedMs,
        reconstructedTransients: reseeded.filter(entry => entry.type === 'transient').length,
        visibleEntries: reseeded.length,
      },
    }))
    // The continuation carries the attempt's cursor metadata and no prefix.
    expect(metadataOnly.activeAttempt?.nextIndex).toBe(full.activeAttempt?.nextIndex)
    expect(metadataOnly.activeAttempt?.stream).toEqual([])
    expect(reseeded.filter(entry => entry.type === 'transient')).toHaveLength(0)
  })
})
