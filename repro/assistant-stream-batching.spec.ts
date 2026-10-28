/**
 * Standalone before/after harness for the Assistant streaming path between the
 * Host's follow socket and the Client's event feed.
 *
 * Three fixed workloads. The first and third measure the production Client
 * objects (`SessionEventStream` -> `Session` -> `ClientAssistantStream` ->
 * `MutableSessionEventSource` -> `Notifier`); the second drives the real Host
 * `SessionHistoryController` so its batching is what gets measured.
 *
 *  1. burst      - 1000 chunks arriving back to back, framed exactly as the Host
 *                  currently frames them (one `assistant-stream` frame, then
 *                  `assistant-stream-batch` frames of `assistantStreamBatchSize`).
 *  2. paced      - 50 chunks at 10, 20, and 50 ms producer cadences, emitted as
 *                  Agent frames into the Host's own follow path and read back
 *                  through `SessionEventStream`. Reports wire messages, batched
 *                  messages, publications, and first/tail latency against the
 *                  producer's own budget. Only the 10 ms cadence is fast enough
 *                  for several chunks to land inside one batching deadline; the
 *                  20 and 50 ms cadences exceed it, so they send one frame per
 *                  chunk and act as the control.
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
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore from '@deepseek-ai/dsh-session'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { SessionHistoryController } from '../packages/api/session-controller/src/history.ts'
import {
  installSessionReadTestServices,
} from '../packages/api/session-controller/tests/test-remote.ts'
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
/** Producer cadences the Host batching defaults are judged against. */
const PACED_CADENCES_MS = [10, 20, 50]
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

interface PacedReport {
  readonly intervalMs: number
  readonly chunks: number
  readonly deliveredChunks: number
  /** Host messages the Client read: single frames plus batches. */
  readonly wireFrames: number
  /** Chunks each message carried, so a batch is counted once. */
  readonly batchFrames: number
  readonly eventPublications: number
  readonly firstChunkMs: number
  readonly tailChunkMs: number
  readonly producerBudgetMs: number
}

/**
 * Drive paced chunks through the real Host follow and the real Client fold.
 *
 * The Host's batching is what these numbers are about, so the frames are emitted
 * as Agent frames into `SessionHistoryController` and read back through
 * `SessionEventStream` — not scripted on the mock, which would only measure the
 * Client against an assumed wire shape.
 * @param intervals - producer cadences to measure, in milliseconds.
 * @returns one report per cadence.
 */
async function measurePacedThroughHost(intervals: readonly number[]): Promise<PacedReport[]> {
  const reports: PacedReport[] = []
  for (const intervalMs of intervals) reports.push(await measureOne(intervalMs))
  return reports
}

async function measureOne(intervalMs: number): Promise<PacedReport> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  try {
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    // Batch size 1 would flush every chunk alone and measure nothing; the Host
    // default is what the product runs, so the deadline is what is under test.
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })

    const fold = new ClientAssistantStream()
    const abort = new AbortController()
    const arrivals: number[] = []
    let wireFrames = 0
    let batchFrames = 0
    let chunks = 0
    let publications = 0
    const started = performance.now()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    // The opening snapshot precedes any chunk; the producer below emits into a
    // live follow, which is the path a paced model response takes.
    // The opening snapshot fixes the ordinal cut; emitting before it lands
    // would place the start frame behind that cut and drop the whole attempt.
    const opened = Promise.withResolvers<undefined>()
    const produce = (async () => {
      await opened.promise
      ctx.emit('agent/assistant-stream', {
        agent,
        frame: { type: 'start', attemptId: ATTEMPT, revision: 1, turn: 1, step: 1 },
      })
      for (let index = 0; index < PACED_CHUNKS; index++) {
        const due = started + index * intervalMs
        const wait = due - performance.now()
        if (wait > 0) await new Promise<void>((resolve) => { setTimeout(resolve, wait) })
        ctx.emit('agent/assistant-stream', {
          agent,
          frame: {
            type: 'chunk',
            attemptId: ATTEMPT,
            revision: index + 2,
            index,
            time: index,
            chunk: { type: 'text-delta', index: 0, text: 'token ' },
          },
        })
      }
    })()

    try {
      const deadline = started + PACED_CHUNKS * intervalMs + 30_000
      while (chunks < PACED_CHUNKS && performance.now() < deadline) {
        const step = await iterator.next()
        if (step.done) break
        const frame = step.value
        if (frame.type === 'snapshot') {
          opened.resolve(undefined)
          continue
        }
        if (frame.type === 'assistant-stream') {
          wireFrames += 1
          const result = fold.acceptFrame(frame.frame)
          if (result?.type === 'transient') { chunks += 1; publications += 1 }
          arrivals.push(performance.now() - started)
          continue
        }
        if (frame.type === 'assistant-stream-batch') {
          wireFrames += 1
          batchFrames += 1
          const { transients } = fold.acceptFrames(frame.frames)
          chunks += transients.length
          if (transients.length > 0) publications += 1
          arrivals.push(performance.now() - started)
        }
      }
    } finally {
      abort.abort()
      await iterator.next().catch(() => undefined)
      await produce
    }

    return {
      intervalMs,
      chunks: PACED_CHUNKS,
      deliveredChunks: chunks,
      wireFrames,
      batchFrames,
      eventPublications: publications,
      firstChunkMs: arrivals[0] ?? Number.NaN,
      tailChunkMs: arrivals.at(-1) ?? Number.NaN,
      producerBudgetMs: (PACED_CHUNKS - 1) * intervalMs,
    }
  } finally {
    await ctx.fiber.dispose()
  }
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

  it('measures paced chunks through the Host follow path at three cadences', { timeout: 120_000 }, async () => {
    const reports = await measurePacedThroughHost(PACED_CADENCES_MS)
    for (const report of reports) {
      console.log(JSON.stringify({ benchmark: 'assistant-stream/paced-host', ...report }))
    }
    // Every chunk must still reach the Client: batching changes how many frames
    // carry them, never whether one is delivered.
    for (const report of reports) expect(report.deliveredChunks).toBe(PACED_CHUNKS)
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
