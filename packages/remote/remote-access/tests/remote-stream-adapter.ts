/**
 * Private integration adapter for the remote-stream transport diagnostic.
 *
 * Neither measured entry is a public export: `RemoteStreamMuxServer` is absent
 * from `@deepseek-ai/dsh-api-gateway`'s entry, and `createRemoteProxy` is absent
 * from `@deepseek-ai/dsh-remote-access`'s entry and from every `exports` subpath.
 * Re-exporting the source modules keeps the measurement on production code
 * without adding a package surface that exists only for the diagnostic.
 */

export { RemoteStreamMuxServer } from '../../../api/gateway/src/stream-server.ts'
export type {
  RemoteStreamFailureMapper,
  RemoteStreamOpener,
} from '../../../api/gateway/src/stream-server.ts'
export { createRemoteProxy, internals } from '../src/proxy.ts'
export type { RemoteProxyHandle } from '../src/proxy.ts'
