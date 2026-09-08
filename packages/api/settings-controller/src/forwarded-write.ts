/**
 * The forwarded-write fence shared by the settings and credentials Remote
 * owners: how a request in flight is recognized as having arrived through the
 * remote-access proxy, and the failure vocabulary for refusing its writes.
 * @module @deepseek-ai/dsh-api-settings-controller/forwarded-write
 */

import { PROXIED_HEADER } from '@deepseek-ai/dsh-host-webserver'
import { currentRequestFacts } from '@deepseek-ai/dsh-client-connection'

/**
 * Whether the current request (per {@link currentRequestFacts}) arrived through
 * the remote-access proxy. No facts installed means a direct in-process caller
 * or an unforwarded HTTP request: the local desktop case, always allowed.
 */
export function isForwardedRequest(): boolean {
  const facts = currentRequestFacts()
  return facts !== undefined && facts.headers[PROXIED_HEADER] !== undefined
}
