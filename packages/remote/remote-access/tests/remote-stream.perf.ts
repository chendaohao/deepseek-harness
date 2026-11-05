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
  /** Legacy topology: both hops negotiate permessage-deflate. */
  A: { gateway: 'deflate', proxy: 'deflate', level: 4 },
  /** Shipped topology: the Host-facing hop sends plaintext, the remote-facing hop keeps level 4. */
  B: { gateway: 'none', proxy: 'deflate', level: 4 },
  /** Shipped topology with a cheaper zlib level on the remote-facing hop. */
  C: { gateway: 'none', proxy: 'deflate', level: 1 },
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
      configuration.gateway, configuration.proxy, String(configuration.level), String(sampleIndex)],
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
 * Which comparison to run.
 *
 * `topology` re-checks the shipped change against the legacy dual-hop path;
 * `level` compares zlib levels on the settled topology. They are separate runs
 * because a level difference is far smaller than the topology difference, and
 * interleaving all three would bury it.
 */
type Mode = 'topology' | 'level'

/**
 * Interleaved schedule per mode: control and candidate pairs alternate so drift
 * affects both, and no variant owns a contiguous stretch.
 */
const SCHEDULES: Readonly<Record<Mode, readonly VariantKey[]>> = {
  topology: ['A', 'A', 'B', 'B', 'A', 'A', 'B', 'B', 'A', 'A', 'B', 'B', 'A', 'B'],
  level: ['B', 'B', 'C', 'C', 'B', 'B', 'C', 'C', 'B', 'B', 'C', 'C', 'B', 'C'],
}

/** Which variant is the control and which is the candidate, per mode. */
const PAIR: Readonly<Record<Mode, { readonly control: VariantKey; readonly candidate: VariantKey }>> = {
  topology: { control: 'A', candidate: 'B' },
  level: { control: 'B', candidate: 'C' },
}

const modeArgument = process.argv[2] ?? 'topology'
if (modeArgument !== 'topology' && modeArgument !== 'level') {
  throw new Error('usage: remote-stream.perf.ts [topology|level]')
}
const mode: Mode = modeArgument
const SCHEDULE = SCHEDULES[mode]
const { control, candidate } = PAIR[mode]

// One discarded sample first: the opening children pay for the module cache and
// the OS file cache, and that cost lands entirely on whichever variant runs
// first. Every published sample is therefore a warm-process measurement.
process.stderr.write('warmup\n')
runSample(control, -1)

const runs: Run[] = []
for (const [index, variant] of SCHEDULE.entries()) {
  runs.push(runSample(variant, index))
  process.stderr.write('sample ' + String(index + 1) + '/' + String(SCHEDULE.length) + ' ' + variant + ' done\n')
}

const of = (variant: VariantKey): Run[] => runs.filter(run => run.slot === variant)
const baseline = of(control)
const treatment = of(candidate)
// The noise floor: the largest absolute CPU-median difference between two
// disjoint halves of the control samples. Any control-versus-candidate
// difference inside it is indistinguishable from run-to-run drift here.
const firstHalf = baseline.slice(0, Math.floor(baseline.length / 2))
const secondHalf = baseline.slice(Math.floor(baseline.length / 2))
const noiseFloorPercent = Math.max(
  Math.abs(changePercent(summarize(firstHalf, run => run.cpuMs).median, summarize(secondHalf, run => run.cpuMs).median)),
  Math.abs(changePercent(summarize(secondHalf, run => run.cpuMs).median, summarize(firstHalf, run => run.cpuMs).median)),
)

const report = {
  mode,
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
    method: 'Largest absolute CPU-median difference between two disjoint halves of the control samples.',
    cpuPercent: noiseFloorPercent,
  },
  variants: { [control]: VARIANTS[control], [candidate]: VARIANTS[candidate] },
  runs,
  summary: {
    cpuMs: { [control]: summarize(baseline, run => run.cpuMs), [candidate]: summarize(treatment, run => run.cpuMs) },
    wallMs: { [control]: summarize(baseline, run => run.wallMs), [candidate]: summarize(treatment, run => run.wallMs) },
    p95FrameGapMs: {
      [control]: summarize(baseline, run => run.p95FrameGapMs),
      [candidate]: summarize(treatment, run => run.p95FrameGapMs),
    },
    remoteWireBytes: {
      [control]: summarize(baseline, run => run.remoteWireBytes),
      [candidate]: summarize(treatment, run => run.remoteWireBytes),
    },
    peakRssMb: { [control]: summarize(baseline, run => run.peakRssMb), [candidate]: summarize(treatment, run => run.peakRssMb) },
  },
}

const cpuChange = changePercent(
  summarize(baseline, run => run.cpuMs).median,
  summarize(treatment, run => run.cpuMs).median,
)
const wireChange = changePercent(
  summarize(baseline, run => run.remoteWireBytes).median,
  summarize(treatment, run => run.remoteWireBytes).median,
)
Object.assign(report, {
  verdict: {
    control,
    candidate,
    cpuChangePercent: cpuChange,
    remoteWireChangePercent: wireChange,
    exceedsNoiseFloor: Math.abs(cpuChange) > noiseFloorPercent,
    wireBytesEquivalent: Math.abs(wireChange) <= 1,
  },
})
process.stdout.write(JSON.stringify(report, null, 2) + '\n')
