/**
 * One fresh-process measurement of the remote-access transport path.
 *
 * Everything the path costs is paid inside this process: the Gateway mux, the
 * reverse proxy, and the `ws` client that stands in for the remote browser. A
 * sample therefore publishes whole-path process CPU and never splits it between
 * the Host-facing and remote-facing hops.
 *
 * Boundaries: fixture construction and every handshake finish before the clock
 * starts, and the run stops only after the client received and validated every
 * payload and the terminal frames. Model generation, Assistant batching, Client
 * fold, browser paint, cloudflared, and public-network latency are absent.
 */

import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createNetServer, connect, type Server as NetServer, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import WebSocket from 'ws'
import {
  RemoteStreamMuxServer,
  createRemoteProxy,
  type RemoteProxyHandle,
  type RemoteStreamFailureMapper,
  type RemoteStreamOpener,
} from './remote-stream-adapter.ts'
import {
  ANSWER_FRAMES,
  SMALL_FRAME_COUNT,
  UPLINK_LARGE_BYTES,
  UPLINK_SMALL_BYTES,
  answerFrame,
  openingPayload,
  smallFrame,
  uplinkFrame,
} from './remote-stream-workload.ts'

/** Compression setting on one relay hop. */
export type HopCompression = 'deflate' | 'none'

/** Which topology a sample measures. */
export interface Variant {
  /** Gateway mux compression, matching `websocketCompression` on `TypertGatewayService`. */
  readonly gateway: HopCompression
  /** Proxy compression, matching `websocketCompression` on `RemoteAccess`. */
  readonly proxy: HopCompression
}

/** Published measurement of one fresh-process sample. */
export interface RemoteStreamSample {
  readonly variant: Variant
  /** Whole-path process CPU over the timed interval, including libuv thread-pool zlib work. */
  readonly cpuMs: number
  /** Wall time from the first `open` write to the last validated frame. */
  readonly wallMs: number
  /** Median gap between consecutive downlink frame arrivals. */
  readonly medianFrameGapMs: number
  /** 95th-percentile gap between consecutive downlink frame arrivals. */
  readonly p95FrameGapMs: number
  /** Bytes the client read from the remote-facing leg, WebSocket framing included. */
  readonly remoteWireBytes: number
  /** Downlink payload characters the client decoded. */
  readonly decodedChars: number
  /** Downlink frames received. */
  readonly downlinkFrames: number
  /** Uplink frames the Host consumed. */
  readonly uplinkFrames: number
  /** Whether every payload matched its source exactly. */
  readonly payloadsMatch: boolean
  /** Peak RSS of this process, in MiB. */
  readonly peakRssMb: number
  /** RSS at the end with the sockets and payloads still reachable, in MiB. */
  readonly retainedRssMb: number
}

/** Fixture peer the mux admits the upgrade as; the streams open under its scope. */
async function fixturePeer(): Promise<{ peer: PeerScope; dispose: () => Promise<void> }> {
  const root = new Context()
  const fiber = root.plugin(() => {})
  await fiber
  return {
    peer: {
      id: 'remote-stream-diagnostic' as PeerId,
      ctx: fiber.ctx,
      principal: { kind: 'owner' },
      interactions: 'answer',
      signal: new AbortController().signal,
      dispose: async () => { await fiber.dispose() },
    },
    dispose: async () => { await fiber.dispose() },
  }
}

const mapFailure: RemoteStreamFailureMapper = error => ({
  code: 'internal',
  message: error instanceof Error ? error.message : String(error),
  details: {},
})

/** The scripted streams the driver opens, and the Host-side uplink ledger. */
class ScriptedStreams {
  /** The big history-shaped opening frame, built once per sample before timing. */
  readonly opening = openingPayload()
  /** The already-batched answer frames. */
  readonly answers = Array.from({ length: ANSWER_FRAMES }, (_unused, index) => answerFrame(index))
  /** The below-threshold control frames. */
  readonly smalls = Array.from({ length: SMALL_FRAME_COUNT }, (_unused, index) => smallFrame(index))
  private uplinkFrames = 0
  private readonly opened = new Map<string, () => void>()
  private readonly openedWaiters = new Map<string, Promise<void>>()

  /** Uplink frames the Host consumed, which proves the client's writes arrived. */
  get receivedUplinkFrames(): number { return this.uplinkFrames }

  /**
   * Wait until the Host's opener has claimed one logical stream.
   *
   * An item the mux receives before its `open` is dropped, so a driver that
   * wrote uplink frames on a timer would silently measure a path that never
   * carried them. This settles on the opener invocation instead.
   * @param endpoint - endpoint whose open to await.
   * @returns once the opener for that endpoint has run.
   */
  async awaitOpen(endpoint: string): Promise<void> {
    await (this.openedWaiters.get(endpoint) ?? Promise.resolve())
  }

  private markOpened(endpoint: string): void {
    this.opened.get(endpoint)?.()
  }

  /**
   * Wait until the Host consumed a given number of uplink frames.
   * @param count - frames the client sent.
   * @returns once the Host-side counter reaches that count.
   */
  async awaitUplinkDone(count: number): Promise<void> {
    while (this.uplinkFrames < count) await new Promise<void>((resolve) => { setImmediate(resolve) })
  }

  constructor() {
    for (const endpoint of ['opening', 'answer', 'small', 'uplink']) {
      const settled = Promise.withResolvers<undefined>()
      this.opened.set(endpoint, () => { settled.resolve(undefined) })
      this.openedWaiters.set(endpoint, settled.promise)
    }
  }

  /** The opener handed to the mux. */
  readonly open: RemoteStreamOpener = async (endpoint, _payload, uplink) => {
    this.markOpened(endpoint)
    switch (endpoint) {
      case 'opening': return this.openingStream()
      case 'answer': return asAsyncIterable(this.answers)
      case 'small': return asAsyncIterable(this.smalls)
      case 'uplink': return this.drainUplink(uplink)
      default: throw new Error('remote-stream diagnostic: unknown endpoint ' + endpoint)
    }
  }

  private openingStream(): AsyncIterable<unknown> {
    const opening = this.opening
    return (async function* () { yield opening })()
  }

  /**
   * Consume the Client's uplink, then end the logical stream.
   *
   * The stream must outlive every uplink item: returning early completes the
   * downlink half and fails the inbox before the Client's writes arrive, which
   * would measure a path that never carried them.
   */
  private drainUplink(uplink: AsyncIterable<unknown>): AsyncIterable<unknown> {
    const record = (): void => { this.uplinkFrames += 1 }
    return {
      async *[Symbol.asyncIterator]() {
        for await (const item of uplink) {
          void item
          record()
        }
      },
    }
  }
}

/**
 * Present a fixed frame list as the async iterable the mux consumes.
 * @param frames - the scripted payloads, already built.
 * @returns an iterable yielding each frame once.
 */
function asAsyncIterable(frames: readonly string[]): AsyncIterable<unknown> {
  return (async function* () { yield* frames })()
}

/** Count what the client actually reads on the remote-facing leg. */
interface WireTap {
  readonly port: number
  readonly downlinkBytes: () => number
  close(): Promise<void>
}

/**
 * Insert a byte-counting pass-through between the client and the proxy.
 *
 * The remote-facing leg's bytes are the quantity the compression choice exists
 * to move, and `ws` exposes no public counter for them. A loopback TCP relay
 * costs both variants the same and counts the real wire bytes, WebSocket framing
 * included, instead of the post-inflate payload lengths.
 * @param targetPort - the proxy's loopback port.
 * @returns the tap's port, its downlink byte count, and its teardown.
 */
async function startWireTap(targetPort: number): Promise<WireTap> {
  let downlinkBytes = 0
  const sockets = new Set<Socket>()
  const server: NetServer = createNetServer((inbound: Socket) => {
    const outbound = connect(targetPort, '127.0.0.1')
    sockets.add(inbound)
    sockets.add(outbound)
    inbound.on('close', () => { sockets.delete(inbound); outbound.destroy() })
    outbound.on('close', () => { sockets.delete(outbound); inbound.destroy() })
    inbound.on('error', () => { outbound.destroy() })
    outbound.on('error', () => { inbound.destroy() })
    inbound.pipe(outbound)
    outbound.on('data', (chunk: Buffer) => { downlinkBytes += chunk.length })
    outbound.pipe(inbound)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  return {
    port: (server.address() as AddressInfo).port,
    downlinkBytes: () => downlinkBytes,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

/**
 * Run one sample of one variant.
 * @param variant - compression setting on each hop.
 * @returns the published measurements for this sample.
 */
export async function measure(variant: Variant): Promise<RemoteStreamSample> {
  const streams = new ScriptedStreams()
  const peerFixture = await fixturePeer()
  const mux = new RemoteStreamMuxServer(streams.open, mapFailure, {
    // Heartbeats would fire inside a slow sample and add unrelated frames; the
    // interval sits past any plausible run.
    heartbeatIntervalMs: 600_000,
    streamInboxBytes: 8 * 1024 * 1024,
    compression: variant.gateway === 'deflate',
  })

  let gateway: Server | undefined
  let proxy: RemoteProxyHandle | undefined
  let tap: WireTap | undefined
  let client: WebSocket | undefined
  try {
    gateway = createHttpServer()
    gateway.on('upgrade', (request, socket, head) => {
      mux.handleUpgrade(request, socket, head, peerFixture.peer)
    })
    await new Promise<void>((resolve, reject) => {
      gateway!.once('error', reject)
      gateway!.listen(0, '127.0.0.1', () => { gateway!.off('error', reject); resolve() })
    })
    const gatewayPort = (gateway.address() as AddressInfo).port
    proxy = await createRemoteProxy({
      targetPort: gatewayPort,
      policy: { authorize: () => ({ admitted: true }), handlePairing: () => false },
      websocketCompression: variant.proxy,
    })
    tap = await startWireTap(proxy.port)

    // --- setup ends here; the clock starts after the handshake completes ---
    const socket = new WebSocket('ws://127.0.0.1:' + String(tap.port), {
      // The client offers the extension so the proxy's downstream decision is
      // exercised; the threshold is 0 because ws ignores it under context takeover.
      perMessageDeflate: { threshold: 0 },
      maxPayload: 256 * 1024 * 1024,
    })
    client = socket
    await once(socket, 'open')

    // Every downlink payload arrives wrapped in the mux's own `item` envelope,
    // one per logical stream. The comparison therefore keys on streamId and
    // unwraps `value`; `end` and `error` are terminal signals, not payloads.
    const items = new Map<string, string[]>()
    const arrivals: number[] = []
    const totalExpected = 1 + ANSWER_FRAMES + SMALL_FRAME_COUNT
    const settled = Promise.withResolvers<undefined>()
    let failure: Error | undefined

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8')
      const frame = JSON.parse(text) as { type?: string; streamId?: string; value?: unknown; error?: unknown }
      if (frame.type === 'error') {
        settled.reject(new Error('remote-stream diagnostic: stream failed: ' + text.slice(0, 300)))
        return
      }
      if (frame.type !== 'item' || frame.streamId === undefined) return
      const payload = typeof frame.value === 'string' ? frame.value : JSON.stringify(frame.value)
      const stream = items.get(frame.streamId) ?? []
      stream.push(payload)
      items.set(frame.streamId, stream)
      arrivals.push(performance.now())
      const received = [...items.values()].reduce((sum, list) => sum + list.length, 0)
      if (received >= totalExpected) settled.resolve(undefined)
    })
    socket.on('error', (error: Error) => {
      failure = error
      settled.reject(error)
    })
    socket.on('close', () => {
      if (failure === undefined) {
        const received = [...items.values()].reduce((sum, list) => sum + list.length, 0)
        if (received < totalExpected) {
          settled.reject(new Error(
            'remote-stream diagnostic: socket closed after ' + String(received) + ' of ' + String(totalExpected) + ' payload frames',
          ))
        }
      }
    })

    // Uplink first: the Host's inbox is what the client's writes land in, and
    // the downlink clock must not include the client's own send path.
    socket.send(JSON.stringify({ type: 'open', streamId: 'uplink', endpoint: 'uplink', payload: null }))
    await streams.awaitOpen('uplink')
    socket.send(uplinkFrame(UPLINK_LARGE_BYTES, 0, 'uplink'))
    socket.send(uplinkFrame(UPLINK_SMALL_BYTES, 1, 'uplink'))
    socket.send(JSON.stringify({ type: 'end', streamId: 'uplink' }))
    await streams.awaitUplinkDone(2)

    const beforeWire = tap.downlinkBytes()
    const startCpu = process.cpuUsage()
    const startWall = performance.now()
    for (const endpoint of ['opening', 'answer', 'small']) {
      socket.send(JSON.stringify({ type: 'open', streamId: endpoint, endpoint, payload: null }))
    }
    await settled.promise
    const wallMs = performance.now() - startWall
    const cpu = process.cpuUsage(startCpu)
    const remoteWireBytes = tap.downlinkBytes() - beforeWire

    const payloadsMatch = validate(streams, items)
    const gaps: number[] = []
    for (let index = 1; index < arrivals.length; index += 1) {
      gaps.push((arrivals[index] as number) - (arrivals[index - 1] as number))
    }
    gaps.sort((left, right) => left - right)
    const percentile = (value: number): number => gaps.length === 0
      ? 0
      : (gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * value))] as number)

    socket.close()
    await once(socket, 'close')

    return {
      variant,
      cpuMs: (cpu.user + cpu.system) / 1_000,
      wallMs,
      medianFrameGapMs: percentile(0.5),
      p95FrameGapMs: percentile(0.95),
      remoteWireBytes,
      decodedChars: [...items.values()].reduce((sum, list) => sum + list.reduce((chars, text) => chars + text.length, 0), 0),
      downlinkFrames: [...items.values()].reduce((sum, list) => sum + list.length, 0),
      uplinkFrames: streams.receivedUplinkFrames,
      payloadsMatch,
      peakRssMb: process.resourceUsage().maxRSS / 1_024,
      retainedRssMb: process.memoryUsage().rss / (1024 * 1024),
    }
  } finally {
    client?.terminate()
    await tap?.close()
    await proxy?.close()
    if (gateway !== undefined) {
      await new Promise<void>((resolve) => { gateway!.close(() => { resolve() }) })
    }
    await mux.close()
    await peerFixture.dispose()
  }
}

/**
 * Compare every received payload against what the scripted streams produced.
 *
 * Content, count, and per-stream order are the functional invariant the
 * compression choice must not move. Order is checked per stream because three
 * logical streams share one physical socket and their pumps interleave.
 * @param streams - the sample's scripted payloads.
 * @param items - downlink payloads grouped by the stream that produced them.
 * @returns whether every payload arrived exactly once, in order, unmodified.
 */
function validate(streams: ScriptedStreams, items: ReadonlyMap<string, readonly string[]>): boolean {
  const expectOne = (streamId: string, expected: string): boolean => {
    const list = items.get(streamId)
    return list !== undefined && list.length === 1 && list[0] === expected
  }
  if (!expectOne('opening', streams.opening)) return false
  const answers = items.get('answer')
  if (answers === undefined || answers.length !== ANSWER_FRAMES) return false
  for (let index = 0; index < ANSWER_FRAMES; index += 1) {
    if (answers[index] !== streams.answers[index]) return false
  }
  const smalls = items.get('small')
  if (smalls === undefined || smalls.length !== SMALL_FRAME_COUNT) return false
  for (let index = 0; index < SMALL_FRAME_COUNT; index += 1) {
    if (smalls[index] !== streams.smalls[index]) return false
  }
  return true
}

if (import.meta.main) {
  const [gatewayCompression, proxyCompression, sampleIndex] = process.argv.slice(2)
  if ((gatewayCompression !== 'deflate' && gatewayCompression !== 'none')
    || (proxyCompression !== 'deflate' && proxyCompression !== 'none')) {
    throw new Error('usage: remote-stream.worker.js <deflate|none> <deflate|none> <sample-index>')
  }
  const sample = await measure({ gateway: gatewayCompression, proxy: proxyCompression })
  process.stdout.write(JSON.stringify({ sampleIndex, ...sample }) + '\n')
}
