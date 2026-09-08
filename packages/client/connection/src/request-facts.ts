/**
 * Per-request facts for the /api transport, propagated through
 * {@link https://nodejs.org/api/async_context.html|AsyncLocalStorage} so a
 * deep in-process callee (a Remote namespace owner) can observe how the
 * current request arrived without threading a parameter through every seam.
 * In-process facts only, never a trust decision by themselves: the /api fence
 * stays the authority for whether a request is served at all.
 * @module @deepseek-ai/dsh-client-connection/request-facts
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Facts observed by code running inside one /api request. Headers are
 * lower-cased, string-valued only (the fetch bridge already filters to
 * single-string values), so consumers index with a lower-case name.
 */
export interface RequestFacts {
  readonly headers: Readonly<Record<string, string>>
}

const storage = new AsyncLocalStorage<RequestFacts>()

/**
 * Run `fn` with `facts` installed as the current request's facts. Nested and
 * awaited calls observe them via {@link currentRequestFacts}; code entered
 * outside any {@link runWithRequestFacts} scope (a direct in-process caller)
 * observes none, which callers treat as the local, not-forwarded case.
 * @param facts - the request's facts.
 * @param fn - the request dispatch to run under those facts.
 * @returns whatever `fn` returns.
 */
export function runWithRequestFacts<T>(facts: RequestFacts, fn: () => T): T {
  return storage.run(facts, fn)
}

/**
 * The current request's facts, or `undefined` outside any request scope.
 * @returns the installed facts for this async chain.
 */
export function currentRequestFacts(): RequestFacts | undefined {
  return storage.getStore()
}

/**
 * Build the facts for one bridged node:http request: lower-cased,
 * single-string headers only.
 * @param req - the incoming request.
 * @returns the facts for {@link runWithRequestFacts}.
 */
export function factsFrom(req: { headers: IncomingHttpHeaders }): RequestFacts {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[name.toLowerCase()] = value
  }
  return { headers }
}

type IncomingHttpHeaders = import('node:http').IncomingHttpHeaders
