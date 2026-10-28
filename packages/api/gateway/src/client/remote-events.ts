/** Client owner for forwarded Remote Event subscriptions and deliveries. */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConnectionGenerationSource,
  ConnectionHostInfo,
  ConnectionHandle,
} from '@deepseek-ai/dsh-client-connection/client'
import type {
  TypertClientEventListener,
  TypertOwnedValue,
  TypertRemoteEvent,
} from '@deepseek-ai/dsh-typert-protocol'
import { isRemoteJsonValue, isTypertOwnedValue } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  REMOTE_EVENT_RESULT_ENDPOINT,
  REMOTE_EVENT_STREAM_ENDPOINT,
  REMOTE_EVENT_STREAM_PAYLOAD,
  isRemoteEventAgentId,
  isRemoteEventClientId,
  isRemoteEventId,
  projectRemoteEventRejection,
  type RemoteEventClientId,
  type RemoteEventDownlinkFrame,
  type RemoteEventEmitFrame,
  type RemoteEventInvocationFrame,
  type RemoteEventResult,
} from '../stream-protocol.ts'

/** Open the Gateway-internal forwarded-event stream on the selected carrier. */
export type RemoteEventStreamOpener = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => AsyncIterable<unknown>

/** One subscribed listener after its event-specific signature is erased. */
type RemoteEventListener = (this: Context, ...args: unknown[]) => unknown

/** Untyped access used only for instance-private Cordis event keys. */
interface PrivateEventContext {
  on(name: string, listener: RemoteEventListener): () => boolean
  parallel(name: string, ...args: unknown[]): Promise<void>
  waterfall(
    thisArg: Context,
    name: string,
    request: Readonly<Record<string, unknown>>,
    next: () => Promise<symbol>,
  ): unknown
}

/** Transport outcome after one Client listener chain either claims or delegates. */
type RemoteEventReplyOutcome =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'next' }
  | { readonly kind: 'rejected'; readonly error: ReturnType<typeof projectRemoteEventRejection> }

/** Private end-of-chain marker that cannot collide with a JSON listener result. */
const REMOTE_EVENT_NEXT = Symbol('api-gateway.remote-event.next')

/**
 * Times one listener's decided outcome is posted.
 *
 * The first post is the listener's own reply. The retry covers the ordinary
 * phone case: the leg dies exactly as the user's answer leaves the page, so the
 * first post lands on a socket that is already being replaced.
 */
const RESULT_DELIVERY_ATTEMPTS = 2

/** Pause before the retried post (ms), long enough for a replacement leg to answer. */
const RESULT_DELIVERY_RETRY_MS = 250

/** Deadline of one result post (ms); a hung leg must not hold a decided outcome open. */
const RESULT_DELIVERY_DEADLINE_MS = 15_000

/**
 * Decisions kept for a later delivery, in retention order.
 *
 * An entry leaves when the Host accepts it or finishes that event itself, so the
 * bound only protects a Host that never settles one event from retaining
 * decisions forever.
 */
const UNDELIVERED_LIMIT = 64

/**
 * Refused results, in a row, before the generation ends.
 *
 * A refusal is the Host's own answer to a post, so the reply carrier works and
 * the failure is state this Client cannot repair — the delivery row is gone or
 * the event settled elsewhere. Nothing else in the generation reacts to it, so
 * this is the bound at which replacing the carrier is the only remaining
 * recovery.
 */
const RESULT_REFUSAL_LIMIT = 8

/** What one post achieved: the Host holds it, refused it, or it is still unposted. */
type ResultDelivery = 'accepted' | 'refused' | 'kept'

/** Own Cordis registrations, generation pumping, waterfall dispatch, and HTTP replies. */
export class ClientRemoteEvents {
  private readonly eventPrefix = `internal/api-gateway/remote-event/${randomUUID()}/`
  private readonly unregisterGeneration: () => void
  private activeGeneration: Promise<void> | undefined
  /**
   * Outcomes a listener already decided but the Host has not accepted.
   *
   * A generation can end between the decision and its reply — the page resumes,
   * the socket is recycled, the leg stalls — and the next generation's stream
   * re-delivers the same pending event. Deciding it again would ask the human
   * for an answer they already gave, so the decision travels with the event id.
   */
  private readonly undelivered = new Map<string, RemoteEventResult>()
  /** Posts still on their way after the generation that asked for them ended. */
  private readonly deliveries = new Set<Promise<void>>()
  /** Cancels work that outlives one generation, so disposal still ends a decided outcome's retry. */
  private readonly disposal = new AbortController()

  /**
   * @param ownerCtx - Client Gateway root used for Agent Context resolution.
   * @param connection - Connection carrier used for HTTP result calls.
   * @param openStream - selected in-process or WebSocket stream opener.
   */
  constructor(
    private readonly ownerCtx: Context,
    private readonly connection: ConnectionHandle,
    private readonly openStream: RemoteEventStreamOpener,
  ) {
    this.unregisterGeneration = connection.registerGenerationSource(this.runGeneration)
  }

  /**
   * Register one typed Remote Event listener in its calling fiber.
   * @param callerCtx - fiber Context owning the registration.
   * @param event - selected forwarded event.
   * @param listener - listener derived from that event's declaration.
   * @returns disposer for this exact registration.
   */
  subscribe<Event extends TypertRemoteEvent>(
    callerCtx: Context,
    event: Event,
    listener: TypertClientEventListener<Event>,
  ): () => void {
    const dispose = privateEvents(callerCtx).on(
      this.eventKey(event),
      listener as RemoteEventListener,
    )
    return () => { dispose() }
  }

  /** Withdraw the generation source and wait for active listener work to quiesce. */
  async dispose(): Promise<void> {
    this.unregisterGeneration()
    this.disposal.abort(new Error('client api: Remote events disposed'))
    this.undelivered.clear()
    await Promise.allSettled([this.activeGeneration])
    await Promise.allSettled([...this.deliveries])
  }

  /** Track the current generation so plugin disposal waits for listener work to stop. */
  private readonly runGeneration: ConnectionGenerationSource = (signal, ready) => {
    const tracked = this.pumpEvents(signal, ready).finally(() => {
      if (this.activeGeneration === tracked) this.activeGeneration = undefined
    })
    this.activeGeneration = tracked
    return tracked
  }

  /** Deliver one notification through Cordis while containing listener failures. */
  private deliver(frame: RemoteEventEmitFrame): void {
    void privateEvents(this.ownerCtx)
      .parallel(this.eventKey(frame.event), ...frame.args)
      .catch((error: unknown) => { this.reportError(frame.event, error) })
  }

  /** Run one Connection generation over the forwarded-event logical stream. */
  private async pumpEvents(
    signal: AbortSignal,
    ready: (host: ConnectionHostInfo) => void,
  ): Promise<void> {
    let clientId: RemoteEventClientId | undefined
    let undeliverable = 0
    /** The failure this generation ends with, when its own Result handling named one. */
    let deliveryFailure: Error | undefined
    const failed = new AbortController()
    const generationSignal = AbortSignal.any([signal, failed.signal])
    const active = new Map<string, AbortController>()
    const tasks = new Set<Promise<void>>()
    const source = this.openStream(
      REMOTE_EVENT_STREAM_ENDPOINT,
      REMOTE_EVENT_STREAM_PAYLOAD,
      generationSignal,
    )
    /**
     * Count one decided outcome this generation could not hand over.
     *
     * Only a refused post raises the count. A refusal means the reply carrier
     * works and the Host stated its own verdict on that event, so nothing in
     * this generation reacts to it; enough of them in a row end the generation
     * and let Connection replace the carrier. A transport failure is already
     * handled inside {@link postResult}, which retains the outcome for another
     * delivery, so recycling on top of it would only cancel the other streams.
     * @param accepted - whether the Host took the outcome.
     */
    const undeliveredOutcome = (accepted: boolean): void => {
      if (accepted) {
        undeliverable = 0
        return
      }
      undeliverable += 1
      if (undeliverable >= RESULT_REFUSAL_LIMIT) {
        endGeneration(new Error('client api: Remote event results were refused'))
      }
    }
    /**
     * End this generation with one failure of its own.
     *
     * A result post outlives its generation, so it reports here instead of
     * throwing into a caller that has already returned.
     * @param error - the failure the generation ends with.
     */
    const endGeneration = (error: unknown): void => {
      // The first failure is the one worth reporting: a result post that fails
      // because this generation is already ending is a consequence, not a cause.
      /* v8 ignore next -- the only path that ends a generation twice comes from its own abort. */
      if (deliveryFailure !== undefined) return
      deliveryFailure = error instanceof Error ? error : new Error('client api: Remote event delivery failed', { cause: error })
      failed.abort(deliveryFailure)
    }
    let streamFailed = false
    let streamError: unknown
    try {
      for await (const value of source) {
        if (clientId === undefined) {
          const opening = parseRemoteEventReady(value)
          clientId = opening.clientId
          ready(opening.host)
          continue
        }
        const frame = parseRemoteEventFrame(value)
        if (frame.type === 'cancel') {
          // An undelivered decision settles here instead: the Host finished the
          // event without it, and a later delivery of the same id must not
          // decide another event that happens to reuse the id.
          this.undelivered.delete(frame.eventId)
          active.get(frame.eventId)?.abort(new Error('client api: Remote event was cancelled by the Host'))
          continue
        }
        if (frame.type === 'emit') {
          this.deliver(frame)
          continue
        }
        const controller = new AbortController()
        const pending = this.undelivered.get(frame.eventId)
        if (pending !== undefined) {
          // This generation re-delivered an event whose outcome is already
          // decided: post that outcome again instead of asking the listener a
          // second time. The replacement client id is the only new field, and
          // the Host holds no delivery row for it yet, so this is the same first
          // reply the lost generation never managed to send.
          this.track(this.repostResult({ ...pending, clientId }), frame.eventId, active, endGeneration)
          continue
        }
        active.set(frame.eventId, controller)
        const deliverySignal = AbortSignal.any([generationSignal, controller.signal])
        const task = this.decide(frame, clientId, deliverySignal)
          .then((decided) => {
            // A decision is made once the listener returns it, and from here on
            // it is the answer: a post that cannot complete must not become a
            // second question. The post therefore runs outside this generation's
            // `tasks` — the reconnect that would interrupt it is exactly the loss
            // it recovers from. Its release travels with it, so the invocation
            // Context outlives the generation that resolved it.
            if (decided === undefined) return
            this.retainUndelivered(decided.result)
            this.track(this.postDecided(decided, undeliveredOutcome), frame.eventId, active, endGeneration)
          })
          .catch(endGeneration)
          .finally(() => {
            active.delete(frame.eventId)
            tasks.delete(task)
          })
        tasks.add(task)
      }
    } catch (error) {
      streamFailed = true
      streamError = error
    } finally {
      for (const controller of active.values()) {
        controller.abort(new Error('client api: Remote event generation ended'))
      }
      await Promise.allSettled(tasks)
    }
    if (deliveryFailure !== undefined) throw deliveryFailure
    if (signal.aborted) return
    if (streamFailed) throw streamError
    throw new Error('client api: forwarded Remote event stream ended unexpectedly')
  }

  /**
   * Ask this Client's listener chain for one outcome.
   *
   * The caller owns the returned release: an invocation-owned Context stays
   * alive until the outcome has been posted, exactly as it did when the post
   * lived inside this method.
   * @param frame - forwarded invocation.
   * @param clientId - Client id of the delivering generation stream.
   * @param signal - generation lifetime of this delivery.
   * @returns the decided wire result and its release, or undefined when there is
   *   nothing to post.
   */
  private async decide(
    frame: RemoteEventInvocationFrame,
    clientId: RemoteEventClientId,
    signal: AbortSignal,
  ): Promise<{ readonly result: RemoteEventResult; readonly release: () => void } | undefined> {
    const adapter = this.ownerCtx.typert.contexts.getClient('agent')
    let resolved: Context | TypertOwnedValue<Context> | undefined
    try {
      resolved = adapter?.resolve(frame.agentId)
    } catch (error) {
      this.reportError(frame.event, error)
    }
    const owned = isTypertOwnedValue(resolved) ? resolved : undefined
    const release = (): void => { owned?.[Symbol.dispose]() }
    let handed = false
    try {
      const target = isTypertOwnedValue(resolved) ? resolved.value : resolved
      let outcome: RemoteEventReplyOutcome = { kind: 'next' }
      if (target !== undefined) {
        try {
          outcome = await this.dispatchWaterfall(target, frame, signal)
        } catch (error) {
          if (signal.aborted) return undefined
          outcome = { kind: 'rejected', error: projectRemoteEventRejection(error) }
        }
      }
      if (signal.aborted) return undefined
      handed = true
      return {
        release,
        result: {
          clientId,
          eventId: frame.eventId,
          outcome: outcome.kind === 'result' && outcome.value === undefined
            ? { kind: 'result' }
            : outcome,
        },
      }
    } finally {
      // The caller takes the release over only with a decided outcome; every
      // other exit releases here, so no invocation Context outlives its delivery.
      if (!handed) release()
    }
  }

  /**
   * Post one decided outcome and settle what the outcome says about this Client.
   * @param decided - the decided outcome and the release its caller owns.
   * @param undeliveredOutcome - the delivering generation's refusal counter.
   */
  private async postDecided(
    decided: { readonly result: RemoteEventResult; readonly release: () => void },
    undeliveredOutcome: (accepted: boolean) => void,
  ): Promise<void> {
    try {
      const delivery = await this.postResult(decided.result)
      if (delivery === 'kept') return
      this.settleUndelivered(decided.result.eventId)
      undeliveredOutcome(delivery === 'accepted')
    } finally {
      decided.release()
    }
  }

  /**
   * Re-post a decision this generation was handed again.
   * @param result - retained outcome re-addressed to this generation's client id.
   */
  private async repostResult(result: RemoteEventResult): Promise<void> {
    const delivery = await this.postResult(result)
    if (delivery === 'kept') return
    this.settleUndelivered(result.eventId)
  }

  /**
   * Track a result post that outlives the generation asking for it.
   *
   * The post is deliberately not part of the generation's `tasks`: its own
   * lifetime is the plugin's, and waiting for it would hold the very reconnect
   * that supersedes it. Disposal still waits, so no post is left in flight after
   * the plugin is gone.
   * @param post - the post to track.
   * @param eventId - event whose delivery the post answers.
   * @param active - the generation's in-flight controllers.
   * @param failed - reports a failure that leaves the generation unsound; a
   *   decided outcome's post contains everything else.
   */
  private track(
    post: Promise<void>,
    eventId: string,
    active: Map<string, AbortController>,
    failed: (error: unknown) => void,
  ): void {
    const tracked = post
      .catch(failed)
      .finally(() => {
        active.delete(eventId)
        this.deliveries.delete(tracked)
      })
    this.deliveries.add(tracked)
  }

  /**
   * Post one decided outcome to the Host, retrying once when the leg is gone.
   *
   * The lifetime is deliberately not the generation's: the loss this recovers
   * from is that generation dying, and the endpoint is a unary call that does
   * not need the forwarded-event stream to be open. Only the plugin's own
   * disposal cancels a decided outcome.
   * @param result - decided outcome carrying the delivering generation's client id.
   * @returns `accepted` when the Host took the outcome, `refused` when it stated
   *   its own verdict and repeating the post cannot change it, and `kept` when
   *   the outcome stays retained for another delivery.
   */
  private async postResult(result: RemoteEventResult): Promise<ResultDelivery> {
    for (let attempt = 1; attempt <= RESULT_DELIVERY_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.connection.rpc.call(
          '/api',
          REMOTE_EVENT_RESULT_ENDPOINT,
          { args: result },
          AbortSignal.any([this.disposal.signal, AbortSignal.timeout(RESULT_DELIVERY_DEADLINE_MS)]),
        )
        if (response.ok) return 'accepted'
        // A refusal names this event — the Host settled it without this client,
        // or the delivery row is gone — so repeating it can only fail the same way.
        console.error(`client api: Remote event result was refused for ${JSON.stringify(result.eventId)}:`, response.error.message)
        return 'refused'
      } catch (error) {
        if (this.disposal.signal.aborted) return 'kept'
        if (attempt === RESULT_DELIVERY_ATTEMPTS) {
          // Retained: the next delivery of this event posts it again, so a page
          // that stays open keeps its answer.
          console.error(`client api: Remote event result delivery failed for ${JSON.stringify(result.eventId)}:`, error)
          return 'kept'
        }
        await new Promise((resolve) => { setTimeout(resolve, RESULT_DELIVERY_RETRY_MS) })
      }
    }
    /* v8 ignore next -- the loop returns on every iteration it runs. */
    return 'kept'
  }

  /** Keep one decided outcome until the Host accepts it or finishes its event. */
  private retainUndelivered(result: RemoteEventResult): void {
    this.undelivered.delete(result.eventId)
    this.undelivered.set(result.eventId, result)
    while (this.undelivered.size > UNDELIVERED_LIMIT) {
      // Retention order is insertion order, so the first key is the oldest
      // decision; the loop condition guarantees there is one.
      const oldest = this.undelivered.keys().next().value as string
      this.undelivered.delete(oldest)
    }
  }

  /** Forget a decided outcome the Host now holds. */
  private settleUndelivered(eventId: string): void {
    this.undelivered.delete(eventId)
  }

  private async dispatchWaterfall(
    target: Context,
    frame: RemoteEventInvocationFrame,
    signal: AbortSignal,
  ): Promise<RemoteEventReplyOutcome> {
    const request = {
      ...frame.request,
      agent: target,
      signal,
    }
    // Cancellation reaches the handler, whose Context remains owned until it settles.
    const value = await privateEvents(target).waterfall(
      target,
      this.eventKey(frame.event),
      request,
      () => Promise.resolve(REMOTE_EVENT_NEXT),
    )
    if (value !== REMOTE_EVENT_NEXT && value !== undefined && !isRemoteJsonValue(value)) {
      throw new TypeError('Remote event listener result is not lossless JSON data')
    }
    return value === REMOTE_EVENT_NEXT
      ? { kind: 'next' }
      : { kind: 'result', value }
  }

  private eventKey(event: string): string {
    return `${this.eventPrefix}${event}`
  }

  private reportError(event: string, error: unknown): void {
    console.error(`client api: Remote event ${JSON.stringify(event)} listener threw:`, error)
  }
}

/** Validate and return one generation's Client identity and Host facts. */
function parseRemoteEventReady(value: unknown): {
  readonly clientId: RemoteEventClientId
  readonly host: ConnectionHostInfo
} {
  if (!isRemoteEventRecord(value)
    || !hasExactRemoteEventKeys(value, ['type', 'clientId', 'host'])
    || value.type !== 'ready'
    || !isRemoteEventClientId(value.clientId)
    || !isRemoteEventRecord(value.host)
    || !hasExactRemoteEventKeys(value.host, ['home'])
    || typeof value.host.home !== 'string') {
    throw new TypeError('client api: forwarded Remote event stream did not begin with ready')
  }
  return { clientId: value.clientId, host: { home: value.host.home } }
}

/** Validate one untrusted value from the Gateway-internal forwarded-event stream. */
function parseRemoteEventFrame(value: unknown): Exclude<RemoteEventDownlinkFrame, { type: 'ready' }> {
  if (!isRemoteEventRecord(value)) invalidRemoteEventFrame()
  if (value.type === 'cancel'
    && hasExactRemoteEventKeys(value, ['type', 'eventId'])
    && isRemoteEventId(value.eventId)) {
    return { type: 'cancel', eventId: value.eventId }
  }
  if (value.type === 'emit'
    && hasExactRemoteEventKeys(value, ['type', 'event', 'args'])
    && validRemoteEventName(value.event)
    && Array.isArray(value.args)
    && isRemoteJsonValue(value.args)) {
    return { type: 'emit', event: value.event, args: value.args }
  }
  if (value.type === 'waterfall'
    && hasExactRemoteEventKeys(value, ['type', 'event', 'eventId', 'agentId', 'request'])
    && validRemoteEventName(value.event)
    && isRemoteEventId(value.eventId)
    && isRemoteEventAgentId(value.agentId)
    && isRemoteEventRecord(value.request)
    && !Object.hasOwn(value.request, 'agent')
    && !Object.hasOwn(value.request, 'signal')
    && isRemoteJsonValue(value.request)) {
    return {
      type: 'waterfall',
      event: value.event,
      eventId: value.eventId,
      agentId: value.agentId,
      request: value.request,
    }
  }
  invalidRemoteEventFrame()
}

function isRemoteEventRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactRemoteEventKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function validRemoteEventName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function invalidRemoteEventFrame(): never {
  throw new TypeError('client api: invalid forwarded Remote event frame')
}

function privateEvents(ctx: Context): PrivateEventContext {
  return ctx
}
