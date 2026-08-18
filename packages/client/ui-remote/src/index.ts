/**
 * Host loader entry for `@deepseek-ai/dsh-client-ui-remote`. When enabled (the
 * shipped bundle row derives it from the `--remote` flag), the node half serves
 * the standalone mobile surface at `/m`: the document shell at `/m` and the
 * self-contained bundle at `/m/mobile.js`, read from this package's `lib/`.
 * The page shares the platform `/api` transport (unary RPC + the events.mux
 * WebSocket) with the desktop UI, so the paired-device cookie authenticates it
 * with no additional channel.
 */

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: resolves the `webServer` Context merge behind the route registrations.
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Plugin config: activation gate for the /m surface. */
export interface Config {
  /** Serve the /m mobile page; false leaves the node half inert. */
  enabled: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
})

/** Required services: the host webserver owns the /m routes. */
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

/**
 * Register the /m routes as effects (disposed with the owning fiber) only when
 * the surface is enabled.
 * @param ctx - host context with the webserver service injected.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/m', handler: serveMobileHtml }),
    'ui-remote: /m',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/m/mobile.js', handler: serveMobileJs }),
    'ui-remote: /m/mobile.js',
  )
}
