/**
 * Diagnostic: does the Proxy-to-Host hop earn its `permessage-deflate` cost?
 *
 * Threshold-free. Each sample is one fresh child process that runs the real
 * `RemoteStreamMuxServer`, the real `createRemoteProxy`, and a `ws` client over
 * loopback, then reports whole-path process CPU, wall time, frame gaps, and the
 * bytes the client read. Variants A and B are run interleaved with an A/A control
 * so the report can state a noise floor instead of comparing two single numbers.
 *
 * Both measured classes are unexported, so the worker resolves source through
 * `remote-stream-adapter.ts`; the report says so rather than claiming published
 * artifacts. Model generation, Assistant batching, Client fold, browser paint,
 * cloudflared, and public-network latency are excluded.
 *
 * This file is not a gate. `benchmarks/` and `test:bench` own calibrated budgets;
 * see the owning Agent Note for the lane decision.
 */

import { spawnSync } from 'node:child_process'
import { arch, cpus, platform, release } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { ANSWER_FRAMES, SMALL_FRAME_COUNT, UPLINK_LARGE_BYTES, UPLINK_SMALL_BYTES } from './remote-stream-workload.ts'
import type { RemoteStreamSample, Variant } from './remote-stream.worker.ts'

/** Fresh processes per variant; enough for a median and a spread, few enough to bound the run. */
const SAMPLES = 7
/** One sample's hard deadline; a stuck child is reaped rather than left holding sockets. */
const SAMPLE_TIMEOUT_MS = 180_000

const VARIANTS = {
  /** Current topology: both hops negotiate permessage-deflate. */
  A: { gateway: 'deflate', proxy: 'deflate' },
  /** Stage 2's target: the Host-facing hop sends plaintext, the remote-facing hop keeps compression. */
  B: { gateway: 'none', proxy: 'deflate' },
} as const satisfies Record<string, Variant>

type VariantKey = keyof typeof VARIANTS

/** One sample plus which variant's schedule slot produced it. */
interface Run extends RemoteStreamSample {
  readonly slot: VariantKey
  readonly sampleIndex: number
}

/** Aggregate of one variant's samples. */
interface Summary {
  readonly samples: readonly number[]
  readonly min: number
  readonly median: number
  readonly max: number
}

/**
 * Run one sample in a fresh child process.
 * @param variant - variant key to measure.
 * @param sampleIndex - position in the interleaved schedule, echoed into the report.
 * @returns the child's published sample.
 * @throws If the child fails, times out, or reports an unmatching payload.
 */
function runSample(variant: VariantKey, sampleIndex: number): Run {
  const configuration = VARIANTS[variant]
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', join(import.meta.dirname, 'remote-stream.worker.ts'),
      configuration.gateway, configuration.proxy, String(sampleIndex)],
    {
      encoding: 'utf8',
      timeout: SAMPLE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      cwd: join(import.meta.dirname, '..', '..', '..', '..'),
      env: { ...process.env, NODE_OPTIONS: '' },
    },
  )
  if (child.error !== undefined) throw child.error
  assert.equal(child.signal, null, 'sample ' + variant + '#' + String(sampleIndex) + ' was reaped: ' + child.stderr)
  assert.equal(child.status, 0, 'sample ' + variant + '#' + String(sampleIndex) + ' failed: ' + child.stderr)
  const line = child.stdout.trim().split('\n').filter(candidate => candidate.startsWith('{')).at(-1)
  if (line === undefined) throw new Error('sample produced no report: ' + child.stdout + child.stderr)
  const sample = JSON.parse(line) as RemoteStreamSample
  assert.equal(sample.payloadsMatch, true, 'sample ' + variant + '#' + String(sampleIndex) + ' received altered payloads')
  assert.equal(sample.downlinkFrames, 1 + ANSWER_FRAMES + SMALL_FRAME_COUNT)
  assert.equal(sample.uplinkFrames, 2)
  return { ...sample, slot: variant, sampleIndex }
}

/**
 * Summarize one metric across samples.
 * @param runs - the variant's samples.
 * @param read - metric selector.
 * @returns minimum, median, and maximum.
 */
function summarize(runs: readonly Run[], read: (run: Run) => number): Summary {
  const samples = runs.map(read)
  const sorted = [...samples].sort((left, right) => left - right)
  const round = (value: number): number => Math.round(value * 100) / 100
  return {
    samples: samples.map(round),
    min: round(sorted[0] as number),
    median: round(sorted[Math.floor(sorted.length / 2)] as number),
    max: round(sorted[sorted.length - 1] as number),
  }
}

/**
 * Ratio of two medians, in percent.
 * @param baseline - reference median.
 * @param candidate - measured median.
 * @returns the candidate's percentage change relative to the baseline.
 */
function changePercent(baseline: number, candidate: number): number {
  return Math.round((candidate - baseline) / baseline * 10_000) / 100
}

/**
 * Interleaved schedule: A/A controls and A/B pairs alternate so drift affects
 * both variants, and no variant owns a contiguous stretch of the run.
 */
const SCHEDULE: readonly VariantKey[] = ['A', 'A', 'B', 'B', 'A', 'A', 'B', 'B', 'A', 'A', 'B', 'B', 'A', 'B']

// One discarded sample first: the opening children pay for the module cache and
// the OS file cache, and that cost lands entirely on whichever variant runs
// first. Every published sample is therefore a warm-process measurement.
process.stderr.write('warmup\n')
runSample('A', -1)

const runs: Run[] = []
for (const [index, variant] of SCHEDULE.entries()) {
  runs.push(runSample(variant, index))
  process.stderr.write('sample ' + String(index + 1) + '/' + String(SCHEDULE.length) + ' ' + variant + ' done\n')
}

const of = (variant: VariantKey): Run[] => runs.filter(run => run.slot === variant)
const a = of('A')
const b = of('B')
// The A/A floor: the largest absolute CPU difference between two A medians drawn
// from disjoint halves of the A samples. Any A-versus-B difference inside it is
// indistinguishable from run-to-run drift on this machine.
const aFirst = a.slice(0, Math.floor(a.length / 2))
const aSecond = a.slice(Math.floor(a.length / 2))
const noiseFloorPercent = Math.max(
  Math.abs(changePercent(summarize(aFirst, run => run.cpuMs).median, summarize(aSecond, run => run.cpuMs).median)),
  Math.abs(changePercent(summarize(aSecond, run => run.cpuMs).median, summarize(aFirst, run => run.cpuMs).median)),
)

const report = {
  revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  node: process.version,
  platform: platform(),
  release: release(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  workload: {
    samplesPerVariant: SAMPLES,
    openingBytes: '1.4 MiB repetitive JSON',
    answerFrames: ANSWER_FRAMES,
    smallFrames: SMALL_FRAME_COUNT,
    uplinkFrameBytes: [UPLINK_LARGE_BYTES, UPLINK_SMALL_BYTES],
  },
  clock: 'Timer starts after every handshake and the uplink drain; stops after the client validated every downlink payload. Process CPU is RUSAGE_SELF, so it includes libuv thread-pool zlib work in the same process.',
  memory: 'Peak RSS is cumulative from process start and includes fixture construction; retained RSS is read while the socket, payloads, and scripted streams are still reachable. No retained-memory budget.',
  exclusions: 'cloudflared, public-network latency, model generation, Assistant batching, Client fold, browser paint, and the interface-bound Host topology. Both measured classes resolve from source: neither is a published export.',
  noiseFloor: {
    method: 'Largest absolute CPU-median difference between two disjoint halves of the A samples.',
    cpuPercent: noiseFloorPercent,
  },
  variants: { A: VARIANTS.A, B: VARIANTS.B },
  runs,
  summary: {
    cpuMs: { A: summarize(a, run => run.cpuMs), B: summarize(b, run => run.cpuMs) },
    wallMs: { A: summarize(a, run => run.wallMs), B: summarize(b, run => run.wallMs) },
    p95FrameGapMs: { A: summarize(a, run => run.p95FrameGapMs), B: summarize(b, run => run.p95FrameGapMs) },
    remoteWireBytes: { A: summarize(a, run => run.remoteWireBytes), B: summarize(b, run => run.remoteWireBytes) },
    peakRssMb: { A: summarize(a, run => run.peakRssMb), B: summarize(b, run => run.peakRssMb) },
  },
}

const cpuChange = changePercent(
  summarize(a, run => run.cpuMs).median,
  summarize(b, run => run.cpuMs).median,
)
const wireChange = changePercent(
  summarize(a, run => run.remoteWireBytes).median,
  summarize(b, run => run.remoteWireBytes).median,
)
Object.assign(report, {
  verdict: {
    cpuChangePercentB: cpuChange,
    remoteWireChangePercentB: wireChange,
    exceedsNoiseFloor: Math.abs(cpuChange) > noiseFloorPercent,
    wireBytesEquivalent: Math.abs(wireChange) <= 1,
  },
})

process.stdout.write(JSON.stringify(report, null, 2) + '\n')
