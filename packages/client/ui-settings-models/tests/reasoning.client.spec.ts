// @vitest-environment jsdom
/** Unit tests for reasoning-levels store helpers: schema extraction, per-row validation, and list scan. */
import { describe, expect, it } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  modelReasoningLevels,
  modelsReasoningFailure,
  reasoningEffortsError,
} from '../src/client/store.ts'

// ---------------------------------------------------------------------------
// Helpers: build a serialized pi-ai schema with models[].reasoningEfforts
// ---------------------------------------------------------------------------

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * A pi-ai schema whose models array element declares reasoningEfforts.
 * Matches the real pi-ai config: dict(inner: string|null, sKey: thinking-levels).
 */
const PiAiWithReasoning = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    baseURL: Schema.string(),
    models: Schema.array(Schema.object({
      id: Schema.string().required(),
      name: Schema.string(),
      contextWindow: Schema.number().step(1).min(1),
      maxTokens: Schema.number().step(1).min(1),
      reasoningEfforts: Schema.union([
        Schema.const(false),
        Schema.dict(
          // inner = value type (wire spelling: string or null for "send nothing")
          Schema.union([Schema.string(), Schema.const(null)]),
          // sKey = key type (level identifiers)
          Schema.union([...THINKING_LEVELS]),
        ),
      ]),
    })),
  })),
})

/** A pi-ai schema whose models array has no reasoningEfforts field. */
const PiAiWithoutReasoning = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    baseURL: Schema.string(),
    models: Schema.array(Schema.object({
      id: Schema.string().required(),
      name: Schema.string(),
    })),
  })),
})

/** A non-pi-ai schema (deepseek-style flat config). */
const DeepSeekSchema = Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref'),
  baseURL: Schema.string(),
})

/** Serialize a schemastery node to the JSON shape the settings page stores. */
function serialize(schema: ReturnType<typeof Schema.object>): unknown {
  return JSON.parse(JSON.stringify(schema.toJSON())) as unknown
}

/** Build a minimal SettingsNamespaceView with the given schema. */
function ns(schema: unknown): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema,
    value: {},
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  }
}

// ===========================================================================
// modelReasoningLevels
// ===========================================================================

describe('modelReasoningLevels', () => {
  it('returns an empty list for an undefined namespace', () => {
    expect(modelReasoningLevels(undefined)).toEqual([])
  })

  it('returns levels from a pi-ai schema that declares reasoningEfforts', () => {
    const view = ns(serialize(PiAiWithReasoning))
    const levels = modelReasoningLevels(view)
    expect(levels).toEqual([...THINKING_LEVELS])
  })

  it('returns an empty list when the schema has models but no reasoningEfforts field', () => {
    const view = ns(serialize(PiAiWithoutReasoning))
    expect(modelReasoningLevels(view)).toEqual([])
  })

  it('returns an empty list for a non-pi-ai schema without the providers.models path', () => {
    const view = ns(serialize(DeepSeekSchema))
    expect(modelReasoningLevels(view)).toEqual([])
  })
})

// ===========================================================================
// reasoningEffortsError
// ===========================================================================

describe('reasoningEffortsError', () => {
  // --- Accepted values (no error) ---

  it('accepts undefined (inherit)', () => {
    expect(reasoningEffortsError(undefined)).toBeUndefined()
  })

  it('accepts false (no reasoning)', () => {
    expect(reasoningEffortsError(false)).toBeUndefined()
  })

  it('accepts a valid dict with off and a thinking level', () => {
    expect(reasoningEffortsError({ off: null, high: 'high' })).toBeUndefined()
  })

  it('accepts a dict with only a thinking level (no off)', () => {
    expect(reasoningEffortsError({ high: 'high' })).toBeUndefined()
  })

  it('accepts a dict with multiple thinking levels', () => {
    expect(reasoningEffortsError({ low: 'low', medium: 'medium', high: 'high' })).toBeUndefined()
  })

  // --- modelReasoningEmpty ---

  it('rejects an array', () => {
    expect(reasoningEffortsError([])).toBe('modelReasoningEmpty')
  })

  it('rejects a string', () => {
    expect(reasoningEffortsError('high')).toBe('modelReasoningEmpty')
  })

  it('rejects a number', () => {
    expect(reasoningEffortsError(42)).toBe('modelReasoningEmpty')
  })

  it('rejects null', () => {
    expect(reasoningEffortsError(null)).toBe('modelReasoningEmpty')
  })

  it('rejects an empty dict', () => {
    expect(reasoningEffortsError({})).toBe('modelReasoningEmpty')
  })

  it('rejects a dict with an undefined wire value', () => {
    expect(reasoningEffortsError({ high: undefined })).toBe('modelReasoningEmpty')
  })

  // --- modelReasoningWireRequired ---

  it('rejects a dict where a non-off level has null wire', () => {
    expect(reasoningEffortsError({ high: null })).toBe('modelReasoningWireRequired')
  })

  it('rejects a dict where a non-off level has empty string wire', () => {
    expect(reasoningEffortsError({ high: '' })).toBe('modelReasoningWireRequired')
  })

  it('rejects a dict where a non-off level has a numeric wire', () => {
    expect(reasoningEffortsError({ high: 1 })).toBe('modelReasoningWireRequired')
  })

  it('rejects when only one of multiple levels has an empty wire', () => {
    expect(reasoningEffortsError({ low: 'low', high: '' })).toBe('modelReasoningWireRequired')
  })

  it('rejects off with an explicit empty string wire value', () => {
    // off wired to an empty string is rejected: only null means "send nothing".
    expect(reasoningEffortsError({ off: '' })).toBe('modelReasoningWireRequired')
  })

  // --- modelReasoningOnlyOff ---

  it('rejects a dict with only the off level', () => {
    expect(reasoningEffortsError({ off: null })).toBe('modelReasoningOnlyOff')
  })
})

// ===========================================================================
// modelsReasoningFailure
// ===========================================================================

describe('modelsReasoningFailure', () => {
  it('returns undefined for a non-array argument', () => {
    expect(modelsReasoningFailure(undefined)).toBeUndefined()
    expect(modelsReasoningFailure(null)).toBeUndefined()
    expect(modelsReasoningFailure('string')).toBeUndefined()
    expect(modelsReasoningFailure(42)).toBeUndefined()
  })

  it('returns undefined for an empty array', () => {
    expect(modelsReasoningFailure([])).toBeUndefined()
  })

  it('returns undefined when all models inherit (no reasoningEfforts)', () => {
    expect(modelsReasoningFailure([
      { id: 'm1' },
      { id: 'm2', name: 'Model 2' },
    ])).toBeUndefined()
  })

  it('returns undefined when all models have valid reasoningEfforts', () => {
    expect(modelsReasoningFailure([
      { id: 'm1', reasoningEfforts: false },
      { id: 'm2', reasoningEfforts: { off: null, high: 'high' } },
    ])).toBeUndefined()
  })

  it('skips non-object entries', () => {
    expect(modelsReasoningFailure([
      'not an object',
      null,
      42,
      { id: 'm1', reasoningEfforts: { off: null, high: 'high' } },
    ])).toBeUndefined()
  })

  it('returns the first failing row with its error key', () => {
    const result = modelsReasoningFailure([
      { id: 'm1', reasoningEfforts: false },
      { id: 'm2', reasoningEfforts: {} },
      { id: 'm3', reasoningEfforts: { off: null, high: 'high' } },
    ])
    expect(result).toEqual({ index: 1, key: 'modelReasoningEmpty' })
  })

  it('returns index 0 when the first model fails', () => {
    const result = modelsReasoningFailure([
      { id: 'm1', reasoningEfforts: { off: null } },
    ])
    expect(result).toEqual({ index: 0, key: 'modelReasoningOnlyOff' })
  })

  it('distinguishes between wire-required and only-off failures', () => {
    const result = modelsReasoningFailure([
      { id: 'm1', reasoningEfforts: { high: null } },
    ])
    expect(result).toEqual({ index: 0, key: 'modelReasoningWireRequired' })
  })

  it('returns undefined when models is a plain object (not array)', () => {
    expect(modelsReasoningFailure({ id: 'm1' })).toBeUndefined()
  })
})
