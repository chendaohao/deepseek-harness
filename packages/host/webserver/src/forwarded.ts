/**
 * Forwarded-request marker shared by the reverse-proxy hop and the Host-side
 * consumers that need to know a request arrived through the remote-access
 * proxy rather than directly on the loopback server.
 * @module @deepseek-ai/dsh-host-webserver/forwarded
 */

/**
 * Header the remote-access reverse proxy stamps onto every relayed request and
 * strips from inbound traffic, so an outer proxy cannot spoof it. A value of
 * `'1'` marks a request that crossed the tunnel-facing proxy; its absence marks
 * a request served directly (the desktop, local case).
 */
export const PROXIED_HEADER = 'x-dsh-proxied'
