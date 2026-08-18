/**
 * Models settings page store: one snapshot joining the configurable-provider
 * directory (`llm.providers`), the settings namespaces (`settings.describe`),
 * and the referenced credentials (`credentials.describe`). The host stays the
 * single fact source — every mutation writes through the wire and the page
 * re-renders from the next describe, pushed or refetched.
 */

import type {
  ConfigurableProviderView, CredentialView, IApiClient, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { getPath, hasPath, nodeAtPath, rehydrateSchema } from '@deepseek-ai/dsh-client-schema-form'

/**
 * Any route key walks a dict schema to the same profile node, so the lookup
 * names one that cannot collide with a configured route.
 */
const PROBE_ROUTE = '\u0000probe'

/** One provider row the page renders. */
export interface ProviderRow {
  /** The directory entry (route id, display name, settings address, live state). */
  entry: ConfigurableProviderView
  /** Whether any layer configures this provider (its profile resolves). */
  configured: boolean
  /** Whether the user layer alone carries the profile (removal restores the base). */
  removable: boolean
  /** The credential reference the resolved profile names, when one does. */
  apiKeyEnv: string | undefined
  /** Credential state for {@link apiKeyEnv}, once described. */
  credential: CredentialView | undefined
}

/** Page snapshot. */
export interface ModelsSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay in the editor. */
  error: string | null
  /** Credential enrichment failure; provider/settings rows remain usable. */
  credentialError: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Every configurable provider joined with its configured/credential state. */
  rows: readonly ProviderRow[]
  /** Namespace views by ns, for the editor's schema/layers/secrets. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
}

/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the page still has
 * to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Derive the conventional credential reference for a provider route: the v1
 * page never asks for an environment-variable name, so a typed key stores
 * under this derived reference and the profile records it as `apiKeyEnv`.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * The wire protocols a hand-declared route may name, read out of the owning
 * namespace's own schema. This stays a schema read rather than a wire field so
 * the choices the page offers cannot drift from the ones the adapter accepts:
 * both come from the same `Config`.
 * @param namespace - the namespace view whose schema declares the profile shape.
 * @returns the protocol identifiers, or an empty list when the schema has none.
 */
export function protocolChoices(namespace: SettingsNamespaceView | undefined): string[] {
  if (namespace === undefined) return []
  const node = nodeAtPath(rehydrateSchema(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  const list = (node as { type?: string; list?: readonly { value?: unknown }[] } | undefined)
  if (list?.type !== 'union' || list.list === undefined) return []
  return list.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/**
 * The selectable reasoning levels one pi-ai model may declare, read out of
 * the owning namespace's own schema. The profile field is a dict whose keys
 * are these levels, so the union spelling the keys (`sKey`) is the same
 * schema read `protocolChoices` makes for the wire protocols: the choices the
 * page offers come from the adapter's `Config`, never a client-side copy.
 * @param namespace - the namespace view whose schema declares the profile shape.
 * @returns the level identifiers in pi-ai's canonical order, or an empty list
 * when the schema has none (a non-pi-ai family, or one without the field).
 */
export function modelReasoningLevels(namespace: SettingsNamespaceView | undefined): string[] {
  if (namespace === undefined) return []
  const root = rehydrateSchema(namespace.schema)
  // providers.<route>.models[] is an array; its element object declares the
  // reasoningEfforts field as union(false | dict). The dict node's `sKey`
  // carries the level vocabulary, exactly as the profile's `api` union carries
  // the protocol vocabulary.
  const modelsNode = nodeAtPath(root, ['providers', PROBE_ROUTE, 'models'])
  const modelNode = (modelsNode as { type?: string; inner?: unknown } | undefined)?.inner
  const fieldNode = (modelNode as { type?: string; dict?: Record<string, unknown> } | undefined)?.dict?.['reasoningEfforts']
  const unionList = (fieldNode as { type?: string; list?: readonly unknown[] } | undefined)?.list
  const dictNode = (unionList ?? []).find(entry => (entry as { type?: string } | undefined)?.type === 'dict')
  const keys = (dictNode as { sKey?: { type?: string; list?: readonly { value?: unknown }[] } } | undefined)?.sKey
  if (keys?.type !== 'union' || keys.list === undefined) return []
  return keys.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/**
 * Whether a model's declared `reasoningEfforts` would be refused by the
 * pi-ai adapter, mirroring its `resolveModelReasoning` checks so a card
 * can name the row before a settings write rejects it. Absent (inherit) and
 * `false` (no reasoning) are always accepted; a dict must offer at least one
 * level beyond `off`, and every declared level except `off` must name the
 * wire value to send.
 * @param value - the drafted `reasoningEfforts` value.
 * @returns the failure key owned by the Models settings section, or undefined
 * when the adapter will accept it.
 */
export function reasoningEffortsError(value: unknown): 'modelReasoningEmpty' | 'modelReasoningOnlyOff'
  | 'modelReasoningWireRequired' | undefined {
  if (value === undefined || value === false) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'modelReasoningEmpty'
  }
  const efforts = value as Record<string, unknown>
  if (Object.keys(efforts).length === 0) return 'modelReasoningEmpty'
  let declaredBeyondOff = false
  for (const [level, wire] of Object.entries(efforts)) {
    if (wire === undefined) return 'modelReasoningEmpty'
    if (wire === null) {
      if (level !== 'off') return 'modelReasoningWireRequired'
      continue
    }
    if (typeof wire !== 'string' || wire.length === 0) return 'modelReasoningWireRequired'
    if (level !== 'off') declaredBeyondOff = true
  }
  return declaredBeyondOff ? undefined : 'modelReasoningOnlyOff'
}

/**
 * The first model row whose reasoning declaration the adapter would refuse,
 * for the cards' submit gates and per-row hints. A row without a declaration
 * (inherit) or with `false` never fails here, exactly like
 * `reasoningEffortsError` alone.
 * @param models - the drafted `models` array.
 * @returns the failing row's position and message key, or undefined when the
 * adapter will accept every row.
 */
export function modelsReasoningFailure(models: unknown):
  | { index: number; key: 'modelReasoningEmpty' | 'modelReasoningOnlyOff' | 'modelReasoningWireRequired' }
  | undefined {
  if (!Array.isArray(models)) return undefined
  for (const [index, model] of models.entries()) {
    if (typeof model !== 'object' || model === null) continue
    const key = reasoningEffortsError((model as Record<string, unknown>)['reasoningEfforts'])
    if (key !== undefined) return { index, key }
  }
  return undefined
}

/** The credential reference a resolved profile names (its `apiKeyEnv` field). */
function apiKeyEnvOf(namespace: SettingsNamespaceView | undefined, path: readonly string[]): string | undefined {
  if (namespace === undefined) return undefined
  const profile = getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** The models settings page controller (one per settings surface). */
export class ModelsSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ModelsSettingsState> = createSnapshotStore<ModelsSettingsState>({
    status: 'idle', error: null, credentialError: null, writable: false, rows: [], namespaces: new Map(),
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param api - the wire face (settings/credentials/llm domains).
   */
  constructor(private readonly api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>) {}

  /**
   * Refresh the whole page snapshot: directory and namespaces in parallel,
   * then one batched credential describe over every referenced ref. A
   * failure keeps the last good rows and surfaces the error.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let providers: ConfigurableProviderView[]
    let writable: boolean
    let views: SettingsNamespaceView[]
    try {
      const [providersResponse, settingsResponse] = await Promise.all([
        this.api.llm.providers({}),
        this.api.settings.describe({}),
      ])
      if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
      if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message)
      providers = providersResponse.result.value.providers
      writable = settingsResponse.result.value.writable
      views = settingsResponse.result.value.namespaces
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = error instanceof Error ? error.message : String(error)
      })
      return
    }
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const rows: ProviderRow[] = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || getPath(namespace.value, entry.settingsPath) !== undefined)
      const removable = namespace !== undefined
        && entry.settingsPath.length > 0
        && hasPath(namespace.user, entry.settingsPath)
        && !hasPath(namespace.base, entry.settingsPath)
      return {
        entry,
        configured,
        removable,
        apiKeyEnv: apiKeyEnvOf(namespace, entry.settingsPath),
        credential: undefined,
      }
    })
    const refs = [...new Set(rows.flatMap(row => row.apiKeyEnv === undefined ? [] : [row.apiKeyEnv]))]
    let credentials: Record<string, CredentialView> = {}
    let credentialError: string | null = null
    if (refs.length > 0) {
      try {
        const response = await this.api.credentials.describe({ refs })
        // Credential state is an enrichment for the Models page: neither a
        // business rejection nor a transport failure fails the load. The
        // onboarding projection below retains the failure distinction.
        if (response.result.ok) credentials = response.result.value.credentials
        else credentialError = response.result.error.message
      } catch (error) {
        credentialError = messageOf(error)
      }
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.credentialError = credentialError
      s.writable = writable
      s.rows = rows.map(row => ({
        ...row,
        ...row.apiKeyEnv !== undefined && credentials[row.apiKeyEnv] !== undefined
          ? { credential: credentials[row.apiKeyEnv] }
          : {},
      }))
      s.namespaces = namespaces
    })
  }
}

/**
 * Whether a joined row can serve model requests as it stands: the route is
 * registered with the adapter registry, and whatever credential its resolved
 * profile names is stored. A profile naming no reference authenticates through
 * the provider's own path (the Bedrock chain, Vertex ADC, a gateway that needs
 * nothing), as does a live route with no settings address at all, so neither
 * owes this page a key.
 * @param row - one joined provider row.
 * @returns whether the user already has this provider to talk to.
 */
export function providerUsable(row: ProviderRow): boolean {
  if (!row.entry.active) return false
  if (row.apiKeyEnv === undefined) return true
  return row.credential?.configured === true
}

/** First-run onboarding readiness derived only from the shared Models join. */
export type OnboardingReadiness =
  | { kind: 'loading' }
  | { kind: 'adapter-absent' }
  | { kind: 'provider-ready' }
  | { kind: 'credential-missing' }
  | {
    kind: 'unavailable'
    reason:
      | 'load-failed'
      | 'provider-inactive'
      | 'credentials-unavailable'
      | 'settings-read-only'
      | 'credential-read-only'
  }

/**
 * Project first-run readiness from the provider/settings/credential join used
 * by the Models page. The step exists to leave the user with a model to talk
 * to, so ANY usable provider ends it; only when none exists does the official
 * DeepSeek route — the one route the prompt can offer a key field for — decide
 * whether prompting can help. A missing official configurable-provider
 * declaration means the adapter is not repairable by navigating to Models.
 * @param state - current shared Models join snapshot.
 * @returns the onboarding state without reading a parallel fact source.
 */
export function onboardingReadiness(state: ModelsSettingsState): OnboardingReadiness {
  if ((state.status === 'idle' || state.status === 'loading') && state.rows.length === 0) {
    return { kind: 'loading' }
  }
  if (state.status === 'error') {
    return {
      kind: 'unavailable',
      reason: 'load-failed',
    }
  }
  if (state.rows.some(providerUsable)) return { kind: 'provider-ready' }
  const row = state.rows.find(candidate =>
    candidate.entry.provider === 'deepseek-official'
    && candidate.entry.settingsNs === 'llm-deepseek'
    && candidate.entry.settingsPath.length === 0)
  if (row === undefined) return { kind: 'adapter-absent' }
  if (!row.entry.active) {
    return {
      kind: 'unavailable',
      reason: 'provider-inactive',
    }
  }
  // Past the usable gate an active route names a reference it has no stored
  // credential for, so the remaining questions are all about that credential.
  if (state.credentialError !== null || row.credential === undefined) {
    return {
      kind: 'unavailable',
      reason: 'credentials-unavailable',
    }
  }
  if (!state.writable) {
    return {
      kind: 'unavailable',
      reason: 'settings-read-only',
    }
  }
  if (!row.credential.writable) {
    return {
      kind: 'unavailable',
      reason: 'credential-read-only',
    }
  }
  return { kind: 'credential-missing' }
}
