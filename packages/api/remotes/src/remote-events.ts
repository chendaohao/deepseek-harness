/**
 * The one home of this application's forwarded-Host-event allowlist. Both
 * compiler faces list this file, so the Host forwarding loop and the consumer
 * `ctx.remote.$on` key face read one declaration instead of two copies that
 * could drift; `./types.ts` derives the type projection from it and stays
 * type-only.
 */

import type {} from '@deepseek-ai/dsh-api-session-controller/remote-events'
import type {} from '@deepseek-ai/dsh-permission-presets/types'
import type {} from '@deepseek-ai/dsh-plugin-manager/types'
import type { TypertForwardableEventEntry } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: pull the remote-access/tunnel Events merges into both faces, so
// the forwarded-event list below (and every `ctx.remote.$on` key face) sees
// the `remote/*` and `remote-tunnel/*` vocabulary it names.
import type {} from '@deepseek-ai/dsh-remote-access/types'
import type {} from '@deepseek-ai/dsh-remote-tunnel/types'

/**
 * Host events this application forwards without renaming. The explicit mode is
 * both the Host dispatch strategy and the legal key set of `ctx.remote.$on`.
 */
export const API_REMOTE_FORWARDED_EVENTS = [
  { event: 'agent-preset/selected', mode: 'emit' },
  { event: 'approval/request', mode: 'waterfall' },
  { event: 'api-session/activity', mode: 'emit' },
  { event: 'api-session/added', mode: 'emit' },
  { event: 'api-session/error', mode: 'emit' },
  { event: 'api-session/removed', mode: 'emit' },
  { event: 'api-session/status', mode: 'emit' },
  { event: 'commands/change', mode: 'emit' },
  { event: 'credentials/reference-updated', mode: 'emit' },
  { event: 'goal/activation-changed', mode: 'emit' },
  { event: 'cordis/request-run', mode: 'emit' },
  { event: 'cordis/request-run-resolved', mode: 'emit' },
  { event: 'cordis/dynamic-package', mode: 'emit' },
  { event: 'cordis/dynamic-retract', mode: 'emit' },
  { event: 'cordis/inspect-query', mode: 'emit' },
  { event: 'cordis/inspect-query-resolved', mode: 'emit' },
  { event: 'llm/adapters-updated', mode: 'emit' },
  { event: 'permission-presets/catalog-changed', mode: 'emit' },
  { event: 'plugin-manager/changed', mode: 'emit' },
  { event: 'plugin-manager/install-log', mode: 'emit' },
  { event: 'plugin-manager/install-state', mode: 'emit' },
  { event: 'remote/devices/change', mode: 'emit' },
  { event: 'remote-tunnel/state', mode: 'emit' },
  { event: 'settings/document-updated', mode: 'emit' },
  { event: 'user-questions/request', mode: 'waterfall' },
] as const satisfies readonly TypertForwardableEventEntry[]
