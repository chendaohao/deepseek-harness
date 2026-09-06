/**
 * Message fold: collapse a session event stream into an ordered, renderable
 * message list for the mobile surface. Pure and side-effect-free — callers
 * hold the rendered list and feed the next event batch in to get the next
 * list. Event data shapes follow the host session protocol:
 *
 * - `user/message`      data = `{ id, role, content: ContentBlock[], source }`
 * - `assistant/message` data = `{ turn, step, message: { id, content }, usage?, stream? }`
 * - `assistant/chunk`   data = `{ turn, step, chunk: { type: 'text-delta' | 'reasoning-delta', index, text } }`
 *   (pre-format-v2 hosts only; v2 logs embed streams in `assistant/attempt` instead)
 * - `tool/call`         data = `{ turn, step, callId, name, arguments }`
 * - `turn/end`          data = `{ turn, reason: { kind: 'error' | ... } }`
 *
 * Events apply in ascending `seq` order; a watermark derived from `existing`
 * makes re-applying a batch idempotent. Create events dedupe by message id so
 * replayed history replaces in place. A pending assistant message (kept alive
 * while chunks stream) is finalized by the matching `assistant/message` or
 * closed by `turn/end`.
 */

/** One tool call attached to an assistant message (callId dedupes repeats). */
export interface ToolCallInfo {
  /** Tool-call id (synthetic `${name}#${seq}` when the wire omitted it). */
  callId: string
  /** Tool name, e.g. "bash". */
  name: string
  /** Raw arguments JSON, when the event carried it. */
  arguments?: string
}

/** One rendered chat message. */
export interface RenderMessage {
  /** Stable message identity — the wire id when present, else the event seq. */
  id: string
  kind: 'user' | 'assistant'
  /** The fully folded text (assistant chunks aggregate into their message). */
  text: string
  /** Folded reasoning text, kept separate so the surface can hide it. */
  reasoning?: string
  /** Ordered tool calls of this assistant message, in first-seen order. */
  tools?: ToolCallInfo[]
  /** Seq of the latest event that touched this message. */
  seq: number
  /** Epoch ms of the latest touch. */
  time: number
  /** True while an assistant message is still receiving chunks. */
  pending?: boolean
  /** Plain-text tool summary, e.g. "使用 bash / read". */
  toolSummary?: string
  /** Set when the owning turn ended in an error. */
  failed?: boolean
}

/**
 * The session event envelope as the fold sees it. `data` stays wide so the
 * fold reads fields defensively.
 */
export interface WireEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

/** Runtime shape guard for the JSON-parsed `data` of a `WireEvent`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Fallback message id for events without a stable wire id. */
function syntheticId(prefix: string, seq: number): string {
  return `${prefix}#${String(seq)}`
}

/** Concatenate the plain text of every content block of one type. */
function blocksOfType(content: unknown, type: string): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== type) continue
    const text = pickString(block['text'])
    if (text !== undefined) out += text
  }
  return out
}

/** Max message seq across an existing list, or -1 for an empty list. */
function watermarkOf(existing: readonly RenderMessage[] | undefined): number {
  if (existing === undefined) return -1
  let maxSeq = -1
  for (const message of existing) {
    if (message.seq > maxSeq) maxSeq = message.seq
  }
  return maxSeq
}

/** Mutable fold state; message objects are swapped on change, never mutated. */
interface FoldState {
  messages: RenderMessage[]
  byId: Map<string, RenderMessage>
  /** Pending assistant message per `${turn}.${step}`, awaiting finalization. */
  pendingByTurnStep: Map<string, RenderMessage>
  /** Latest assistant message per `${turn}.${step}` (pending or finalized). */
  turnStepMessage: Map<string, RenderMessage>
  /** Owning turn per assistant message id (for turn/end targeting). */
  messageTurn: Map<string, number>
}

function createState(existing: readonly RenderMessage[] | undefined): FoldState {
  const messages = existing === undefined ? [] : [...existing]
  const state: FoldState = {
    messages,
    byId: new Map(),
    pendingByTurnStep: new Map(),
    turnStepMessage: new Map(),
    messageTurn: new Map(),
  }
  for (const message of messages) {
    state.byId.set(message.id, message)
    if (message.kind !== 'assistant') continue
    const decoded = decodePendingTurnStep(message.id)
    const key = decoded === undefined ? undefined : tsKey(decoded.turn, decoded.step)
    if (message.pending === true && key !== undefined) {
      state.pendingByTurnStep.set(key, message)
      state.turnStepMessage.set(key, message)
    }
    if (decoded !== undefined) state.messageTurn.set(message.id, decoded.turn)
  }
  return state
}

function tsKey(turn: number | undefined, step: number | undefined): string | undefined {
  return turn === undefined || step === undefined ? undefined : `${turn}.${step}`
}

/**
 * Recover the `(turn, step)` a pending assistant message was created under
 * from its synthetic id (`assistant,<turn>.<step>#<seq>`), so an incremental
 * fold can re-attach index maps lost across calls.
 */
function decodePendingTurnStep(id: string): { turn: number; step: number } | undefined {
  if (!id.startsWith('assistant,')) return undefined
  const rest = id.slice('assistant,'.length)
  const hash = rest.indexOf('#')
  const tsPart = hash === -1 ? rest : rest.slice(0, hash)
  const dot = tsPart.indexOf('.')
  if (dot <= 0 || dot === tsPart.length - 1) return undefined
  const turn = Number(tsPart.slice(0, dot))
  const step = Number(tsPart.slice(dot + 1))
  if (!Number.isInteger(turn) || !Number.isInteger(step)) return undefined
  return { turn, step }
}

/** Swap in a replacement message object and re-index it (immutable swap). */
function replaceMessage(state: FoldState, oldMessage: RenderMessage, next: RenderMessage): void {
  const index = state.messages.indexOf(oldMessage)
  if (index !== -1) state.messages[index] = next
  state.byId.delete(oldMessage.id)
  state.byId.set(next.id, next)
}

/** Retarget the per-turn-step index maps onto a newly swapped message. */
function retargetTurnStep(
  state: FoldState,
  key: string | undefined,
  oldMessage: RenderMessage,
  next: RenderMessage,
): void {
  if (key === undefined) return
  if (state.pendingByTurnStep.get(key) === oldMessage) state.pendingByTurnStep.set(key, next)
  if (state.turnStepMessage.get(key) === oldMessage) state.turnStepMessage.set(key, next)
}

/** Fold one event into the working state (assumes it passes the watermark). */
function applyEvent(state: FoldState, event: WireEvent): void {
  switch (event.type) {
    case 'user/message':
      applyUserMessage(state, event)
      break
    case 'assistant/message':
      applyAssistantMessage(state, event)
      break
    case 'assistant/chunk':
      applyChunk(state, event)
      break
    case 'turn/end':
      applyTurnEnd(state, event)
      break
    case 'tool/call':
      applyToolCall(state, event)
      break
    default:
      // turn/start, step/*, tool/result, todo/*, and unknown types render nothing.
      break
  }
}

function applyUserMessage(state: FoldState, event: WireEvent): void {
  const data = isRecord(event.data) ? event.data : {}
  const id = pickString(data['id']) ?? syntheticId('user', event.seq)
  const text = blocksOfType(data['content'], 'text')
  const existing = state.byId.get(id)
  if (existing !== undefined) {
    replaceMessage(state, existing, { ...existing, text, seq: event.seq, time: event.time })
    return
  }
  const message: RenderMessage = { id, kind: 'user', text, seq: event.seq, time: event.time }
  state.messages.push(message)
  state.byId.set(id, message)
}

function applyAssistantMessage(state: FoldState, event: WireEvent): void {
  const data = isRecord(event.data) ? event.data : {}
  const messageData = isRecord(data['message']) ? data['message'] : data
  const id = pickString(messageData['id']) ?? pickString(data['id']) ?? syntheticId('assistant', event.seq)
  const turn = pickNumber(data['turn'])
  const step = pickNumber(data['step'])
  const finalText = blocksOfType(messageData['content'], 'text')
  const finalReasoning = blocksOfType(messageData['content'], 'reasoning')
  const key = tsKey(turn, step)

  // Finalize the matching assistant message (by id, or by turn/step for the
  // streaming partial the chunks built before the final event arrived).
  let target = state.byId.get(id)
  if (target === undefined && key !== undefined) target = state.pendingByTurnStep.get(key)

  if (target !== undefined) {
    const next: RenderMessage = {
      ...target,
      id,
      text: finalText,
      // The final content block list is authoritative; an adapter that omits
      // reasoning keeps the streamed reasoning text.
      ...(finalReasoning !== '' ? { reasoning: finalReasoning } : {}),
      seq: event.seq,
      time: event.time,
      pending: false,
    }
    replaceMessage(state, target, next)
    retargetTurnStep(state, key, target, next)
    if (turn !== undefined) state.messageTurn.set(next.id, turn)
    return
  }

  const message: RenderMessage = {
    id,
    kind: 'assistant',
    text: finalText,
    ...(finalReasoning !== '' ? { reasoning: finalReasoning } : {}),
    seq: event.seq,
    time: event.time,
  }
  state.messages.push(message)
  state.byId.set(id, message)
  if (key !== undefined) {
    state.pendingByTurnStep.delete(key)
    state.turnStepMessage.set(key, message)
  }
  if (turn !== undefined) state.messageTurn.set(id, turn)
}

/** Extract the text-chunk target from an `assistant/chunk` event. */
function chunkTarget(data: unknown): {
  text: string
  kind: 'text' | 'reasoning'
  turn?: number
  step?: number
} | null {
  if (!isRecord(data)) return null
  const chunk = data['chunk']
  if (!isRecord(chunk) || (chunk['type'] !== 'text-delta' && chunk['type'] !== 'reasoning-delta')) return null
  const text = pickString(chunk['text'])
  if (text === undefined) return null
  const kind = chunk['type'] === 'reasoning-delta' ? 'reasoning' : 'text'
  const turn = pickNumber(data['turn'])
  const step = pickNumber(data['step'])
  const result: { text: string; kind: 'text' | 'reasoning'; turn?: number; step?: number } = { text, kind }
  if (turn !== undefined) result.turn = turn
  if (step !== undefined) result.step = step
  return result
}

function applyChunk(state: FoldState, event: WireEvent): void {
  const target = chunkTarget(event.data)
  if (target === null) return
  const key = tsKey(target.turn, target.step)
  const message = key === undefined ? undefined
    : state.pendingByTurnStep.get(key) ?? state.turnStepMessage.get(key)

  if (message !== undefined && message.kind === 'assistant') {
    const next: RenderMessage = target.kind === 'reasoning'
      ? { ...message, reasoning: (message.reasoning ?? '') + target.text, seq: event.seq, time: event.time }
      : { ...message, text: message.text + target.text, seq: event.seq, time: event.time }
    replaceMessage(state, message, next)
    retargetTurnStep(state, key, message, next)
    return
  }

  const id = key !== undefined
    ? syntheticId(`assistant,${key}`, event.seq)
    : syntheticId('assistant', event.seq)
  const created: RenderMessage = target.kind === 'reasoning'
    ? { id, kind: 'assistant', text: '', reasoning: target.text, seq: event.seq, time: event.time, pending: true }
    : { id, kind: 'assistant', text: target.text, seq: event.seq, time: event.time, pending: true }
  state.messages.push(created)
  state.byId.set(id, created)
  if (key !== undefined) {
    state.pendingByTurnStep.set(key, created)
    state.turnStepMessage.set(key, created)
  }
  if (target.turn !== undefined) state.messageTurn.set(id, target.turn)
}

function applyToolCall(state: FoldState, event: WireEvent): void {
  const data = isRecord(event.data) ? event.data : {}
  const name = pickString(data['name'])
  if (name === undefined) return
  const turn = pickNumber(data['turn'])
  const step = pickNumber(data['step'])
  const key = tsKey(turn, step)

  let target = key === undefined ? undefined : state.turnStepMessage.get(key)
  if (target === undefined && turn !== undefined) {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const candidate = state.messages[i]
      if (candidate !== undefined && candidate.kind === 'assistant' && state.messageTurn.get(candidate.id) === turn) {
        target = candidate
        break
      }
    }
  }
  if (target === undefined) {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const candidate = state.messages[i]
      if (candidate !== undefined && candidate.kind === 'assistant') {
        target = candidate
        break
      }
    }
  }
  if (target === undefined) return

  const callId = pickString(data['callId']) ?? `${name}#${String(event.seq)}`
  const args = pickString(data['arguments'])
  const tools = target.tools ?? []
  const existingIndex = tools.findIndex(tool => tool.callId === callId)
  const isNewCall = existingIndex === -1
  const nextTools: ToolCallInfo[] = isNewCall
    ? [...tools, { callId, name, ...(args !== undefined ? { arguments: args } : {}) }]
    : tools.map((tool, index) => index === existingIndex
      ? { ...tool, ...(args !== undefined ? { arguments: args } : {}) }
      : tool)
  const names = new Set<string>()
  for (const tool of nextTools) names.add(tool.name)
  const next: RenderMessage = {
    ...target,
    toolSummary: `使用 ${[...names].join(' / ')}`,
    tools: nextTools,
    seq: event.seq,
    time: event.time,
  }
  replaceMessage(state, target, next)
  retargetTurnStep(state, key, target, next)
}

function applyTurnEnd(state: FoldState, event: WireEvent): void {
  const data = isRecord(event.data) ? event.data : {}
  const turn = pickNumber(data['turn'])
  const reason = isRecord(data['reason']) ? data['reason'] : {}
  const failed = reason['kind'] === 'error'

  let targets: RenderMessage[]
  if (turn !== undefined) {
    targets = state.messages.filter(message => message.kind === 'assistant' && state.messageTurn.get(message.id) === turn)
  } else {
    targets = state.messages.filter(message => message.kind === 'assistant')
  }
  if (targets.length === 0) {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const candidate = state.messages[i]
      if (candidate !== undefined && candidate.kind === 'assistant') {
        targets = [candidate]
        break
      }
    }
  }
  for (const message of targets) {
    replaceMessage(state, message, {
      ...message,
      ...(message.pending === true ? { pending: false } : {}),
      ...(failed ? { failed: true } : {}),
      seq: Math.max(message.seq, event.seq),
      time: event.time,
    })
  }
}

/**
 * Convert one page/follow record batch into fold events. An `event` record
 * passes through; a `chunks` record (the pre-format-v2 packed-row transport)
 * has no codec on this side anymore and is dropped. Malformed records are
 * dropped so one bad record never blanks a chat.
 * @param records - the `SessionHistoryRecord` batch from session/page or a follow snapshot.
 * @returns the fold events, in record order.
 */
export function recordsToWireEvents(records: unknown): WireEvent[] {
  if (!Array.isArray(records)) return []
  const out: WireEvent[] = []
  for (const record of records) {
    if (!isRecord(record)) continue
    if (record['type'] === 'event' && isRecord(record['event'])) {
      const event = record['event']
      if (typeof event['type'] !== 'string' || typeof event['seq'] !== 'number' || typeof event['time'] !== 'number') continue
      out.push({ type: event['type'], seq: event['seq'], time: event['time'], data: event['data'] })
    }
  }
  return out
}

/**
 * Fold a batch of session events into a renderable message list.
 * @param events - events to apply, in any order (folded by ascending seq).
 * @param existing - the previously rendered list (live-stream incremental tail).
 * @returns messages sorted by seq.
 */
export function foldEvents(events: readonly WireEvent[], existing?: readonly RenderMessage[]): RenderMessage[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const watermark = watermarkOf(existing)
  const state = createState(existing)
  for (const event of sorted) {
    if (event.seq <= watermark) continue
    applyEvent(state, event)
  }
  return [...state.messages].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1))
}
