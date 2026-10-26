/**
 * Generic per-session projection value store (push model; see the
 * session-projection subsystem page, docs/subsystems/session-projection.md):
 * the host is the only computation site; the client holds finished whole
 * values per key in one of two row kinds. A `sequenced` row
 * (`{ value, seq, generation }`) comes from the connected Host — a follow
 * opening baseline, a Session Controller `projection` frame, a list block the
 * Host computed for an attached Session — and merges under **higher seq wins**
 * against other sequenced rows of the same Connection generation. A `cached`
 * row (`{ value }`) comes from a Host view of the persisted checkpoint,
 * carries no comparable seq, and yields to every sequenced write. No
 * client-side domain folding exists: a domain ships projection support with
 * zero client code. Per-key bare observable faces feed `useProjection`
 * (ui-renderer binds them).
 */
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Notifier } from './notifier.ts'

// The single projection type table, typed end to end (host unit, wire block,
// client store, React hook) — the Service Definition package's pure-type outlet
// (`/types`, zero imports), never the package root: the root's dsh-agent →
// dsh-session chain would drag the host `Context.sessions` merge into the
// client program (one program must not hold both sides). No second
// client-side "views" table (rejected in the Alternatives of
// .agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
export type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'

/**
 * The fifth framework hook seat (see the session-projection subsystem page,
 * docs/subsystems/session-projection.md): key-addressed
 * projection reader delivered through the standard kit. `undefined` uniformly
 * means capability absent — host unit unmounted, or no baseline/frame has
 * carried the key yet. The selector overload mirrors useSession (per-key uSES
 * binding; reference stability holds because a key's value reference changes
 * only when a frame or baseline lands).
 */
export type UseProjection = {
  <K extends Extract<keyof SessionProjectionMap, string>>(key: K): SessionProjectionMap[K] | undefined
  <K extends Extract<keyof SessionProjectionMap, string>, S>(
    key: K,
    selector: (value: SessionProjectionMap[K] | undefined) => S,
    eq?: (a: S, b: S) => boolean,
  ): S
}

/**
 * Follow-opening projection baseline, restated here so the
 * React-free store depends only on the type table, not the wire package's
 * response vocabulary.
 */
export interface ProjectionsBaseline {
  /** The consistent-cut seq (equals the window tail seq by construction). */
  asOfSeq: SessionSeqCursor
  /** Whole current values by key; a registered key absent here means the capability is absent. */
  values: Readonly<Record<string, unknown>>
}

/**
 * One key's row. A `sequenced` row was computed by the Host for this Session
 * within the connection generation named by its `generation` field and carries
 * the seq it is consistent with; seqs are comparable only between sequenced
 * rows of the same generation. A `cached` row was viewed from the persisted
 * projection checkpoint by a header-only listing without a Session: its origin
 * cannot vouch that its stored seq is comparable with the log the client later
 * opens, so it carries neither and yields to every sequenced write.
 */
type Row =
  | { kind: 'cached'; value: unknown; generation: number }
  | { kind: 'sequenced'; value: unknown; seq: SessionSeqCursor; generation: number }

/** Per-key notification channel: the bare face plus its batching notifier. */
interface Channel {
  face: ObservableSnapshot<unknown>
  notifier: Notifier
}

/**
 * One session's projection values. Framework semantics, uniform across every
 * key. A Connection generation defines the seq space: `beginGeneration`
 * retires every row the previous generation wrote, and from then on only
 * rows of the current generation compare — a higher-or-equal seq wins within
 * one, and a row carried over from an earlier generation always yields
 * because its seq describes a different log. That covers both a replayed
 * frame (a lower-or-equal seq loses, so a value cannot regress) and a stale
 * baseline (it can neither overwrite nor clear a newer frame). Cached writes
 * (the session list's zero-I/O block) only fill keys no sequenced row holds,
 * and a baseline discards every cached row before it seeds, regardless of
 * seq: the connected Session is the truth and a cached value never outranks
 * it.
 *
 * Retirement is by generation marker, never by deletion: a superseded value
 * stays readable until the new generation writes that key, so a reconnect
 * never blanks what the page is showing and then restores the same value one
 * round-trip later. `clear` remains for the one caller that means "the Host
 * reports this Session holds nothing" — an absence, not a generation change.
 * A key the store has never seen reads `undefined` (capability absent). Faces
 * are identity-stable per key (create-on-demand, cached) so the React side
 * binds each exactly once; the store-level channel (`subscribeAny`) serves
 * coarse consumers (the manager's list projection reads the `title` key).
 */
export class ProjectionValueStore {
  private readonly rows = new Map<string, Row>()
  private readonly channels = new Map<string, Channel>()
  private valuesCache: Readonly<Partial<SessionProjectionMap>> | undefined
  /**
   * Connection generation every new sequenced row belongs to; advanced by
   * {@link beginGeneration}. Seqs are comparable only within one value.
   */
  private generation = 0
  /** Coarse any-key channel (no snapshot cache to rebuild: reads hit rows directly). */
  private readonly anyNotifier = new Notifier(() => {})

  /**
   * Key-addressed bare observable face (the useProjection resolution path).
   * Always defined — absence is an `undefined` snapshot, never a missing
   * face, so a component may subscribe before the key ever carries a value.
   * @param key - projection key.
   * @returns the identity-stable face for this key.
   */
  faceOf(key: string): ObservableSnapshot<unknown> {
    return this.channel(key).face
  }

  /**
   * Current whole value for a key (erased framework read; typed reads go
   * through `useProjection`'s map lookup).
   * @param key - projection key.
   * @returns the value, or undefined while the key is absent.
   */
  get(key: string): unknown {
    return this.rows.get(key)?.value
  }

  /**
   * Read the accepted Host watermark without subscribing or copying a value.
   * A superseded row's seq belongs to the previous generation's log, so it
   * answers as absent rather than as a watermark a caller could compare
   * against a current-generation seq.
   * @param key - projection key.
   * @returns the current sequence, or undefined for absent, cached, and superseded values.
   */
  seqOf(key: string): SessionSeqCursor | undefined {
    const row = this.rows.get(key)
    return row?.kind === 'sequenced' && row.generation === this.generation ? row.seq : undefined
  }

  /**
   * Read every current projection value as one reference-stable snapshot.
   * @returns The same frozen value map until a row changes.
   */
  values(): Readonly<Partial<SessionProjectionMap>> {
    if (this.valuesCache === undefined) {
      this.valuesCache = Object.freeze(Object.fromEntries(
        [...this.rows].map(([key, row]) => [key, row.value]),
      ))
    }
    return this.valuesCache
  }

  /**
   * Subscribe to any-key changes (microtask-batched) — the manager's list
   * rebuild channel.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribeAny(listener: () => void): () => void {
    return this.anyNotifier.subscribe(listener)
  }

  /**
   * Apply one finished value from the Session control stream.
   * @param key - projection key.
   * @param value - whole value computed by the host unit.
   * @param seq - the unit's watermark at emission.
   */
  apply(key: string, value: unknown, seq: SessionSeqCursor): void {
    const row = this.rows.get(key)
    // A higher-or-equal seq wins within one generation: replays and stale
    // frames drop. A row from an earlier generation holds a seq from another
    // log, so it never blocks this write. A cached row has no comparable seq
    // and always yields.
    if (row?.kind === 'sequenced' && row.generation === this.generation && seq <= row.seq) return
    this.rows.set(key, { kind: 'sequenced', value, seq, generation: this.generation })
    this.changed(key)
  }

  /**
   * Fill keys from a Host block labeled `cached`: a zero-I/O
   * view of the persisted checkpoint. A cached value lands only where no
   * current sequenced row exists: a connected Session has already answered for
   * such a key, and the list's view of the persisted checkpoint cannot be newer
   * than it. A row left over from an earlier generation does not block the
   * fill — the cached view is the only answer this generation has for that key,
   * and a block covers every key its source holds, so a key this generation's
   * block omits is one the source no longer reports.
   * @param values - whole values by key viewed from the persisted checkpoint.
   */
  applyCached(values: Readonly<Record<string, unknown>>): void {
    for (const [key, row] of this.rows) {
      if (row.kind !== 'cached' || row.generation === this.generation) continue
      if (Object.hasOwn(values, key)) continue
      this.rows.delete(key)
      this.changed(key)
    }
    for (const key of Object.keys(values)) {
      const row = this.rows.get(key)
      if (row?.kind === 'sequenced' && row.generation === this.generation) continue
      this.rows.set(key, { kind: 'cached', value: values[key], generation: this.generation })
      this.changed(key)
    }
  }

  /**
   * Seed from a history tail page's projections block. Every cached row is
   * discarded first, regardless of seq: the block comes from the connected
   * Session, and a value viewed from the persisted checkpoint never outranks
   * it. Then every carried key lands under the same seq rule as frames, and a
   * key the block omits is capability-absent as of the cut — its row clears
   * unless a newer frame of this generation already superseded the cut (a
   * stale baseline can neither overwrite nor clear newer values).
   * @param baseline - the response's projections block.
   */
  seed(baseline: ProjectionsBaseline): void {
    for (const [key, row] of this.rows) {
      if (row.kind !== 'cached') continue
      this.rows.delete(key)
      this.changed(key)
    }
    // Erased walk: the framework crosses the open key space; per-key typing
    // is re-established at the consumer (useProjection's map lookup).
    const values = baseline.values as Record<string, unknown>
    for (const key of Object.keys(values)) this.apply(key, values[key], baseline.asOfSeq)
    for (const [key, row] of this.rows) {
      if (Object.hasOwn(values, key)) continue
      // Every cached row was deleted above; the kind test only narrows the
      // type so the remaining fields are readable. A row from an earlier
      // generation is absent as of this cut too: nothing of that log survives.
      if (row.kind === 'sequenced' && row.generation === this.generation
        && row.seq > baseline.asOfSeq) continue
      this.rows.delete(key)
      this.changed(key)
    }
  }

  /**
   * Retire every row an earlier Connection generation wrote, keeping it
   * readable until this generation answers for that key.
   *
   * Seqs from a previous generation describe a log this client no longer
   * holds, so they must not survive as comparable watermarks; the values
   * themselves stay published, because deleting them makes every reader flash
   * to its absent state and back once the new generation's baseline arrives.
   * Publishing is deferred to the first write, which is what makes the
   * reconnect invisible.
   */
  beginGeneration(): void {
    this.generation += 1
  }

  /**
   * Discard every value while preserving subscribed faces.
   *
   * The caller asserts the Host holds nothing for this Session — an absence,
   * not a generation change, which {@link beginGeneration} expresses without
   * a visible gap.
   */
  clear(): void {
    for (const key of this.rows.keys()) {
      this.rows.delete(key)
      this.changed(key)
    }
  }

  private changed(key: string): void {
    this.valuesCache = undefined
    this.channels.get(key)?.notifier.markDirty()
    this.anyNotifier.markDirty()
  }

  private channel(key: string): Channel {
    let channel = this.channels.get(key)
    if (channel === undefined) {
      // The notifier only batches (no snapshot cache to rebuild: faces read rows directly).
      const notifier = new Notifier(() => {})
      channel = {
        notifier,
        face: {
          getSnapshot: () => this.rows.get(key)?.value,
          subscribe: listener => notifier.subscribe(listener),
        },
      }
      this.channels.set(key, channel)
    }
    return channel
  }
}
