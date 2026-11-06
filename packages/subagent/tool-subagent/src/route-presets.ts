/**
 * Saved combinations of the crew role routes.
 *
 * A deployment composes one route namespace per delegation role, so switching
 * "which models the formation runs on" would otherwise mean editing three rows
 * by hand. This row stores those triples as named combinations; the Models page
 * writes them and applies one by writing each role's own route namespace.
 *
 * The row owns no service and no runtime behavior: it exists so the Host serves
 * a settings namespace for the combinations, exactly as each route row does for
 * its own route. It lives in the crew bundle, so a deployment without the crew
 * presets serves no such namespace and the Models page shows no picker.
 * @module @deepseek-ai/dsh-tool-subagent/route-presets
 */

import z from '@deepseek-ai/schemastery'

/** Plugin identity; the row is a settings owner with no runtime API. */
export const name = 'subagent-route-presets'

/**
 * Stored combinations, each a named list of role routes. Every field is
 * required, so a partial combination never reaches the page: a route the Host
 * cannot act on would only fail after the user picked it.
 *
 * The shipped list is empty on purpose. Which combinations a deployment wants
 * is a user choice, and a preset the catalog cannot serve would fail when
 * applied rather than when it is declared.
 */
export const Config = z.object({
  presets: z.array(z.object({
    /** Stable identity the page looks a combination up by; never parsed. */
    id: z.string().min(1).required(),
    /** Name shown in the combination picker. */
    name: z.string().min(1).required(),
    /** One entry per role the combination covers. */
    routes: z.array(z.object({
      /** Settings namespace of the role this route drives. */
      namespace: z.string().min(1).required(),
      /** Registered LLM provider id for that role. */
      provider: z.string().min(1).required(),
      /** Provider-owned exact model id for that role. */
      model: z.string().min(1).required(),
      /** Adapter-owned reasoning effort for that role. */
      reasoningEffort: z.string().min(1).required(),
    })).default([]),
  })).default([]).volatile(),
})

/** Mount the settings namespace; the row carries no runtime behavior. */
export function apply(): void {}
