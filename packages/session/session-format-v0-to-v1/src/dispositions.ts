/** Exact top-level payload disposition frozen for every released-v0 event type. */
export interface ReleasedV0PayloadDisposition {
  readonly required: readonly string[]
  readonly optional: readonly string[]
  /** JSON members whose nested representation is intentionally owner-opaque. */
  readonly opaque: readonly string[]
}

/**
 * Freeze one exact released payload-member disposition for adjacent format validators.
 * @param required - members that must be present.
 * @param optional - additional admitted members.
 * @param opaque - members retained as lossless JSON without nested semantic inspection.
 * @returns the detached frozen disposition.
 */
export function defineReleasedPayloadDisposition(
  required: readonly string[],
  optional: readonly string[] = [],
  opaque: readonly string[] = [],
): ReleasedV0PayloadDisposition {
  return Object.freeze({
    required: Object.freeze([...required]),
    optional: Object.freeze([...optional]),
    opaque: Object.freeze([...opaque]),
  })
}

const disposition = defineReleasedPayloadDisposition

/**
 * `subagent/descriptor` versions a released writer emitted. The earliest
 * product tag `dsh-v0.1.0-rc.7` shipped format v0 with descriptor version 2,
 * and every later tag carries 2 or 3, so a released log of any generation may
 * hold either. Descriptor version 1 predates the first tag and never shipped;
 * it is also structurally unreadable here because it lacks the `mode` member
 * this inventory requires, so it stays refused rather than admitted by
 * guessing a lifecycle mode.
 *
 * Hardcoded rather than read from `SUBAGENT_DESCRIPTOR_VERSION`: a released
 * edge freezes the vocabulary its own era's writers emitted, and must not
 * admit a version that only a later build can write.
 */
export const RELEASED_SUBAGENT_DESCRIPTOR_VERSIONS: readonly number[] = Object.freeze([2, 3])

/**
 * Test one decoded descriptor version against the released inventory.
 * @param value - decoded `subagent/descriptor` version member.
 * @returns whether a released writer could have emitted this version.
 */
export function isReleasedSubagentDescriptorVersion(value: unknown): value is number {
  return typeof value === 'number' && RELEASED_SUBAGENT_DESCRIPTOR_VERSIONS.includes(value)
}

/**
 * Frozen released-v0 event and payload-member inventory.
 * Every listed member is preserved by the identity edge. Members in `opaque`
 * remain lossless JSON without nested Session-sequence interpretation. Nested
 * merge-extensible discriminants validate known variants and preserve
 * unknown variants as owner-opaque JSON.
 */
export const RELEASED_V0_EVENT_DISPOSITIONS: Readonly<Record<string, ReleasedV0PayloadDisposition>> = Object.freeze({
  'agent-preset/selected': disposition(['agentPreset']),
  'agent/inbox/spliced': disposition(
    ['target', 'start', 'inserted'],
    ['removedCount', 'outcome'],
  ),
  'approval/asked': disposition(['id', 'toolName'], ['callId', 'reason']),
  'approval/decided': disposition(['id', 'outcome']),
  'approval/policy': disposition(['policy'], ['source']),
  'assistant/chunk': disposition(['turn', 'step', 'chunk']),
  'assistant/message': disposition(
    ['turn', 'step', 'message'],
    ['usage', 'interrupted'],
  ),
  'command/done': disposition(['commandId', 'kind'], ['text', 'sourceEventSeq']),
  'command/run': disposition(['commandId', 'name', 'source'], ['args']),
  'compaction/end': disposition(['compactionId', 'turn'], ['sourceCommandId', 'error']),
  'compaction/prune': disposition(['shadowedRange', 'shadowedSeqs', 'shadowedTokenCount']),
  'compaction/start': disposition(['compactionId', 'turn'], ['sourceCommandId']),
  'compaction/summary': disposition(
    ['compactionId', 'summary', 'shadowedRange', 'shadowedSeqs', 'shadowedTokenCount', 'provider', 'model'],
    ['sourceCommandId', 'maxTokens', 'usage', 'rawOutput', 'llmStreamCall'],
  ),
  'feedback/record': disposition(['text']),
  'feedback/message-put': disposition(['sessionId', 'item']),
  'feedback/message-delete': disposition(['sessionId', 'messageId']),
  'goal/change': disposition(
    ['kind', 'version', 'operation'],
    ['goal', 'roundsStarted', 'createdAt', 'updatedAt', 'cleared', 'clearedAt'],
  ),
  'hook/invoked': disposition(['turn', 'point', 'dialect', 'handlerId'], ['matcher']),
  'hook/result': disposition(
    ['turn', 'point', 'handlerId', 'decision', 'durationMs'],
    ['exitCode', 'stderrSummary'],
  ),
  'llm/retry': disposition(
    ['retryId', 'turn', 'step', 'provider', 'mode', 'policyKey', 'retry', 'delayMs', 'failure'],
    ['maxRetries'],
  ),
  'llm/retry-started': disposition(['retryId', 'turn', 'step', 'retry']),
  'model/selection': disposition(['provider', 'model'], ['reasoningEffort']),
  'permission/preset': disposition(['preset']),
  'plan/mode': disposition(['active']),
  'request/context': disposition(['provider', 'model'], ['contextWindow']),
  'request/header': disposition(['header', 'reason'], ['startsSeries']),
  'sandbox/mode': disposition(['mode'], ['source']),
  'schedule/change': disposition(['version', 'operation'], ['schedule', 'id', 'acceptedAt']),
  'session-log-deepseek/delivery-accepted': disposition(
    ['sessionId', 'throughSeq'],
  ),
  'session/end-seed': disposition([]),
  'session/pin': disposition(['pinned']),
  'session/title': disposition(['title', 'messageSeqs', 'source']),
  'session/title-llm-request': disposition(
    ['titleProvider', 'messageSeqs', 'route', 'system', 'messages', 'maxTokens'],
  ),
  'step/end': disposition(['turn', 'step']),
  'step/start': disposition(['turn', 'step']),
  'subagent/descriptor': disposition(
    ['mode', 'version', 'provider'],
    ['label', 'agentProvider', 'agentModel', 'agentReasoningEffort', 'persona', 'toolFilter'],
  ),
  'subagent/model-selection-policy': disposition(['allowedModels']),
  'team/member': disposition(['version', 'teamId', 'member']),
  'team/message/delivered': disposition(['version', 'teamId', 'messageId', 'targetId']),
  'team/message/queued': disposition(['version', 'teamId', 'message']),
  'team/task': disposition(['version', 'teamId', 'task']),
  'todo/write': disposition(['todos']),
  'tool-workflow/agent-end': disposition(['runId', 'seq', 'outcome']),
  'tool-workflow/agent-start': disposition(['runId', 'seq', 'label', 'childId'], ['phase']),
  'tool-workflow/run-end': disposition(['runId', 'stopReason']),
  'tool-workflow/run-start': disposition(['runId', 'name']),
  'tool/call': disposition(['turn', 'step', 'callId', 'name', 'arguments']),
  'tool/code-dispatch': disposition(
    ['rootCallId', 'parentCallId', 'subCallId', 'name', 'arguments', 'isError', 'content'],
    [],
    ['arguments'],
  ),
  'tool/code-dispatch-start': disposition(
    ['rootCallId', 'parentCallId', 'subCallId', 'name', 'arguments'],
    [],
    ['arguments'],
  ),
  'tool/result': disposition(
    ['turn', 'step', 'message'],
    ['error', 'meta'],
    ['meta'],
  ),
  'turn/end': disposition(['turn', 'reason']),
  'turn/start': disposition(['turn']),
  'user/message': disposition(['role', 'id', 'content', 'source']),
  'web/deepseek-search-llm-request': disposition(['endpoint', 'apiVersion', 'body']),
})

/** Stable sorted released-v0 event inventory. */
export const RELEASED_V0_EVENT_TYPES: readonly string[] = Object.freeze(
  Object.keys(RELEASED_V0_EVENT_DISPOSITIONS).sort((left, right) => left.localeCompare(right, 'en')),
)
