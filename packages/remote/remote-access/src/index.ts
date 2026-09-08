/**
 * @deepseek-ai/dsh-remote-access — the remote-access consumer of the
 * remote-tunnel capability for the dsh Web GUI. When enabled (the shipped
 * row derives it from the --remote flag), it owns the pairing secret, the
 * revocable device registry, the loopback reverse proxy with its pairing gate,
 * the /pair/<token> exchange, the tunnel lifecycle with restart on child exit,
 * the terminal URL + QR-code surface, and the desktop-only /remote/* control
 * plane the in-GUI panel drives. It registers DSH_REMOTE_URL through the
 * shell-env seam.
 * @module @deepseek-ai/dsh-remote-access
 */

import { setTimeout as sleepMs } from 'node:timers/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import qrcode from 'qrcode-terminal'
import type { RemoteTunnelSession } from '@deepseek-ai/dsh-remote-tunnel'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-shell-env'
import { ensurePairingSecret } from './secret.ts'
import { createAccessPolicy } from './policy.ts'
import { createRemoteProxy, PROXIED_HEADER, type RemoteProxyHandle } from './proxy.ts'
import { DeviceRegistry } from './devices.ts'

/** Restart attempts after an unexpected tunnel exit before giving up. */
const RESTART_MAX = 5
/** Backoff before each restart attempt, linear in the attempt number. */
const RESTART_BACKOFF_BASE_MS = 2_000

/** Test hook: restart budget and backoff base, overridable so tests need no real waits. */
export const internals = {
  restartMax: RESTART_MAX,
  restartBackoffBaseMs: RESTART_BACKOFF_BASE_MS,
}
/** Relative pairing path prefix the QR encodes. */
const PAIR_PATH = '/pair/'
/** Action suffix the control plane accepts on the device path. */
const DEVICE_REVOKE_SUFFIX = '/revoke'
/** Action suffix renaming one device (the new label rides the `name` query param). */
const DEVICE_RENAME_SUFFIX = '/rename'
/** Maximum length of a user-assigned device label. */
const DEVICE_NAME_MAX = 40

/** Plugin config: activation plus secret rotation. */
export interface Config {
  /** Whether the proxy, gate, and tunnel run at all; false leaves the plugin inert. */
  enabled: boolean
  /** Rotate the persisted pairing secret and revoke every device before opening the tunnel. */
  resetSecret: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  resetSecret: z.boolean().default(false),
})

/** Connection-service face the pair bridge needs; structural so this package keeps its dependency set. */
interface IndexLoginConnection {
  /**
   * Application root URL carrying the process launch token.
   * @param baseUrl - canonical browser origin without credentials.
   * @returns the root URL whose visit mints the browser-auth cookie.
   */
  authenticatedUrl(baseUrl: string): string
}

/**
 * The remote-access Service (ctx key remoteAccess): pairing gate, device
 * registry, reverse proxy, tunnel lifecycle, and the URL/QR + control-plane
 * presentation of the capability.
 */
export class RemoteAccess extends Service {
  static inject = ['remoteTunnel', 'webServer', 'shellEnv', 'connection']
  static Config = Config

  private secret: Buffer | undefined
  private proxy: RemoteProxyHandle | undefined
  private session: RemoteTunnelSession | undefined
  private devices: DeviceRegistry | undefined
  private disposed = false
  private restarts = 0

  /**
   * @param ctx - owning Cordis context with the tunnel, webserver, and shell-env services.
   * @param config - validated {@link Config}.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'remoteAccess')
  }

  async [Service.init](): Promise<void> {
    if (!this.config.enabled) return
    // Resolved at init: the harness home must reflect the live environment.
    this.secret = await ensurePairingSecret(dshHomePath('secrets', 'remote-pair'), this.config.resetSecret)
    this.devices = new DeviceRegistry(dshHomePath('secrets', 'remote-roster.json'))
    await this.devices.load()
    if (this.config.resetSecret) {
      this.devices.revokeAll()
      await this.persistDevices()
    }
    // Wire the emitter before the proxy starts serving: a pairing can register
    // a device as soon as the gate accepts traffic.
    this.devices.onChange = (structural) => {
      this.emitDeviceChange()
      if (structural) void this.persistDevices()
    }
    const policy = createAccessPolicy(this.secret, this.devices, {
      // Local extension: the webserver's browser-auth fence (connection) is a
      // second layer behind the pairing gate. Hand the just-paired device the
      // launch-token login URL so its 302 mints the authority cookie over the
      // rewritten loopback Host; without it every paired tunnel visit stops at
      // the fence's 401. Structural typing keeps remote-access free of a
      // package dependency on the connection capability.
      indexLoginUrl: () => {
        const connection = (this.ctx as Context & { connection?: IndexLoginConnection }).connection
        const session = this.session
        return connection === undefined || session === undefined
          ? undefined
          : connection.authenticatedUrl(session.url)
      },
    })
    // The webserver binds either the loopback address or the all-interfaces
    // wildcard; only the wildcard needs mapping to a connectable destination.
    const targetHost = this.ctx.webServer.host === '0.0.0.0' ? '127.0.0.1' : this.ctx.webServer.host
    this.proxy = await createRemoteProxy({ targetPort: this.ctx.webServer.port, targetHost, policy })
    this.registerControlPlane()
    this.ctx.effect(() => async () => {
      this.disposed = true
      if (this.devices !== undefined) this.devices.onChange = undefined
      await this.session?.close()
      await this.proxy?.close()
    }, 'remoteAccess.dispose')
    this.registerShellEnv()
    this.ctx.on('remote-tunnel/state', (state) => {
      /* v8 ignore next -- the listener unloads with the fiber, so disposal cannot race an ended event */
      if (state.status !== 'ended' || this.disposed) return
      this.session = undefined
      if (this.restarts >= internals.restartMax) {
        this.ctx.logger.error('remote-access: the tunnel exited %d times; giving up on restarts', internals.restartMax)
        return
      }
      this.restarts++
      const delay = internals.restartBackoffBaseMs * this.restarts
      void sleepMs(delay).then(() => { if (!this.disposed) void this.openTunnelLoop() })
    })
    // Open after the Loader settles, like the web-app URL line: the printed
    // pair URL must not precede sibling rows (the /api route) mounting.
    const settled = (this.ctx.get('loader') as { await(): Promise<void> } | undefined)?.await()
    if (settled === undefined) void this.openTunnelLoop()
    else {
      void settled.then(() => {
        if (!this.disposed && this.ctx.get('webServer') !== undefined) void this.openTunnelLoop()
      }, () => {})
    }
  }

  /** Open one tunnel session over the proxy port; prints the pair URL on success. */
  private async openTunnelLoop(): Promise<void> {
    /* v8 ignore next -- every call site checks disposal before invoking; the guard covers re-entry */
    if (this.isDisposed() || this.proxy === undefined) return
    try {
      const session = await this.ctx.remoteTunnel.open(this.proxy.port)
      // Re-read through the method: disposal may have run during the awaited open.
      if (this.isDisposed()) {
        await session.close()
        return
      }
      this.session = session
      this.restarts = 0
      this.printPairUrl(session.url)
    } catch (error) {
      this.ctx.logger.error('remote-access: could not start the remote tunnel: %s', error instanceof Error ? error.message : String(error))
    }
  }

  /** Print the pairing URL line plus its terminal QR code (one-time token). */
  private printPairUrl(url: string): void {
    if (this.devices === undefined) return
    const token = this.devices.issueToken(Date.now())
    const pairUrl = url + PAIR_PATH + token
    console.log('dsh web remote: ' + pairUrl)
    qrcode.generate(pairUrl, { small: true }, (qr) => { console.log(qr) })
  }

  /** Whether the owning fiber disposed this service. */
  private isDisposed(): boolean {
    return this.disposed
  }

  private registerShellEnv(): void {
    this.ctx.shellEnv.register({
      name: 'remote-access',
      variables: {
        DSH_REMOTE_URL: { description: 'Public HTTPS URL of the active remote tunnel for this Web GUI.' },
      },
      resolve: () => this.session === undefined ? {} : { DSH_REMOTE_URL: this.session.url },
    })
  }

  /** Desktop-only control plane backing the in-GUI remote panel; tunnel traffic is refused. */
  private registerControlPlane(): void {
    this.ctx.effect(
      () => this.ctx.webServer.register({ kind: 'prefix', path: '/remote', handler: this.handleControl.bind(this) }),
      'remote-access: control plane',
    )
  }

  private handleControl(req: IncomingMessage, res: ServerResponse): void {
    if (req.headers[PROXIED_HEADER] !== undefined) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const rawPath = url.pathname
    if (req.method === 'GET' && rawPath === '/remote/state') {
      this.respondState(res)
      return
    }
    if (req.method === 'GET' && rawPath === '/remote/devices') {
      this.respondDevices(res)
      return
    }
    if (req.method === 'POST' && rawPath === '/remote/pair/issue') {
      this.issuePair(res)
      return
    }
    if (req.method === 'POST' && rawPath === '/remote/stop') {
      this.stopAll(res)
      return
    }
    if (req.method === 'POST' && rawPath.startsWith('/remote/devices/')) {
      const rest = rawPath.slice('/remote/devices/'.length)
      const suffix = rest.endsWith(DEVICE_REVOKE_SUFFIX)
        ? DEVICE_REVOKE_SUFFIX
        : rest.endsWith(DEVICE_RENAME_SUFFIX) ? DEVICE_RENAME_SUFFIX : undefined
      if (suffix === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      let deviceId: string
      try {
        deviceId = decodeURIComponent(rest.slice(0, -suffix.length))
      } catch {
        // A malformed percent-encoding must not escape as an uncaught URIError.
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('bad device id')
        return
      }
      if (suffix === DEVICE_REVOKE_SUFFIX) {
        this.revokeDevice(deviceId, res)
        return
      }
      const name = url.searchParams.get('name')?.trim() ?? ''
      this.renameDevice(deviceId, name, res)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }

  private respondState(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      tunnelUrl: this.session?.url ?? null,
      tunnelStatus: this.session === undefined ? 'down' : 'open',
      devices: this.devices?.snapshotWithExpiry() ?? [],
    }))
  }

  private respondDevices(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ devices: this.devices?.snapshotWithExpiry() ?? [] }))
  }

  private issuePair(res: ServerResponse): void {
    const url = this.session?.url
    if (url === undefined) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('tunnel unavailable')
      return
    }
    if (this.devices === undefined) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('device store unavailable')
      return
    }
    const token = this.devices.issueToken(Date.now())
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ url: url + PAIR_PATH + token }))
  }

  private stopAll(res: ServerResponse): void {
    this.devices?.revokeAll()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end('{}')
  }

  private revokeDevice(deviceId: string, res: ServerResponse): void {
    const removed = this.devices?.revoke(deviceId) ?? false
    if (!removed) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end('{}')
  }

  private renameDevice(deviceId: string, name: string, res: ServerResponse): void {
    if (name === '' || name.length > DEVICE_NAME_MAX) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('invalid device name')
      return
    }
    const renamed = this.devices?.rename(deviceId, name) ?? false
    if (!renamed) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end('{}')
  }

  private emitDeviceChange(): void {
    try {
      this.ctx.emit('remote/devices/change', this.devices?.snapshotWithExpiry() ?? [])
    } catch (error) {
      // A throwing listener must not abort the proxy request path that fired it.
      this.ctx.logger.error(error)
    }
  }

  private async persistDevices(): Promise<void> {
    try {
      await this.devices?.persist()
    } catch (error) {
      this.ctx.logger.error('remote-access: could not persist the device registry: %s', error instanceof Error ? error.message : String(error))
    }
  }
}

export default RemoteAccess
