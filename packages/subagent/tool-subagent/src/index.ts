/**
 * Model-facing delegation through one configured `ctx.subagents` provider.
 * Provider lifecycle controls tool registration and context-sensitive schema
 * wording. Every delegation starts a managed activation and returns its child
 * id; the subagent runtime owns result delivery and resource cleanup.
 * @module @deepseek-ai/dsh-tool-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  assertSubagentMaxDepth,
  delegationDepthOf,
  parentAgentOptionsForDelegation,
} from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
// Type-only: pulls the settings service's Context merge so the write guard this
// plugin registers resolves without a runtime dependency on the implementation.
import type {} from '@deepseek-ai/dsh-settings'
import {
  hasConfiguredLlmSelection,
  hasDelegationModelRequest,
  preflightChildLlmRoute,
  requestedAgentOptions,
  assertAllowedModelSelection,
} from './model-selection.ts'
import type { DelegationModelRequest } from './model-selection.ts'
import { registerListSubagentModels } from './list-models.ts'
import { SubagentPresetSelection, type PresetSelectionConfig, type PresetSelectionRequest } from './preset-selection.ts'
import type {} from './model-selection-settings.ts'
import type { SubagentRouteSettingsOwner, SubagentWorkerRouteSettings } from './worker-route-settings.ts'
import {
  recordSubagentWorkerRoute,
  subagentWorkerRouteMark,
  subagentWorkerRouteProjectionDefinition,
} from './worker-route-state.ts'
import {
  subagentModelSelectionProjectionDefinition,
  subagentModelSelectionPolicy,
} from './model-selection-state.ts'

export const name = 'tool-subagent'
export const inject = ['tools', 'subagents', 'systemPrompt', 'sessionProjections']

// Definition identity keeps shared guidance scoped to the actual visible tools,
// including scoped overrides and independently loaded tool registries.
const delegationTools = new Set<ToolDefinition>()

/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config extends PresetSelectionConfig {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string
  /**
   * Model-facing tool name (default `subagent`). Each loaded instance must use
   * a distinct name.
   */
  toolName?: string
  /**
   * Expose optional child `provider`, `model`, and `reasoning_effort` fields.
   * Requires provider `agentOptions` support. Execution enforces the Session
   * policy, or restricts explicit selection to the current parent route.
   */
  modelSelection?: boolean
  /**
   * Register the shared `list_subagent_models` tool for this scope.
   * Enable on only one instance per scope; defaults to false and does not
   * enable model selection. Discovery is removed when this instance unloads.
   */
  modelDiscovery?: boolean
  /**
   * Read the named Host route-settings namespace as this instance's baseline
   * child route on every call, so a settings update reaches the next
   * delegation without rebuilding the definition. Configured `agentOptions`
   * stays as the fallback beneath it. The namespace must be served by a
   * composed `subagent-*-route-settings` row (its entry id names the same
   * namespace); omit the field to keep a fixed configured route.
   */
  routeSettingsNamespace?: string | undefined
  /**
   * Agent options applied to every child; omitted fields use child-loop defaults.
   */
  agentOptions?: AgentOptions
  /**
   * Maximum child depth: a non-negative safe integer (`0` forbids delegation),
   * or `'provider-managed'` to send no cap. A numeric cap
   * requires the provider's `depthLimit` capability (mount fails loud
   * otherwise). The provider checks the calling agent's current depth at every
   * start; the tool remains model-visible so runtime policy owns rejection.
   * `'provider-managed'` is for an out-of-process provider whose recursion
   * budget belongs to the child runtime or its own deployment. Omission reads
   * the current Host subagent depth setting (default `1`) at each delegation.
   */
  maxDepth?: number | 'provider-managed'
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  modelSelection: z.boolean().default(false),
  modelDiscovery: z.boolean().default(false),
  routeSettingsNamespace: (z.string().min(1) as z<string | undefined>).default(undefined),
  // Prevent Schemastery from materializing omitted agentOptions as `{}`.
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId> | undefined>,
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as {
    provider: string
    model: string
    reasoningEffort: ReturnType<typeof ReasoningEffortId>
    maxTokens: number
  }),
  agentPreset: z.string().min(1),
  allowedAgentPresets: (z.array(z.string().min(1)).min(1) as z<string[] | undefined>).default(undefined),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]),
})

/**
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns — telling the model to restate everything
 * (or, worse, that the child "does not see this conversation") would be false
 * for a fork.
 * @param inheritsConversation - whether the child's conversation is seeded
 *   with the parent's completed turns; this says nothing about tool, service,
 *   scope, or authority inheritance.
 * @returns the tool `description` and the `prompt` parameter description.
 */
function providerWording(inheritsConversation: boolean): { description: string; promptDescription: string } {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
        + 'builds on this conversation\'s context — a follow-up analysis, '
        + 'a review, a continuation — without consuming this conversation\'s context for the work itself. '
        + 'You receive its result, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'to offload focused, independent work — research, a scoped '
      + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
      + 'returns its result, not its intermediate steps.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this '
      + 'conversation\'s context, so include everything it needs.',
  }
}

/**
 * Agents already carrying a worker-route selection installation. A parent can
 * mount several delegation rows with `routeSettingsNamespace`, and each
 * row's `agent/created` listener would install its own copy — two
 * installations would both append the model-change notice to the child's
 * transcript. The dedupe key is the Agent itself, so the set is shared across
 * rows; keyed weakly, a disposed Agent's entry dies with it.
 */
const workerRouteSelectionInstalled = new WeakSet<Agent>()

/**
 * Install one delegation-tool composition.
 * The owning composition shares its registrations across Agents; child startup resolves the selected preset.
 * @param ctx - Context that owns the registrations.
 * @param config - delegation-tool configuration.
 * @returns when the plugin is ready.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  for (const field of ['persona', 'toolFilter']) {
    if (Object.hasOwn(config, field)) {
      throw new Error(`tool-subagent: ${field} is no longer supported; configure persona and tool plugins in an Agent Preset and select it with agentPreset (spawn only)`)
    }
  }
  const presets = new SubagentPresetSelection(config)
  if (presets.configured && ctx.get('agentPresets') === undefined) {
    throw new Error('tool-subagent: agent preset selection requires the agent-presets service')
  }
  // Direct apply() bypasses Schemastery's numeric constraints. A direct-apply
  // omission stays capless (the schema default only runs through the loader).
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  const toolName = config.toolName ?? 'subagent'

  const modelSelectionEnabled = config.modelSelection === true
  const subagentModelSelectionProjectionHandle = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
  // Awaiting registers the marker before any child is announced to this row.
  await ctx.sessionProjections.register(subagentWorkerRouteProjectionDefinition)

  // Resolve the row's route owner through the shared registry, so several
  // role rows can compose side by side without fighting over one service name.
  const registry = config.routeSettingsNamespace === undefined
    ? undefined
    : ctx.get('subagentRouteSettings')
  const workerRouteConfig = config.routeSettingsNamespace === undefined || registry === undefined
    ? undefined
    : registry.resolve(config.routeSettingsNamespace)
  if (config.routeSettingsNamespace !== undefined && workerRouteConfig === undefined) {
    throw new Error(
      `tool-subagent: \`routeSettingsNamespace: '${config.routeSettingsNamespace}'\` requires a `
      + 'route-settings row serving that namespace (its entry id must name it)',
    )
  }
  // Bound rather than captured: the service instance reads through its own
  // settings source, so each call observes the current stored route.
  const workerRoute = workerRouteConfig === undefined
    ? undefined
    : (): SubagentWorkerRouteSettings => workerRouteConfig.current()

  /**
   * Route one marked child's later requests from the current setting. The route
   * is recorded through the Agent's own model API, so request routing and the
   * durable log agree and the switch notice comes from the same installation.
   * One Agent takes one installation: within a row, a fresh child's marker lands
   * after its creation dispatch already ran and a resumed Agent is announced
   * once; across rows, the module-level installation set decides, because two
   * opted-in rows each announce the same resumed child.
   */
  const installWorkerRouteSelection = (routeConfig: SubagentRouteSettingsOwner, child: Agent): void => {
    // The marker must name THIS row's namespace: without the match a row whose
    // listener runs first would route a planner or reviewer child to the worker
    // route. The weak set below only dedupes repeated announcements of the
    // same child to this row.
    if (subagentWorkerRouteMark(ctx.sessionProjections, child.session) !== config.routeSettingsNamespace) return
    if (workerRouteSelectionInstalled.has(child)) return
    workerRouteSelectionInstalled.add(child)
    child.ctx.effect(() => installModelSelection(child.ctx), 'tool-subagent: worker-route selection')
    /**
     * Record the stored route on the child, leaving an already-matching
     * selection alone: a no-op select would still append a durable
     * `model/selection` to every worker log.
     */
    const applyRoute = (): void => {
      const route = routeConfig.current()
      const current = child.model.current()
      if (current !== undefined
        && current.provider === route.provider
        && current.model === route.model
        && current.reasoningEffort === route.reasoningEffort) return
      child.model.select({
        provider: route.provider,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
      })
    }
    // A step captures its selection before `agent/pre-step` listeners run, so a
    // wake is the last point where the current setting still reaches the step
    // about to start.
    child.ctx.on('agent/status', ({ status }) => {
      if (status === 'running') applyRoute()
    })
    applyRoute()
  }
  if (workerRouteConfig !== undefined) {
    const routeConfig = workerRouteConfig
    // A cold resume re-creates the child from its log, so the marker it already
    // carries is what selects it here; this serial dispatch precedes its prompt.
    ctx.on('agent/created', ({ agent }) => { installWorkerRouteSelection(routeConfig, agent) })
  }

  const assertSubagentProviderConfiguration = (subagentProvider: SubagentProvider): void => {
    presets.assertProvider(subagentProvider)
    if (ctx.subagents.resolveMaxDepth(config.maxDepth) !== undefined && !subagentProvider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" cannot enforce maxDepth (no depthLimit capability) — `
        + 'set maxDepth: \'provider-managed\' to leave the recursion budget to the provider',
      )
    }
    if (config.agentOptions !== undefined && !subagentProvider.capabilities.agentOptions) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support child agentOptions`,
      )
    }
    if (modelSelectionEnabled && !subagentProvider.capabilities.agentOptions) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support child model selection`,
      )
    }
  }

  // Validate provider-owned config outside the optional LLM binding so an
  // invalid provider always rejects its registration or this plugin's load.
  ctx.on('subagent/provider-added', (subagentProvider) => {
    if (subagentProvider.name === config.provider) assertSubagentProviderConfiguration(subagentProvider)
  })
  const initialProvider = ctx.subagents.getProvider(config.provider)
  if (initialProvider !== undefined) assertSubagentProviderConfiguration(initialProvider)

  if (config.modelDiscovery === true) registerListSubagentModels(ctx, subagentModelSelectionProjectionHandle)

  // Load order and HMR replacement can change provider availability while
  // this fiber remains active.
  let mounted: { subagentProvider: SubagentProvider; definition: ToolDefinition; disposeTool: () => void } | undefined
  const mount = (subagentProvider: SubagentProvider): void => {
    assertSubagentProviderConfiguration(subagentProvider)
    const wording = providerWording(subagentProvider.inheritsParentContext)
    const providerRouteDefaults = subagentProvider.agentRouteDefaults
    const selectionDescription = providerRouteDefaults !== undefined
      ? ' Supply `provider` and `model` together. Omitted values use child defaults, falling back to this backend\'s route defaults. When the effective route changes, an omitted `reasoning_effort` uses the model\'s default.'
      : ' Supply `provider` and `model` together. Omitted values use child defaults, falling back to compatible parent values. When the effective route changes, an omitted `reasoning_effort` uses the model\'s default.'
    const definition = defineTool({
      name: toolName,
      description: wording.description
        + ' This tool starts an independently managed subagent and immediately returns its id. The runtime notifies you when it finishes.'
        + (subagentProvider.prepareContinuable !== undefined
          ? ' The child reports results with `send_message`; use `send_message` to steer it while running or continue its conversation after it finishes.'
          : ' The completion notice includes its final answer. This backend does not accept follow-up messages.')
        + (modelSelectionEnabled ? selectionDescription : '')
        + (modelSelectionEnabled && subagentProvider.inheritsParentContext
          ? ' Changing the route can prevent provider-side reuse of the inherited conversation prefix.'
          : ''),
      parameters: {
        cwd: {
          type: 'string',
          description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it. Later directory changes in either agent are independent.',
        },
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: wording.promptDescription,
        },
        ...presets.choices === undefined ? {} : {
          agent_preset: {
            type: 'string' as const,
            enum: [...presets.choices],
            description: presets.description,
          },
        },
        ...modelSelectionEnabled ? {
          provider: {
            type: 'string' as const,
            description: 'Child LLM provider id.',
          },
          model: {
            type: 'string' as const,
            description: 'Model id within that provider.',
          },
          reasoning_effort: {
            type: 'string' as const,
            description: 'Model-specific reasoning effort id.',
          },
        } : {},
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'activation' },
            subagentId: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) {
          // Non-agent callers provide no parent for delegation ownership.
          throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
        }

        const routes = subagentModelSelectionPolicy(subagentModelSelectionProjectionHandle, parent.session)
        const modelSelectionPolicy = routes === undefined ? undefined : { routes }
        const agentPreset = presets.resolve(args as PresetSelectionRequest)
        const modelRequest = args as DelegationModelRequest
        const parentOptions = parentAgentOptionsForDelegation(parent)
        // Read per call, never captured at apply: a settings write reaches the
        // next delegation in this process without rebuilding the definition.
        const settingsRoute = workerRoute?.()
        const settingsAgentOptions = settingsRoute === undefined
          ? undefined
          : {
            provider: settingsRoute.provider,
            model: settingsRoute.model,
            reasoningEffort: settingsRoute.reasoningEffort,
          }
        const requiresRoutePreflight = hasDelegationModelRequest(modelRequest)
            || hasConfiguredLlmSelection(config.agentOptions)
            || settingsAgentOptions !== undefined
        const configuredChildAgentOptions = requiresRoutePreflight
          ? {
            ...providerRouteDefaults,
            ...config.agentOptions,
            // The user's stored route outranks the composition defaults; the
            // model's per-call fields below still outrank it.
            ...settingsAgentOptions,
          }
          : config.agentOptions
        const requestedChildAgentOptions = requestedAgentOptions(
          parentOptions,
          configuredChildAgentOptions,
          modelRequest,
          modelSelectionEnabled,
        )
        assertAllowedModelSelection(
          modelSelectionPolicy,
          parentOptions,
          requestedChildAgentOptions,
          modelRequest,
        )
        // The setting owns this child's route unless the call named one: an
        // explicit per-call route or effort keeps the route it created.
        const followsWorkerRoute = settingsRoute !== undefined
            && !hasDelegationModelRequest(modelRequest)
        if (requiresRoutePreflight) {
          const llm = ctx.get('llm')
          if (llm === undefined) {
            throw new Error('cannot resolve the selected child LLM route because the `llm` service is unavailable')
          }
          await preflightChildLlmRoute(
            llm,
            parentOptions,
            requestedChildAgentOptions,
            exec.signal,
            providerRouteDefaults === undefined,
          )
          if (ctx.subagents.getProvider(config.provider) !== subagentProvider) {
            throw new Error(`subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`)
          }
        }
        exec.signal.throwIfAborted()
        const maxDepth = ctx.subagents.resolveMaxDepth(config.maxDepth)
        const request = {
          ...args.cwd === undefined ? {} : { cwd: args.cwd },
          prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
          parent,
          ...agentPreset === undefined ? {} : { agentPreset },
          ...requestedChildAgentOptions !== undefined ? { agentOptions: requestedChildAgentOptions } : {},
          ...maxDepth !== undefined ? { maxDepth } : {},
        }

        const started = await ctx.subagents.startActivation({
          provider: config.provider,
          label: args.description,
          request,
          signal: exec.signal,
          delivery: 'parent',
        })
        if (followsWorkerRoute && workerRouteConfig !== undefined && config.routeSettingsNamespace !== undefined) {
          // The marker is durable so a cold resume reinstalls from it; this
          // live install is what makes the child's NEXT request observe the
          // current setting without waiting for a restart.
          /* v8 ignore next -- a composition without the Agent registry has no local child to route */
          const child = ctx.get('agents')?.get(started.childId)
          if (child !== undefined) {
            recordSubagentWorkerRoute(ctx.sessionProjections, child.session, config.routeSettingsNamespace)
            installWorkerRouteSelection(workerRouteConfig, child)
          }
        }
        return { kind: 'activation' as const, subagentId: started.childId }
      },
    })
    const disposeTool = ctx.effect(() => {
      const unregister = ctx.tools.register(definition)
      delegationTools.add(definition)
      return () => {
        delegationTools.delete(definition)
        unregister()
      }
    })
    // oxlint-disable-next-line typescript/no-misused-promises -- Tool and guidance disposal are synchronous.
    mounted = { subagentProvider, definition, disposeTool }
  }

  // Register listeners before checking presence so no synchronous change is missed.
  ctx.on('subagent/provider-added', (subagentProvider) => {
    if (subagentProvider.name === config.provider && mounted === undefined) mount(subagentProvider)
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name !== config.provider || mounted === undefined) return
    mounted.disposeTool()
    mounted = undefined
  })
  const present = ctx.subagents.getProvider(config.provider)
  if (present !== undefined) {
    mount(present)
  } else {
    // A backend fiber may activate later; a misspelled provider remains visible in this log.
    ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? 'subagent'}" tool will register when it appears`)
  }
  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: (context) => {
      if (mounted === undefined) return ''
      const visible = [...delegationTools]
        .filter(tool => ctx.tools.get(tool.name, context.scope) === tool)
        .map(tool => tool.name)
        .sort()
      if (visible[0] !== toolName) return ''
      const names = visible.map(name => `\`${name}\``).join(' or ')
      return `Start independent delegations with ${names} together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.`
    },
  })
  ctx.systemPrompt.context({
    name: `tool:${toolName}:depth`,
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    text: (context) => {
      if (context.agent === undefined || mounted === undefined
        || ctx.tools.get(toolName, context.scope) !== mounted.definition) return ''
      const maxDepth = ctx.subagents.resolveMaxDepth(config.maxDepth)
      if (maxDepth === undefined) return ''
      const depth = delegationDepthOf(context.agent)
      if (depth < maxDepth) return ''
      return `Delegation depth for \`${toolName}\`: current ${depth}, maximum ${maxDepth}, remaining levels 0.`
        + ` Do not call \`${toolName}\` at this depth; carry out the work directly.`
    },
  })
}
