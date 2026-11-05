/**
 * Fixed synthetic inputs for the remote-stream transport diagnostic.
 *
 * Every size here is a reviewed constant, not a sampled recording: the opening
 * frame follows the 1,395 KB Session snapshot recorded beside the Gateway mux
 * deflate constant, the answer groups 1,000 synthetic deltas into frames whose
 * payload clears the relay's 1,024-byte compression threshold, and the uplink
 * frames sit at the two sizes a Client actually sends.
 */

/** Repetitive JSON opening: 1.4 MiB of session-shaped records. */
export const OPENING_BYTES = Math.round(1.4 * 1024 * 1024)
/** Synthetic assistant deltas behind one already-batched answer. */
export const ANSWER_DELTAS = 1_000
/** Characters of one synthetic delta. */
export const DELTA_CHARS = 128
/** Deltas grouped into one downstream frame. */
export const DELTAS_PER_FRAME = 50
/** Downstream answer frames: ceil(1,000 / 50). */
export const ANSWER_FRAMES = ANSWER_DELTAS / DELTAS_PER_FRAME
/** Compression threshold the relay applies per frame, mirrored so the control can assert its own bypass. */
export const RELAY_COMPRESSION_THRESHOLD_BYTES = 1_024
/** Large uplink frame from the remote client. */
export const UPLINK_LARGE_BYTES = 1024 * 1024
/** Small uplink frame from the remote client. */
export const UPLINK_SMALL_BYTES = 64 * 1024
/** Downlink frames below the threshold: the compression-bypass control. */
export const SMALL_FRAME_COUNT = 20
/** Characters in one small downlink frame. */
export const SMALL_FRAME_CHARS = 256
/** Logical stream the diagnostic opens on the mux. */
export const STREAM_ID = 'remote-stream-diagnostic'

/** The two downlink workloads, in the order the driver sends them. */
export type DownlinkKind = 'opening' | 'answer' | 'small'

/**
 * Build the big session-shaped opening payload.
 * @returns one JSON text frame, repetitive like a history-bearing opening.
 */
export function openingPayload(): string {
  const records: { seq: number; role: string; text: string }[] = []
  const text = 'session-replay-record-'
  for (let index = 0; ; index += 1) {
    // Stop once the encoded frame reaches OPENING_BYTES: measuring the encoder
    // against a target size keeps the constant meaningful even though JSON
    // escaping makes per-record width uneven.
    if (JSON.stringify({ type: 'snapshot', records }).length >= OPENING_BYTES) break
    records.push({
      seq: index,
      role: index % 3 === 0 ? 'assistant' : 'user',
      text: text + String(index % 97).padStart(2, '0'),
    })
    // Each record costs roughly 90 bytes; grow in a batch so the encoder is not
    // called once per record.
    if (index !== 0 && index % 64 === 63) {
      if (JSON.stringify({ type: 'snapshot', records }).length + 64 * 90 >= OPENING_BYTES) break
    }
  }
  return JSON.stringify({ type: 'snapshot', records })
}

/**
 * Build one downstream frame of the already-batched answer.
 * @param frameIndex - zero-based frame position, preserved in the payload for order checks.
 * @returns JSON text whose length clears the relay threshold.
 */
export function answerFrame(frameIndex: number): string {
  const first = frameIndex * DELTAS_PER_FRAME
  const deltas: string[] = []
  for (let offset = 0; offset < DELTAS_PER_FRAME; offset += 1) {
    const serial = first + offset
    deltas.push(('delta-' + String(serial).padStart(4, '0') + '-').padEnd(DELTA_CHARS, 'a'))
  }
  return JSON.stringify({ type: 'answer', frame: frameIndex, deltas })
}

/**
 * Build one below-threshold downlink frame.
 * @param frameIndex - zero-based frame position, preserved in the payload for order checks.
 * @returns JSON text shorter than the relay's compression threshold.
 */
export function smallFrame(frameIndex: number): string {
  return JSON.stringify({
    type: 'small',
    frame: frameIndex,
    text: ('small-' + String(frameIndex).padStart(2, '0') + '-').padEnd(SMALL_FRAME_CHARS, 'b'),
  })
}

/**
 * Build one uplink frame the remote client sends.
 *
 * `streamId` must match the logical stream the `open` registered: the mux drops
 * an item whose stream it does not own, so a mismatched id measures a path that
 * never carried the frame.
 * @param bytes - target payload size.
 * @param serial - frame position, preserved in the payload.
 * @param streamId - the logical stream this item belongs to.
 * @returns JSON text of at least `bytes` characters.
 */
export function uplinkFrame(bytes: number, serial: number, streamId: string): string {
  const envelope = JSON.stringify({ type: 'item', streamId, value: '' })
  return JSON.stringify({
    type: 'item',
    streamId,
    value: ('uplink-' + String(serial).padStart(3, '0') + '-').padEnd(Math.max(1, bytes - envelope.length), 'c'),
  })
}
