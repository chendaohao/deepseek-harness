/**
 * Host loader entry for `@deepseek-ai/dsh-client-ui-remote`. When enabled (the
 * shipped bundle row derives it from the `--remote` flag), the node half serves
 * the standalone mobile surface at `/m`: the document shell at `/m` and the
 * self-contained bundle at `/m/mobile.js`, read from this package's `lib/`.
 * The page shares the platform `/api` transport (unary RPC + the remote.mux
 * stream WebSocket) with the desktop UI. The `/m` routes sit behind the same
 * browser-auth fence as `/api`: `connection.requestRejection` checks the
 * authority-bound cookie, so a mobile page reaching the webserver without the
 * fence cookie (or a paired-tunnel cookie from the proxy gate) is refused.
 */

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: resolves the `webServer` Context merge behind the route registrations.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'

/** Plugin config: activation gate for the /m surface. */
export interface Config {
  /** Serve the /m mobile page; false leaves the node half inert. */
  enabled: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
})

/** Required services: the host webserver owns the /m routes; the connection fence is optional. */
export const inject = ['webServer']

/** The mobile bundle artifact, resolved against this module's package lib. */
const mobileJsUrl = new URL('../lib/mobile.js', import.meta.url)

/** Document shell for the /m page; the standalone bundle boots its own tree. */
const MOBILE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f3f5f9">
<title>移动端远程控制</title>
</head>
<body>
<script type="module" src="/m/mobile.js"></script>
</body>
</html>
`

function serveMobileHtml(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(MOBILE_HTML)
}

async function serveMobileJs(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const code = await readFile(mobileJsUrl, 'utf8')
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(code)
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('mobile bundle missing; run pnpm --filter @deepseek-ai/dsh-client-ui-remote run bundle')
  }
}

/** Whether the request carries a valid browser-session cookie. */
type Fence = { requestRejection(request: ConnectionTrustRequest): 401 | 403 | undefined }

/**
 * Register the /m routes as effects (disposed with the owning fiber) only when
 * the surface is enabled. Both routes sit behind the browser-auth fence: the
 * host connection service rejects requests whose Host/Origin fence or cookie
 * check fails, mirroring the /api route's gate.
 * @param ctx - host context with the webserver and connection services injected.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const fence = ctx.get('connection') as Fence | undefined
  const gate = (handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) =>
    (req: IncomingMessage, res: ServerResponse): void | Promise<void> => {
      const rejection = fence?.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      return handler(req, res)
    }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/m', handler: gate(serveMobileHtml) }),
    'ui-remote: /m',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/m/mobile.js', handler: gate(serveMobileJs) }),
    'ui-remote: /m/mobile.js',
  )
}
