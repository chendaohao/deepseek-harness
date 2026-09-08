import { clientBundle } from '../tsdown.client.ts'
import type { UserConfig } from 'tsdown'

const SKIP_WORKSPACE_BUILD: UserConfig = { entry: '' }

/**
 * Package build face: the plugin halves during the Client pass; nothing during
 * the Host pass (the node lib emits in the Client pass, the same as every other
 * client package).
 */
export default (({ env }) => {
  if (env?.DSH_BUILD_FACE === 'host') return [SKIP_WORKSPACE_BUILD]
  return clientBundle('@deepseek-ai/dsh-client-ui-remote', ['lib/types/index.js'])({ env })
})
