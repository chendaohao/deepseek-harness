/**
 * Typed business API for the mobile surface, riding the platform /api unary
 * transport. Every method folds to an `RpcResult`; response values are
 * validated structurally here (the surface bundle cannot value-import the
 * host-apiproxy zod schemas, so the wire shapes are re-checked by hand).
 * Malformed rows are dropped so one bad record never blanks a list; a
 * malformed top-level value fails loud as a folded error.
 */

import { callUnary, type RpcResult } from './rpc.ts'
import type { WireEvent } from './messages.ts'

/** One workspace roster row (workspace.* responses). */
export interface WorkspaceView {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

/** One session.list row. */
export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  agentPreset?: string
  /** Projection baseline (the persisted title lives at `values.title`). */
  projections?: { values?: Record<string, unknown> }
}

/** One session.search result. */
export interface SessionSearchItem {
  sessionId: string
  snippet: string
}

/** One session.history entry (the tool view is not rendered on this surface). */
export interface HistoryEntry {
  event: WireEvent
}

/** The session.history tail page. */
export interface HistoryPage {
  events: HistoryEntry[]
  hasMore: boolean
  /** Projection baseline riding the tail page (title, permissions, ...). */
  projections?: { asOfSeq: number; values: Record<string, unknown> }
}

/** Complete provider/model selection. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** One adapter-owned reasoning effort. */
export interface ModelReasoningEffort {
  id: string
  name: string
  description?: string
}

/** Exact-model reasoning metadata. */
export interface ModelReasoning {
  efforts: ModelReasoningEffort[]
  defaultEffort?: string
}

/** One advisory model entry inside a provider group. */
export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: ModelReasoning
}

/** One successfully loaded provider group. */
export interface ModelProviderGroup {
  id: string
  name: string
  models: ModelCatalogModel[]
}

/** One provider-local catalog failure. */
export interface ModelCatalogFailure {
  id: string
  name: string
  message: string
}

/** The session.models advisory directory. */
export interface SessionModels {
  current: ModelSelection
  routable: boolean
  groups: ModelProviderGroup[]
  failures: ModelCatalogFailure[]
}

/** The session.create result (the id is the commit the caller navigates to). */
export interface CreatedSession {
  sessionId: string
  agentPreset?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** Run one unary call and validate the response value; malformed → folded error. */
async function callParsed<T>(
  method: string,
  payload: unknown,
  parse: (value: unknown) => T | undefined,
  label: string,
): Promise<RpcResult<T>> {
  const result = await callUnary<unknown>(method, payload)
  if (!result.ok) return result
  const value = parse(result.value)
  if (value === undefined) return { ok: false, error: { code: 'malformed', message: `${label}: unexpected response shape` } }
  return { ok: true, value }
}

function parseWorkspaceView(value: unknown): WorkspaceView | undefined {
  if (!isRecord(value)) return undefined
  const { workspaceId, path, title, createdAt, updatedAt } = value
  if (typeof workspaceId !== 'string' || typeof path !== 'string' || typeof title !== 'string'
    || typeof createdAt !== 'string' || typeof updatedAt !== 'string') return undefined
  return {
    workspaceId,
    path,
    title,
    sessionIds: isStringArray(value['sessionIds']) ? value['sessionIds'] : [],
    createdAt,
    updatedAt,
  }
}

function parseSessionSummary(value: unknown): SessionSummary | undefined {
  if (!isRecord(value)) return undefined
  const { sessionId, updatedAt } = value
  if (typeof sessionId !== 'string' || typeof updatedAt !== 'number') return undefined
  const result: SessionSummary = {
    sessionId,
    updatedAt,
    running: value['running'] === true,
    blank: value['blank'] === true,
  }
  const cwd = value['cwd']
  if (typeof cwd === 'string') result.cwd = cwd
  const agentPreset = value['agentPreset']
  if (typeof agentPreset === 'string') result.agentPreset = agentPreset
  const projections = value['projections']
  if (isRecord(projections) && isRecord(projections['values'])) {
    result.projections = { values: projections['values'] }
  }
  return result
}

function parseHistoryEntry(value: unknown): HistoryEntry | undefined {
  if (!isRecord(value)) return undefined
  const event = value['event']
  if (!isRecord(event)) return undefined
  const { type, seq, time } = event
  if (typeof type !== 'string' || typeof seq !== 'number' || typeof time !== 'number') return undefined
  return { event: { type, seq, time, data: event['data'] } }
}

function parseModelSelection(value: unknown): ModelSelection | undefined {
  if (!isRecord(value)) return undefined
  const { provider, model } = value
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  const result: ModelSelection = { provider, model }
  const reasoningEffort = value['reasoningEffort']
  if (typeof reasoningEffort === 'string') result.reasoningEffort = reasoningEffort
  return result
}

function parseReasoning(value: unknown): ModelReasoning | undefined {
  if (!isRecord(value)) return undefined
  const efforts = Array.isArray(value['efforts'])
    ? value['efforts'].map((effort) => {
      if (!isRecord(effort) || typeof effort['id'] !== 'string' || typeof effort['name'] !== 'string') return undefined
      const parsed: ModelReasoningEffort = { id: effort['id'], name: effort['name'] }
      const description = effort['description']
      if (typeof description === 'string') parsed.description = description
      return parsed
    }).filter((effort): effort is ModelReasoningEffort => effort !== undefined)
    : []
  if (efforts.length === 0) return undefined
  const result: ModelReasoning = { efforts }
  const defaultEffort = value['defaultEffort']
  if (typeof defaultEffort === 'string') result.defaultEffort = defaultEffort
  return result
}

function parseModel(value: unknown): ModelCatalogModel | undefined {
  if (!isRecord(value)) return undefined
  const { id, name } = value
  if (typeof id !== 'string' || typeof name !== 'string') return undefined
  const result: ModelCatalogModel = { id, name }
  const description = value['description']
  if (typeof description === 'string') result.description = description
  const reasoning = parseReasoning(value['reasoning'])
  if (reasoning !== undefined) result.reasoning = reasoning
  return result
}

function parseProviderGroup(value: unknown): ModelProviderGroup | undefined {
  if (!isRecord(value)) return undefined
  const { id, name } = value
  if (typeof id !== 'string' || typeof name !== 'string') return undefined
  const models = Array.isArray(value['models'])
    ? value['models'].map(parseModel).filter((model): model is ModelCatalogModel => model !== undefined)
    : []
  return { id, name, models }
}

function parseModelFailure(value: unknown): ModelCatalogFailure | undefined {
  if (!isRecord(value)) return undefined
  const { id, name, message } = value
  if (typeof id !== 'string' || typeof name !== 'string' || typeof message !== 'string') return undefined
  return { id, name, message }
}

function parseWorkspaceList(value: unknown): WorkspaceView[] | undefined {
  if (!isRecord(value) || !Array.isArray(value['items'])) return undefined
  return value['items'].map(parseWorkspaceView).filter((item): item is WorkspaceView => item !== undefined)
}

function parseSessionList(value: unknown): SessionSummary[] | undefined {
  if (!isRecord(value) || !Array.isArray(value['items'])) return undefined
  return value['items'].map(parseSessionSummary).filter((item): item is SessionSummary => item !== undefined)
}

function parseSearchList(value: unknown): SessionSearchItem[] | undefined {
  if (!isRecord(value) || !Array.isArray(value['items'])) return undefined
  const items: SessionSearchItem[] = []
  for (const raw of value['items']) {
    if (!isRecord(raw) || typeof raw['sessionId'] !== 'string') continue
    const snippet = raw['snippet']
    items.push({ sessionId: raw['sessionId'], snippet: typeof snippet === 'string' ? snippet : '' })
  }
  return items
}

function parseHistoryPage(value: unknown): HistoryPage | undefined {
  if (!isRecord(value) || !Array.isArray(value['events'])) return undefined
  const result: HistoryPage = {
    events: value['events'].map(parseHistoryEntry).filter((entry): entry is HistoryEntry => entry !== undefined),
    hasMore: value['hasMore'] === true,
  }
  const projections = value['projections']
  if (isRecord(projections)) {
    const asOfSeq = projections['asOfSeq']
    if (typeof asOfSeq === 'number' && isRecord(projections['values'])) {
      result.projections = { asOfSeq, values: projections['values'] }
    }
  }
  return result
}

function parseCreatedSession(value: unknown): CreatedSession | undefined {
  if (!isRecord(value) || typeof value['sessionId'] !== 'string') return undefined
  const result: CreatedSession = { sessionId: value['sessionId'] }
  const agentPreset = value['agentPreset']
  if (typeof agentPreset === 'string') result.agentPreset = agentPreset
  return result
}

function parseModels(value: unknown): SessionModels | undefined {
  if (!isRecord(value)) return undefined
  const current = parseModelSelection(value['current'])
  if (current === undefined) return undefined
  return {
    current,
    routable: value['routable'] === true,
    groups: Array.isArray(value['groups'])
      ? value['groups'].map(parseProviderGroup).filter((group): group is ModelProviderGroup => group !== undefined)
      : [],
    failures: Array.isArray(value['failures'])
      ? value['failures'].map(parseModelFailure).filter((failure): failure is ModelCatalogFailure => failure !== undefined)
      : [],
  }
}

function parseSelected(value: unknown): ModelSelection | undefined {
  if (!isRecord(value)) return undefined
  return parseModelSelection(value['selected'])
}

function parseRenamed(value: unknown): { title: string; seq: number } | undefined {
  if (!isRecord(value) || typeof value['title'] !== 'string' || typeof value['seq'] !== 'number') return undefined
  return { title: value['title'], seq: value['seq'] }
}

/**
 * The workspace roster.
 * @returns the workspace list result.
 */
export function listWorkspaces(): Promise<RpcResult<WorkspaceView[]>> {
  return callParsed('workspace.list', {}, parseWorkspaceList, 'workspace.list')
}

/**
 * All sessions (the v1 list has no pagination cursor).
 * @returns the session summary list result.
 */
export function listSessions(): Promise<RpcResult<SessionSummary[]>> {
  return callParsed('session.list', {}, parseSessionList, 'session.list')
}

/**
 * Full-text session search, returning matched session ids with snippets.
 * @param query - the search text.
 * @returns the matched session search items.
 */
export function searchSessions(query: string): Promise<RpcResult<SessionSearchItem[]>> {
  return callParsed('session.search', { query }, parseSearchList, 'session.search')
}

/**
 * Create a blank session attached to one workspace.
 * @param workspaceId - the workspace to attach the session to.
 * @returns the created session result.
 */
export function createSession(workspaceId: string): Promise<RpcResult<CreatedSession>> {
  return callParsed('session.create', { workspaceId }, parseCreatedSession, 'session.create')
}

/**
 * One history window; omit beforeSeq for the tail page.
 * @param sessionId - the session whose history is read.
 * @param beforeSeq - optional exclusive sequence bound for an earlier page.
 * @param maxMessages - page size, default 30.
 * @returns the history page result.
 */
export function history(
  sessionId: string,
  beforeSeq?: number,
  maxMessages = 30,
): Promise<RpcResult<HistoryPage>> {
  return callParsed('session.history', {
    sessionId,
    maxMessages,
    ...(beforeSeq !== undefined ? { beforeSeq } : {}),
  }, parseHistoryPage, 'session.history')
}

/**
 * Send one text prompt (queued: the agent picks it up in order).
 * @param sessionId - the session receiving the prompt.
 * @param text - the prompt text.
 * @returns the acceptance result.
 */
export function prompt(sessionId: string, text: string): Promise<RpcResult<{ accepted: true }>> {
  return callParsed('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  }, value => isRecord(value) && value['accepted'] === true ? { accepted: true } : undefined, 'session.prompt')
}

/**
 * Fresh advisory model directory for one session.
 * @param sessionId - the session whose model directory is read.
 * @returns the model directory result.
 */
export function models(sessionId: string): Promise<RpcResult<SessionModels>> {
  return callParsed('session.models', { sessionId }, parseModels, 'session.models')
}

/**
 * Select the complete model selection (provider/model/reasoning effort) for a session.
 * @param sessionId - the session whose model selection changes.
 * @param selection - the model selection to apply.
 * @returns the applied model selection result.
 */
export function selectModel(
  sessionId: string,
  selection: ModelSelection,
): Promise<RpcResult<ModelSelection>> {
  return callParsed('session.selectModel', {
    sessionId,
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
  }, parseSelected, 'session.selectModel')
}

/**
 * Rename a session (the host normalizes the accepted title).
 * @param sessionId - the session to rename.
 * @param title - the requested title.
 * @returns the normalized title and its sequence number.
 */
export function renameSession(sessionId: string, title: string): Promise<RpcResult<{ title: string; seq: number }>> {
  return callParsed('session.rename', { sessionId, title }, parseRenamed, 'session.rename')
}
