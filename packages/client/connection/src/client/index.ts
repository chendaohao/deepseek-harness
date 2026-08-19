/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared API client, and lets the runtime object layer start the stream
 * controller with its sinks.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HostDescription, IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { FixtureApiClient } from './fixture.ts'
import { WebApiClient } from './web-api-client.ts'
import { createWebConnectionRpc } from './rpc.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import type { ClientConnectionRpc } from '../rpc.ts'

// ---- Contract re-exports (browser-safe apiproxy channels + core types) ----
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, PromptContentPart, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  DirectoryEntry, DirectoryListing,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView,
  SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  MessageId, ModelReasoningEffort, ModelSelection, QueueAction, QueuedInboxItem, SessionModels,
  SubagentsApi, SubagentAddress, SubagentCatalog, SubagentListEntry, SubagentPromptReceipt,
  JobView,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  HostDescription, IApiClient, SessionId, SessionEvent, ContentBlock, StreamChunk,
  GoalsApi, GoalRef,
  SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
  CredentialsApi, CredentialView, ConfigurableProviderView, DiscoveredModelView, LlmApi,
} from './api.ts'
export {
  RpcId,
  AbstractApiClient,
  transportError,
} from './api.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
export type { ConnectionConfig, ConnectionSinks, ConnectionState }
export type { ClientConnectionRpc } from '../rpc.ts'

/** Observable Host description published by each completed connection handshake. */
export interface HostDescriptionSource {
  /** Latest connected-generation description; absent before connect and while reconnecting. */
  getSnapshot(): HostDescription | undefined
  /** Subscribe to description replacement and connection loss. */
  subscribe(listener: () => void): () => void
}

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * The ctx.connection service API: the API client plus a one-shot
 * controller starter (the runtime plugin supplies sinks when its object layer
 * is ready — connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Shared api client (fixture or real, decided at boot from the page URL). */
  readonly api: IApiClient
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /** Generation-scoped Host facts, including native path-open capability. */
  readonly hostDescription: HostDescriptionSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

/**
 * Subscribe the browser's network-change signals to a recycle callback.
 * `online` fires when connectivity is regained, and the Network Information
 * API's `change` fires when the effective connection type changes (e.g.
 * cellular <-> WiFi) even without an offline gap; Safari implements neither
 * NIA nor a switch gap signal, which is the idle watchdog's case.
 * @param onChange - callback invoked on each network-change signal.
 * @returns disposer removing every listener.
 */
function attachNetworkChangeListeners(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  window.addEventListener('online', onChange)
  // NetworkInformation is a Chrome-family API: TS lib.dom declares the type
  // but not the Navigator.connection member, so the access is narrowed to the
  // minimal event-target surface this plugin uses.
  const connection = (navigator as Navigator & {
    connection?: EventTarget & { addEventListener: typeof EventTarget.prototype.addEventListener }
  }).connection
  connection?.addEventListener('change', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    connection?.removeEventListener('change', onChange)
  }
}

/**
 * Client plugin body: pick the api by page mode and provide ctx.connection.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  const api: IApiClient = fixtureClient ?? new WebApiClient()
  const isLoopback = pageLocation === undefined || isLoopbackHostname(pageLocation.hostname)
  const rpc = fixtureClient?.rpc ?? createWebConnectionRpc()
  let started = false
  let description: HostDescription | undefined
  const descriptionListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] host-description listener threw:', error)
      }
    }
  }
  const handle: ConnectionHandle = {
    api,
    isLoopback,
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    rpc,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      // Loopback pages keep the idle watchdog off by default: their sockets do
      // not cross a device or network boundary, so a silently dead transport is
      // not a failure mode there and the watchdog would only churn. Remote
      // (tunnel) and LAN pages get the default deadline; an explicit
      // idleTimeoutMs always wins.
      const resolvedConfig: ConnectionConfig = {
        ...(isLoopback ? { idleTimeoutMs: 0 } : {}),
        ...config ?? {},
      }
      const controller = new ConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
          publishDescription(next)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') publishDescription(undefined)
          sinks.onStateChange?.(state)
        },
      }, resolvedConfig)
      controller.start()
      // Network-change fast path: a mobile-data <-> WiFi switch tears the
      // browser's sockets silently, so the platform signals are the earliest
      // reliable hint; recycle() drops the stale generation and the loop
      // reconnects on the new interface. The idle watchdog covers platforms
      // that fire neither signal (Safari has no Network Information API).
      const disposeNetworkListeners = attachNetworkChangeListeners(() => { controller.recycle() })
      return {
        stop: () => {
          disposeNetworkListeners()
          controller.stop()
          publishDescription(undefined)
        },
      }
    },
  }
  ctx.provide('connection', handle)
}
