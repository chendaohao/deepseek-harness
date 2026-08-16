/**
 * Shared test fixtures: a local stub HTTP server serving canned OpenCode Go
 * responses, plus representative dashboard HTML samples. The network boundary
 * is the only mocked surface; query parsing runs the shipping code.
 */

import type { Server } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/** The canonical usage API response the real endpoint returns. */
export const USAGE_API_FIXTURE = {
  usage: {
    rolling: { status: 'ok', percent: 6, resetsAt: '2026-08-16T04:06:35.215Z' },
    weekly: { status: 'ok', percent: 67, resetsAt: '2026-08-17T00:00:00.215Z' },
    monthly: { status: 'ok', percent: 59, resetsAt: '2026-08-22T10:15:52.215Z' },
  },
}

/** SolidJS SSR hydration payload (percent-first field order). */
export const SSR_HTML_FIXTURE = `
<!doctype html><html><body>
<script>window._\$HY||(e=>{})</script>
<div>rollingUsage:\$R[12]={usagePercent:6,resetInSec:5195}</div>
<div>weeklyUsage:\$R[13]={usagePercent:67,resetInSec:23400}</div>
<div>monthlyUsage:\$R[14]={usagePercent:59,resetInSec:528300}</div>
</body></html>`

/** The same payload with the reset-first field order. */
export const SSR_RESET_FIRST_HTML_FIXTURE = `
<html><body>
<div>rollingUsage:\$R[1]={resetInSec:5195,usagePercent:6}</div>
<div>weeklyUsage:\$R[2]={resetInSec:23400,usagePercent:67}</div>
<div>monthlyUsage:\$R[3]={resetInSec:528300,usagePercent:59}</div>
</body></html>`

/** The newer data-slot HTML format (fallback parser target). */
export const DATA_SLOT_HTML_FIXTURE = `
<html><body>
<div data-slot="usage-item">
  <div data-slot="usage-label">Rolling Usage</div>
  <div data-slot="usage-value">6%</div>
  <span data-slot="reset-time">Resets in 1 hour 26 minutes</span>
</div>
<div data-slot="usage-item">
  <div data-slot="usage-label">Weekly Usage</div>
  <div data-slot="usage-value">67%</div>
  <span data-slot="reset-time">6 days 2 hours</span>
</div>
<div data-slot="usage-item">
  <div data-slot="usage-label">Monthly Usage</div>
  <div data-slot="usage-value">59%</div>
  <span data-slot="reset-now">Resets now</span>
</div>
</body></html>`

/** HTML carrying none of the known usage markers. */
export const UNPARSEABLE_HTML_FIXTURE = '<html><body><h1>Sign in</h1></body></html>'

/** A stub server recording the last request and replying per route. */
export class StubServer {
  readonly server: Server
  lastRequest: { method: string; url: string; headers: Record<string, string | string[] | undefined> } | null = null

  constructor(
    respond: (
      url: string,
      request: { method: string; headers: Record<string, string | string[] | undefined> },
    ) => { status: number; body: string; delayMs?: number },
  ) {
    this.server = createServer((request, response) => {
      this.lastRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
      }
      const outcome = respond(this.lastRequest.url, this.lastRequest)
      const send = (): void => {
        response.writeHead(outcome.status, { 'Content-Type': 'application/json' })
        response.end(outcome.body)
      }
      if (outcome.delayMs) setTimeout(send, outcome.delayMs)
      else send()
    })
  }

  async start(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }
}
