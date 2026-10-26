/**
 * Answering "which models can this provider serve?" for the configuration
 * surface's "fetch available models" action.
 *
 * A draft that names no endpoint on a route the installed pi-ai catalog ships
 * is answered **from that catalog**, with no network call at all: pi-ai's
 * registry carries the capacities a listing endpoint would not disclose. A
 * draft that does name an endpoint — every route the catalog does not describe,
 * plus any catalog route whose form shows one — is interrogated over the wire,
 * and the catalog entry of each listed id fills the capacities and modalities
 * that reply left out. Membership comes from the endpoint because the installed
 * catalog lags a provider's releases, and answering from the catalog alone
 * would withhold every model newer than the installed pi-ai data.
 *
 * Neither path is a catalog refresh. Nothing here is stored: the request
 * carries a draft the user is still editing, and the reply is candidate
 * metadata the surface offers for adoption. `cordis.patch.yml` remains the only
 * thing that decides what a route serves.
 *
 * OpenAI-compatible and Anthropic Messages protocols are interrogated through
 * their native model-listing endpoints. A draft that names no protocol is asked
 * in the one its route's shipped models share, so an Anthropic catalog is not
 * queried at the OpenAI listing path. The parser accepts the standard `data`
 * array and the enriched `models` map some compatible gateways expose. Every
 * other protocol reports that it cannot be interrogated so the surface falls
 * back to hand-entry rather than guessing its response fields.
 *
 * @module dsh-llm-pi-ai/discovery
 */

import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryOperation } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { catalogModels, sharedCatalogApi } from './catalog.ts'

/**
 * Protocols whose model listing this module can read. OpenAI protocols use
 * bearer auth at `GET {baseURL}/models`; Anthropic Messages uses `x-api-key`
 * and `anthropic-version` at its native `GET /v1/models`. Azure is absent
 * despite its OpenAI lineage — it authenticates with an `api-key` header and
 * requires an `api-version` query — and Codex authenticates through OAuth;
 * guessing at either would report an authentication failure as a provider
 * with no models. pi-ai's remaining protocols are absent for the same reason.
 */
const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
])

/** Stable API version required by Anthropic's model-listing endpoint. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Largest model-list page accepted by Anthropic's public endpoint; discovery reads one page and does not follow `has_more`. */
const ANTHROPIC_MODEL_LIMIT = 1000

/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims — the same two-stage shape `dsh-web-fetch`
 * uses for its own caller-supplied URLs, except that a truncated model listing
 * is not parseable, so overflow rejects instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Capacity fields nested by enriched model-directory replies. */
interface ListingLimit {
  context?: unknown
  output?: unknown
}

/** Per-route capacities OpenRouter nests under each entry. */
interface ListingTopProvider {
  max_completion_tokens?: unknown
}

/** Modality spellings an entry may nest under an `architecture` object. */
interface ListingArchitecture {
  input_modalities?: unknown
}

/** Modality spellings an entry may nest under a `modalities` object. */
interface ListingModalities {
  input?: unknown
}

/** One entry of a supported `GET /models` reply. */
interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  displayName?: unknown
  contextWindow?: unknown
  context_window?: unknown
  context_length?: unknown
  max_input_tokens?: unknown
  maxOutputTokens?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  maxTokens?: unknown
  /** OpenAI-style top-level modality list, or the `{input}` object a gateway nests instead. */
  modalities?: unknown
  /** OpenRouter nests its modality list under this object. */
  architecture?: ListingArchitecture | null
  limit?: ListingLimit | null
  top_provider?: ListingTopProvider | null
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/**
 * The modalities an entry declares, or `undefined` when it names none this
 * harness knows. Unrecognized spellings are dropped individually — gateways
 * have coined audio and video terms this build cannot serve, and one such term
 * beside `text` must not erase the text fact. A list with no recognized term
 * and a non-list shape both read as "the endpoint said nothing usable", so the
 * adopted row stays unclaimed and inheritance decides.
 * @param entry - the raw listing entry.
 * @returns the recognized modalities, or `undefined`.
 */
function declaredModalities(entry: ListingEntry): ('text' | 'image')[] | undefined {
  const modalities = entry.modalities as ListingModalities | null | undefined
  const candidates = [
    entry.modalities,
    // A gateway nests the same list under `modalities.input` instead of listing
    // it directly; both spellings describe the same fact.
    modalities !== null && typeof modalities === 'object' && !Array.isArray(modalities)
      ? modalities.input
      : undefined,
    entry.architecture?.input_modalities,
  ]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const known = [...new Set(candidate.filter((modality): modality is 'text' | 'image' =>
      modality === 'text' || modality === 'image'))]
    if (known.length > 0) return known
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Join the endpoint base with the protocol's listing path. The base is
 * treated as a prefix rather than a URL to resolve against, so a deployment
 * path such as `https://gateway.example/openai/v1` keeps its segments instead
 * of losing them to `URL` resolution. OpenAI protocols list at
 * `{baseURL}/models`. Anthropic lists at `{root}/v1/models`, where the root is
 * the base without trailing slashes and without one trailing `/v1` segment:
 * gateway documentation publishes both spellings of the same root. Only this
 * listing URL normalizes that segment; model requests receive the configured
 * `baseURL` unchanged.
 */
function listingUrl(baseURL: string, api: string): string {
  const base = baseURL.replace(/\/+$/, '')
  if (api !== 'anthropic-messages') return `${base}/models`
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares (or streams) tells us nothing up front.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Read one supported model-listing reply. The standard `data` array takes
 * precedence when both supported formats are present. An enriched `models`
 * map uses each property key as the endpoint-facing id; its nested `id` is
 * only a fallback for an empty key because gateways may put a canonical model
 * identity there instead of the alias they accept on requests. Only
 * object-valued map entries are models; primitive properties are ignored
 * because they may be directory metadata rather than model records.
 *
 * Entries without a usable id are skipped rather than failing the whole
 * interrogation: a single malformed row should not deny the user the rest of
 * a working endpoint's catalog. Missing names fall back to the adopted id so
 * the Web form receives a complete human-readable row.
 */
function readListing(body: unknown): (LlmDiscoveredModel & { name: string })[] {
  const listing = body as { data?: unknown; models?: unknown } | null
  const data = listing?.data
  let listed: { readonly key?: string; readonly raw: unknown }[]
  if (Array.isArray(data)) {
    const rows = data as readonly unknown[]
    listed = rows.map(raw => ({ raw }))
  } else {
    const models = listing?.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new LlmError(
        'the endpoint\'s model listing has neither a "data" array nor a "models" object; '
        + 'enter this provider\'s models by hand',
        'DISCOVERY_FAILED',
      )
    }
    listed = Object.entries(models as Record<string, unknown>)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }))
  }
  const models: (LlmDiscoveredModel & { name: string })[] = []
  for (const { key, raw } of listed) {
    const entry = raw as ListingEntry | null
    const id = label(key, entry?.id)
    if (id === undefined) continue
    const name = label(entry?.name, entry?.display_name, entry?.displayName) ?? id
    const contextWindow = capacity(
      entry?.contextWindow,
      entry?.context_window,
      entry?.context_length,
      entry?.max_input_tokens,
      entry?.limit?.context,
    )
    const maxTokens = capacity(
      entry?.maxOutputTokens,
      entry?.max_output_tokens,
      entry?.maxTokens,
      entry?.max_tokens,
      entry?.limit?.output,
      entry?.top_provider?.max_completion_tokens,
    )
    /* v8 ignore next -- a null entry has no id, so the `continue` above already skipped it */
    const input = entry === null ? undefined : declaredModalities(entry)
    models.push({
      id,
      name,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...input === undefined ? {} : { input },
    })
  }
  return models
}

/**
 * Accept one probe key, or refuse it before the header is built. Without this
 * the `fetch` below would throw a ByteString `TypeError` that this function's
 * catch reports as `could not reach <url>` — blaming the network for a local,
 * deterministic fault.
 * @param raw - the key typed into the form or read from storage.
 * @returns the trimmed, usable key.
 */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/** Host-owned profile inputs that a configuration draft deliberately omits. */
export interface StoredModelDiscoveryProfile {
  /** Deployment headers configured on the named route. */
  readonly headers: Readonly<Record<string, string>> | undefined
  /** Resolve the named route's credential only when the draft carries none. */
  readonly resolveApiKey: () => Promise<string | undefined>
}

/** The catalog's own answer for one route, carrying what no listing discloses. */
function catalogAnswers(installed: ReadonlyMap<string, { id: string; name: string; contextWindow: number; maxTokens: number; input: readonly ('text' | 'image')[] }>): LlmDiscoveredModel[] {
  return [...installed.values()].map(model => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    /* v8 ignore next -- every installed catalog entry declares at least one modality */
    ...model.input.length > 0 ? { input: [...model.input] } : {},
    inputModalities: [...model.input],
  }))
}

/**
 * Fill what one endpoint's listing left out from the installed catalog entry of
 * the same id. The endpoint decides which models exist — a provider releases a
 * model its catalog has not recorded — while the catalog keeps the capacities it
 * curates, which listings report partly or not at all. A listed model the
 * catalog does not describe keeps exactly what the endpoint disclosed.
 *
 * A name the listing supplies wins over the catalog's; the catalog's applies
 * only where the listing repeated the request id, which {@link readListing}
 * substitutes when an entry names nothing.
 * @param listed - the models the endpoint advertises, in its order.
 * @param installed - the installed catalog entries for the same route.
 * @returns the endpoint's models with undisclosed facts filled in.
 */
function completeFromCatalog(
  listed: readonly (LlmDiscoveredModel & { name: string })[],
  installed: ReadonlyMap<string, { name: string; contextWindow: number; maxTokens: number; input: readonly ('text' | 'image')[] }>,
): LlmDiscoveredModel[] {
  return listed.map((model): LlmDiscoveredModel => {
    const installedModel = installed.get(model.id)
    if (installedModel === undefined) return { ...model }
    // `readListing` substitutes the request id where an entry names nothing, so
    // an equal name is the absence of one rather than a curated spelling.
    const name = model.name === model.id ? installedModel.name : model.name
    return {
      id: model.id,
      name,
      contextWindow: model.contextWindow ?? installedModel.contextWindow,
      maxTokens: model.maxTokens ?? installedModel.maxTokens,
      input: model.input ?? [...installedModel.input],
    }
  })
}

/**
 * Interrogate one draft provider endpoint for the models it advertises.
 *
 * A route the installed catalog ships is answered from that catalog only when
 * the draft names no endpoint; a draft that does name one is interrogated, and
 * the catalog then fills the capacities its reply leaves out. The endpoint has
 * to decide membership: the installed catalog lags a provider's releases, and
 * answering from it alone would withhold every model newer than the installed
 * pi-ai data.
 * @param request - the endpoint, protocol, and one-shot credential to use.
 * @param storedProfile - Host-owned headers and lazy credential resolution for
 *   the named route. It is read only on the path that reaches the network; the
 *   credential is resolved only when the draft carries none.
 * @returns the advertised models in endpoint order.
 * @throws LlmError when the protocol has no readable listing, the endpoint
 *   refuses or fails the request, or the reply is not a model listing.
 */
export async function discoverModels(
  request: LlmModelDiscoveryOperation,
  storedProfile?: () => StoredModelDiscoveryProfile | undefined,
): Promise<readonly LlmDiscoveredModel[]> {
  const installed = request.provider === undefined ? new Map() : catalogModels(request.provider)
  // Without an endpoint there is nothing to ask, and a catalog route already
  // has its answer — the better one, since it costs no network call.
  if (installed.size > 0 && (request.baseURL ?? '').length === 0) return catalogAnswers(installed)
  if (request.baseURL === undefined || request.baseURL.length === 0) {
    throw new LlmError(
      `pi-ai ships no catalog for provider "${request.provider ?? ''}", so its models can only come from its`
      + " endpoint; set a baseURL, or enter this provider's models by hand",
      'DISCOVERY_FAILED',
    )
  }
  // A catalog route shares the protocol its shipped models agree on, so a draft
  // that has not chosen one still asks the right endpoint. A route with no
  // shared answer — and every route the catalog does not describe — is asked as
  // OpenAI Chat Completions: it is the shape a gateway is overwhelmingly likely
  // to speak, and the alternative — refusing until the field is filled — would
  // withhold the action from the case it exists for. The cost is a misdirected
  // message when the endpoint speaks something else (an Anthropic gateway
  // answers 401, which reads as a credential problem), and hand-entry remains
  // the way out.
  const api = request.api ?? sharedCatalogApi(installed) ?? 'openai-completions'
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new LlmError(
      `pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      'DISCOVERY_UNSUPPORTED',
    )
  }
  const url = listingUrl(request.baseURL, api)
  // A key typed into the form wins: it may replace the stored key that is
  // failing. The stored profile is asked past the catalog and protocol checks,
  // and its credential resolver remains lazy so a typed key cannot fail over a
  // stored credential it supersedes. A route may still authenticate through a
  // deployment-owned Authorization header when neither key exists.
  const stored = storedProfile?.()
  const supplied = request.apiKey ?? await stored?.resolveApiKey()
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  let response: Response
  try {
    const headers = new Headers(stored?.headers === undefined ? undefined : Object.entries(stored.headers))
    headers.set('accept', 'application/json')
    if (api === 'anthropic-messages') {
      headers.set('anthropic-version', ANTHROPIC_VERSION)
      if (apiKey !== undefined) headers.set('x-api-key', apiKey)
    } else if (apiKey !== undefined) {
      headers.set('authorization', `Bearer ${apiKey}`)
    }
    for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
    response = await fetch(url, {
      method: 'GET',
      headers,
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error: unknown) {
    // Cancellation during the body read rejects with the abort reason, which
    // may be any value; the caller gets the same coded failure it would have
    // for a cancellation before the request went out.
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return completeFromCatalog(readListing(body), installed)
}
