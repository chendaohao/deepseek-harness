/**
 * Preset-scoped mask over the host's global tool catalog.
 *
 * A preset can only ADD rows: its own registrations shadow same-named globals,
 * and nothing in the preset removes a global tool a role must not have. A
 * reviewer preset therefore carries the host's `write`, `edit`, MCP filesystem
 * editors, and every deployment-specific tool alongside the two tools it wants,
 * and its persona has to ask the model to ignore them. This plugin closes that
 * gap: mounted inside a preset, it restricts the preset scope's view of the
 * global catalog to the names the preset declares, and every Agent composed
 * under that preset inherits the restriction through the scope chain.
 *
 * The mask is derived, not enumerated: the allow list is expanded against the
 * global catalog at mount, so a deployment mounting extra plugins gets them
 * masked without editing the preset. `tools/change` re-expands it, so a tool
 * that arrives later (an MCP server connecting after the preset mounted) is
 * masked too rather than leaking in.
 * @module @deepseek-ai/dsh-preset-tool-mask
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scopeOf } from '@deepseek-ai/dsh-scope'
// Type-only: pulls the tool registry's Context and event merges so this plugin
// resolves `ctx.tools` and `tools/change` without a runtime dependency.
import type {} from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'preset-tool-mask'

/** The tool registry whose per-scope restriction this plugin applies. */
export const inject = ['tools']

/**
 * Plugin configuration. Every field is a deployment choice and is validated at
 * load: an empty string, an allow/deny overlap, or an unmounted preset scope
 * throws instead of degrading to an unmasked role.
 */
export interface Config {
  /**
   * Exact global tool names this preset keeps. A name the deployment does not
   * register is reported once and ignored, so one shipped preset still mounts
   * in a deployment that lacks an optional plugin.
   */
  allow?: string[]
  /**
   * Global tool-name prefixes this preset keeps, for families whose members
   * differ per deployment (`mcp__codegraph__`, `squads_`). A prefix is not
   * validated against the current catalog for the same reason.
   */
  allowPrefixes?: string[]
  /**
   * Exact global tool names this preset drops. A name that `allow` also keeps
   * is dropped: the deny list exists for the case where an `allowPrefixes`
   * family must lose one member.
   */
  deny?: string[]
  /** Global tool-name prefixes this preset drops, after the allow lists. */
  denyPrefixes?: string[]
}

export const Config: z<Config> = z.object({
  allow: z.array(z.string()).default([]),
  allowPrefixes: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  denyPrefixes: z.array(z.string()).default([]),
})

/**
 * Decide which global tool names the mask hides.
 * @param globalNames - every name the global catalog currently holds.
 * @param config - the preset's mask declaration.
 * @returns the names to hide, in catalog order.
 */
function deniedNames(globalNames: readonly string[], config: Config): string[] {
  const allow = new Set(config.allow ?? [])
  const deny = new Set(config.deny ?? [])
  const keepPrefixes = config.allowPrefixes ?? []
  const dropPrefixes = config.denyPrefixes ?? []
  return globalNames.filter((tool) => {
    if (deny.has(tool) || dropPrefixes.some(prefix => tool.startsWith(prefix))) return true
    return !(allow.has(tool) || keepPrefixes.some(prefix => tool.startsWith(prefix)))
  })
}

/**
 * Fail loud on a declaration that cannot mean what it says, before any mask is
 * applied. An empty entry matches or keeps nothing and silently widens the
 * mask; overlapping prefix lists have no stable precedence between them.
 * @param config - the preset's mask declaration.
 * @throws {Error} When a list entry is empty or two prefix lists overlap.
 */
function assertCoherent(config: Config): void {
  for (const field of ['allow', 'allowPrefixes', 'deny', 'denyPrefixes'] as const) {
    for (const entry of config[field] ?? []) {
      if (entry.length === 0) throw new Error(`preset-tool-mask: ${field} must not contain an empty string`)
    }
  }
  const keepPrefixes = config.allowPrefixes ?? []
  for (const prefix of config.denyPrefixes ?? []) {
    if (keepPrefixes.some(kept => kept.startsWith(prefix) || prefix.startsWith(kept))) {
      throw new Error(`preset-tool-mask: denyPrefix ${JSON.stringify(prefix)} overlaps an allowPrefix`)
    }
  }
}

/**
 * Apply the mask to the calling preset scope.
 *
 * The restriction is append-only and lives as long as the mounted preset fiber,
 * so every Agent created under this preset sees the narrowed catalog while the
 * host's own agents keep the full one.
 * @param ctx - the preset scope this row is mounted into.
 * @param config - the preset's mask declaration.
 * @throws {Error} When mounted outside a preset scope, or on an incoherent declaration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (scopeOf(ctx) === undefined) {
    throw new Error('preset-tool-mask: mount inside an Agent Preset; a context-global mask would hide the tool from every Agent')
  }
  const resolved = {
    allow: config.allow ?? [],
    allowPrefixes: config.allowPrefixes ?? [],
    deny: config.deny ?? [],
    denyPrefixes: config.denyPrefixes ?? [],
  }
  assertCoherent(resolved)

  const globalNames = (): string[] => ctx.tools.definitions().map(row => row.name)
  const reported = new Set<string>()
  let disposeMask: (() => void) | undefined
  let applied: string | undefined
  // restrict() and its disposal both emit tools/change; without this guard the
  // refresh below re-enters itself.
  let applying = false
  let stopped = false

  const refresh = (): void => {
    if (applying || stopped) return
    applying = true
    try {
      const names = globalNames()
      const missing = resolved.allow.filter((tool) => {
        return !names.includes(tool)
      })
      for (const tool of missing) {
        if (reported.has(tool)) continue
        reported.add(tool)
        ctx.logger.warn(`preset-tool-mask: allow names "${tool}", which this deployment does not register; ignoring it`)
      }
      const denied = deniedNames(names, resolved)
      const signature = denied.join('\u0000')
      if (signature === applied) return
      disposeMask?.()
      disposeMask = undefined
      applied = signature
      if (denied.length === 0) return
      disposeMask = ctx.tools.restrict({ deny: denied })
    } finally {
      applying = false
    }
  }

  refresh()
  ctx.on('tools/change', refresh)
  ctx.effect(() => () => {
    // Tear down before lifting the mask: disposal emits tools/change, and a
    // live refresh would re-apply the restriction to a preset being unmounted.
    stopped = true
    disposeMask?.()
    disposeMask = undefined
  }, 'preset-tool-mask.effect')
}
