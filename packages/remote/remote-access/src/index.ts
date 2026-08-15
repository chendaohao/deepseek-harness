/**
 * @deepseek-ai/dsh-remote-access — the remote-access consumer of the
 * remote-tunnel capability for the dsh Web GUI. When enabled (the shipped
 * row derives it from the --remote flag), it owns the pairing secret, the
 * loopback reverse proxy with its pairing gate, the /pair/<ticket> exchange,
 * the tunnel lifecycle with restart on child exit, and the terminal URL +
 * QR-code surface. It registers DSH_REMOTE_URL through the shell-env seam.
 * @module @deepseek-ai/dsh-remote-access
 */

import { setTimeout as sleepMs } from 'node:timers/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import qrcode from 'qrcode-terminal'
import type { RemoteTunnelSession } from '@deepseek-ai/dsh-remote-tunnel'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-shell-env'
import { ensurePairingSecret, pairingTicket } from './secret.ts'
import { createAccessPolicy } from './policy.ts'
import { createRemoteProxy, type RemoteProxyHandle } from './proxy.ts'

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

/** Plugin config: activation plus secret rotation. */
export interface Config {
  /** Whether the proxy, gate, and tunnel run at all; false leaves the plugin inert. */
  enabled: boolean
  /** Rotate the persisted pairing secret before opening the tunnel. */
  resetSecret: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  resetSecret: z.boolean().default(false),
})

/**
 * The remote-access Service (ctx key remoteAccess): pairing gate, reverse
 * proxy, tunnel lifecycle, and the URL/QR presentation of the capability.
 */
export class RemoteAccess extends Service {
  static inject = ['remoteTunnel', 'webServer', 'shellEnv']
  static Config = Config

  private secret: Buffer | undefined
  private proxy: RemoteProxyHandle | undefined
  private session: RemoteTunnelSession | undefined
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
    const policy = createAccessPolicy(this.secret)
    // The webserver binds either the loopback address or the all-interfaces
    // wildcard; only the wildcard needs mapping to a connectable destination.
    const targetHost = this.ctx.webServer.host === '0.0.0.0' ? '127.0.0.1' : this.ctx.webServer.host
    this.proxy = await createRemoteProxy({ targetPort: this.ctx.webServer.port, targetHost, policy })
    this.ctx.effect(() => async () => {
      this.disposed = true
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

  /** Print the pairing URL line plus its terminal QR code. */
  private printPairUrl(url: string): void {
    const secret = this.secret
    /* v8 ignore next -- printPairUrl only runs after init stored the secret */
    if (secret === undefined) return
    const pairUrl = url + PAIR_PATH + pairingTicket(secret, Date.now())
    console.log('dsh web remote: ' + pairUrl)
    qrcode.generate(pairUrl, { small: true }, (qr) => { console.log(qr) })
  }

  /** Register the DSH_REMOTE_URL shell-env fact, present only while a session is live. */
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
}

export default RemoteAccess

