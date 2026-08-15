/**
 * @deepseek-ai/dsh-remote-tunnel — the remote-tunnel capability of the harness:
 * the `remoteTunnel` Service plus its cloudflared quick-tunnel provider. One
 * tunnel session exposes a loopback port over a public HTTPS URL without a
 * Cloudflare account or a pre-registered domain; the public hostname is random
 * per session. The Service owns the spawned cloudflared child and its
 * teardown; consumers of the capability are the presentation and the
 * authentication layers (see dsh-remote-access).
 *
 * The provider downloads and verifies a pinned cloudflared release on first
 * use (SHA-256 constants below match the official checksums of that release);
 * `binaryPath` or `download: system` opt a deployment out of the download.
 * @module @deepseek-ai/dsh-remote-tunnel
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleepMs } from 'node:timers/promises'
import { once } from 'node:events'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** Pinned cloudflared release; the asset table below carries its official SHA-256 checksums. */
const CLOUDFLARED_VERSION = '2026.8.1'

/** One released cloudflared asset this provider can install. */
interface CloudflaredAsset {
  /** Release asset file name. */
  asset: string
  /** Official SHA-256 (hex) of the asset file. */
  sha256: string
  /** Archive kind containing the binary (macOS ships a tgz); raw binaries omit this. */
  archive?: 'tgz'
}

/**
 * Asset table for the pinned release: platform keys are
 * `<process.platform>-<x64|arm64>`. Only the platforms whose assets are raw
 * binaries or a tgz containing `cloudflared` are supported; every other
 * platform fails loudly at open time.
 */
const CLOUDFLARED_ASSETS: Readonly<Record<string, CloudflaredAsset>> = {
  'linux-x64': { asset: 'cloudflared-linux-amd64', sha256: '98d8eadbfdf8c7ec994e08260599c9be991e7833c746f98692b18bdf71c9b9dc' },
  'linux-arm64': { asset: 'cloudflared-linux-arm64', sha256: '6d517efc10dfce17440177bd7011909166eab44bae0f6998182183df717c7dba' },
  'darwin-x64': { asset: 'cloudflared-darwin-amd64.tgz', sha256: '3bb5d94cb7756ee9a12406f229777640eef39edcd78e93e73a4d4a1f163df69e', archive: 'tgz' },
  'darwin-arm64': { asset: 'cloudflared-darwin-arm64.tgz', sha256: 'ebd6cc90cc6342b8e512f77cfaeb241852d87c557a317d91d23c63f4f99333d9', archive: 'tgz' },
  'win32-x64': { asset: 'cloudflared-windows-amd64.exe', sha256: '8f1d6f87b8756dbf37064b16e2c8251b69d816305e4f4373e1b80efb28d13b83' },
}

/** Release download base for the pinned version. */
const CLOUDFLARED_RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/download'

/** Where the tunnel child executable comes from. */
export type CloudflaredDownload = 'allow' | 'deny' | 'system'

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteTunnel: RemoteTunnel
  }

  interface Events {
    /**
     * One tunnel session reported a durable fact: its public URL became ready,
     * its child exited, or a final spawn attempt failed. `open()` rejects with
     * the same message a final `failed` state carries.
     * @mode emit
     * @param state - the discriminated session fact.
     */
    'remote-tunnel/state'(state: RemoteTunnelState): void
  }
}

/** Terminal or reporting facts about one tunnel session, discriminated by status. */
export type RemoteTunnelState =
  | { status: 'open'; url: string }
  | { status: 'ended' }
  | { status: 'failed'; message: string }

/** One live tunnel session: its public URL and its teardown. */
export interface RemoteTunnelSession {
  /** Public HTTPS URL of the tunnel; stable from `open()` resolution to child exit. */
  readonly url: string
  /** Stop the tunnel child and await its exit; idempotent, safe after child exit. */
  close(): Promise<void>
}

/** Plugin config: activation plus binary sourcing. */
export interface Config {
  /**
   * Whether `open()` may start tunnels. The shipped Web row derives this from
   * the `--remote` flag; a disabled Service still loads, and open() fails
   * loudly while disabled. Binary-sourcing misconfiguration fails the load.
   */
  enabled: boolean
  /** Binary sourcing: download the pinned release, require an explicit path, or use PATH. Defaults to `allow`. */
  download?: CloudflaredDownload
  /** Explicit cloudflared executable; wins over every other source. */
  binaryPath?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  download: z.union([z.const('allow'), z.const('deny'), z.const('system')]).default('allow'),
  // Non-required: absent resolves to undefined, matching the optional interface member.
  binaryPath: z.string(),
})

/** Test hook: attempt timing, bounds, and the asset table, overridable so fixture tests need no real waits or downloads. */
export const internals = {
  /** Milliseconds to wait for the tunnel URL per spawn attempt. */
  urlTimeoutMs: 30_000,
  /** Total spawn attempts before `open()` fails. */
  maxAttempts: 3,
  /** Backoff between attempts; indexed by `attempt - 1`. */
  backoffMs: [500, 2_000] as readonly number[],
  /** Grace period between SIGTERM and SIGKILL during close. */
  termGraceMs: 5_000,
  /** Bounded per-stream window scanned for the URL on stdout and stderr (bytes). */
  scanBytes: 65_536,
  /** Bounded stderr tail kept for diagnostics (bytes). */
  stderrTailBytes: 4_096,
  /** Maximum downloaded asset size, enforced while the body streams (bytes). */
  maxDownloadBytes: 200 * 1024 * 1024,
  /** Milliseconds before an asset download aborts. */
  downloadTimeoutMs: 60_000,
  /** Asset table consulted at download time; tests substitute fixture entries with known hashes. */
  assets: CLOUDFLARED_ASSETS,
}

/** The public-URL line cloudflared prints on stdout or stderr. */
const TRYCLOUDFLARE_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

/** Cache file name of the pinned binary. */
function cacheBinaryPath(): string {
  /* v8 ignore next -- the Windows suffix cannot execute on the Linux coverage lane */
  const suffix = process.platform === 'win32' ? '.exe' : ''
  return dshHomePath('bin', `cloudflared-${CLOUDFLARED_VERSION}${suffix}`)
}

/** The release asset for the host platform. */
function assetForPlatform(): CloudflaredAsset {
  /* v8 ignore next -- the coverage lane runs x64/arm64; the unsupported-arch refusal is load-time */
  const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : 'unsupported'
  const entry = internals.assets[`${process.platform}-${arch}`]
  if (entry === undefined) {
    throw new Error(`remote-tunnel: no cloudflared asset for platform ${process.platform}/${process.arch}`)
  }
  return entry
}

/** Message of an unknown rejection, for diagnostics. */
function messageOf(error: unknown): string {
  /* v8 ignore next -- node spawn events always reject with Error instances */
  return error instanceof Error ? error.message : String(error)
}

/**
 * One spawned-tunnel lifecycle: spawn attempts with bounded URL discovery,
 * child exit observation, and SIGTERM→SIGKILL teardown. One session owns one
 * child; after the child exits the session reports `ended` and its URL stays
 * readable but no longer reachable.
 */
class CloudflaredSession implements RemoteTunnelSession {
  private child: ChildProcess | undefined
  private settled = false
  url = ''

  /**
   * @param ctx - context emitting `remote-tunnel/state`.
   * @param binary - resolved cloudflared executable.
   * @param port - loopback port the tunnel exposes.
   * @param onSettle - called once when the session stops (child exit or close).
   */
  constructor(
    private readonly ctx: Context,
    private readonly binary: string,
    private readonly port: number,
    private readonly onSettle: () => void,
  ) {}

  /** Run spawn attempts until a URL appears or the attempt budget is spent. */
  async start(): Promise<void> {
    let lastMessage = 'no spawn attempt reported a URL'
    for (let attempt = 0; attempt < internals.maxAttempts; attempt++) {
      if (attempt > 0) {
        const delay = internals.backoffMs[attempt - 1]
        if (delay !== undefined) await sleepMs(delay)
      }
      // close() may land during the backoff or an attempt; a settled session
      // must not spawn further children nor report state after its teardown.
      if (this.settled) return
      try {
        const url = await this.attemptOnce()
        /* v8 ignore next 4 -- the URL resolution continuation is a microtask, and close() can only
           flip settled from a later macrotask; the arm stays as a defensive guard. */
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the microtask arm stays as a defensive guard
        if (this.settled) {
          // The URL resolved while close() was tearing the child down: stop it.
          await this.killChild()
          return
        }
        this.url = url
        this.watchExit()
        this.ctx.emit('remote-tunnel/state', { status: 'open', url })
        return
      } catch (error) {
        lastMessage = messageOf(error)
        await this.killChild()
      }
    }
    if (this.settled) return
    this.settled = true
    this.onSettle()
    this.ctx.emit('remote-tunnel/state', { status: 'failed', message: lastMessage })
    throw new Error(`remote-tunnel: no tunnel URL after ${internals.maxAttempts} attempts: ${lastMessage}`)
  }

  async close(): Promise<void> {
    if (this.settled) return
    this.settled = true
    this.onSettle()
    await this.killChild()
  }

  /** Spawn once and resolve the first tunnel URL, the child exit, or the attempt timeout. */
  private attemptOnce(): Promise<string> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(this.binary, ['tunnel', '--url', `http://127.0.0.1:${String(this.port)}`, '--no-autoupdate'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: scrubbedParentEnv(),
        })
      } catch (error) {
        /* v8 ignore next -- spawn cannot throw synchronously for a validated path and fixed args */
        reject(error instanceof Error ? error : new Error(String(error)))
        /* v8 ignore next -- unreachable for the same reason */
        return
      }
      this.child = child
      let scannedStdout = Buffer.alloc(0)
      let scannedStderr = Buffer.alloc(0)
      let stderrTail = ''
      let finished = false
      const finish = (result: () => void): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        result()
      }
      const timer = setTimeout(() => {
        finish(() => { reject(new Error('timed out waiting for the tunnel URL')) })
      }, internals.urlTimeoutMs)
      // Real cloudflared logs (including the tunnel URL) to stderr; the
      // bounded scan covers both streams so a banner on either resolves.
      const scan = (stream: 'stdout' | 'stderr', chunk: Buffer): string | undefined => {
        const scanned = stream === 'stdout' ? scannedStdout : scannedStderr
        const next = scanned.length < internals.scanBytes
          ? Buffer.concat([scanned, chunk]).subarray(0, internals.scanBytes)
          : scanned
        if (stream === 'stdout') scannedStdout = next
        else scannedStderr = next
        return TRYCLOUDFLARE_URL.exec(next.toString('utf8'))?.[0]
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        const url = scan('stdout', chunk)
        if (url !== undefined) finish(() => { resolve(url) })
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-internals.stderrTailBytes)
        const url = scan('stderr', chunk)
        if (url !== undefined) finish(() => { resolve(url) })
      })
      child.once('exit', (code, signal) => {
        finish(() => { reject(new Error(
          `cloudflared exited (code ${String(code)}, signal ${String(signal)}) before reporting a URL: ${stderrTail.trim() || '(no stderr)'}`,
        ))})
      })
      child.once('error', (error) => {
        finish(() => { reject(error) })
      })
    })
  }

  /** After a URL resolved: keep draining stdio and report the child's exit. */
  private watchExit(): void {
    this.child?.stdout?.resume()
    this.child?.stderr?.resume()
    this.child?.once('exit', () => {
      if (this.settled) return
      this.settled = true
      this.onSettle()
      this.ctx.emit('remote-tunnel/state', { status: 'ended' })
    })
  }

  /** Stop the child: SIGTERM (plain kill on Windows), grace, SIGKILL, awaited exit. */
  private async killChild(): Promise<void> {
    const child = this.child
    // A child that failed to spawn (pid undefined) never emits 'exit'; there is nothing to stop.
    if (child === undefined || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    /* v8 ignore next -- the Windows kill path cannot execute on the Linux coverage lane */
    const signal: NodeJS.Signals | undefined = process.platform === 'win32' ? undefined : 'SIGTERM'
    child.kill(signal)
    const timedOut = await Promise.race([
      exited.then(() => false),
      sleepMs(internals.termGraceMs).then(() => true),
    ])
    if (timedOut) {
      child.kill('SIGKILL')
      await exited
    }
  }
}

/**
 * The remote-tunnel Service (`ctx.remoteTunnel`): resolves the cloudflared
 * binary and opens tunnel sessions over the loopback port it is handed.
 */
export class RemoteTunnel extends Service {
  static Config = Config

  private readonly sessions = new Set<CloudflaredSession>()

  /**
   * @param ctx - owning Cordis context.
   * @param config - validated {@link Config}; misconfigured binary sourcing fails the load.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'remoteTunnel')
    if (config.download === 'deny' && config.binaryPath === undefined) {
      throw new Error('remote-tunnel: download "deny" requires an explicit binaryPath')
    }
    if (config.binaryPath !== undefined && !existsSync(config.binaryPath)) {
      throw new Error(`remote-tunnel: binaryPath ${JSON.stringify(config.binaryPath)} does not exist`)
    }
    // Dispose must reach quiescence: close every live session and await the children.
    ctx.effect(() => async () => {
      await Promise.all([...this.sessions].map(session => session.close()))
    }, 'remoteTunnel.dispose')
  }

  /**
   * Open one tunnel session exposing the given loopback port.
   * @param port - loopback port the tunnel targets (the proxy or webserver port).
   * @returns the live session with its public URL; rejects after the attempt budget.
   */
  async open(port: number): Promise<RemoteTunnelSession> {
    if (!this.config.enabled) {
      throw new Error('remote-tunnel: disabled; enable it with --remote or enabled: true')
    }
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`remote-tunnel: invalid tunnel port ${String(port)}`)
    }
    const binary = await this.resolveBinary()
    // Settled sessions remove themselves; the set therefore holds exactly the live children.
    const session = new CloudflaredSession(this.ctx, binary, port, () => { this.sessions.delete(session) })
    this.sessions.add(session)
    await session.start()
    return session
  }

  /** Resolve the executable per config: explicit path, PATH, or the verified cache. */
  private async resolveBinary(): Promise<string> {
    if (this.config.binaryPath !== undefined) return this.config.binaryPath
    if (this.config.download === 'system') return 'cloudflared'
    const cachePath = cacheBinaryPath()
    if (existsSync(cachePath)) return cachePath
    const { asset, sha256, archive } = assetForPlatform()
    const body = await downloadAsset(asset)
    const digest = createHash('sha256').update(body).digest('hex')
    if (digest !== sha256) {
      throw new Error(`remote-tunnel: ${asset} failed its SHA-256 check (got ${digest}, want ${sha256})`)
    }
    await installBinary(asset, body, archive, cachePath)
    return cachePath
  }
}

export default RemoteTunnel

/**
 * Download one release asset, enforcing the size bound while the body streams.
 * @param asset - asset file name of the pinned release.
 * @returns the complete asset bytes.
 */
async function downloadAsset(asset: string): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, internals.downloadTimeoutMs)
  try {
    const response = await fetch(`${CLOUDFLARED_RELEASE_BASE}/${CLOUDFLARED_VERSION}/${asset}`, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`remote-tunnel: downloading ${asset} failed with HTTP ${String(response.status)}`)
    }
    /* v8 ignore next -- a successful fetch always provides a body stream */
    if (response.body === null) throw new Error(`remote-tunnel: ${asset} arrived without a body`)
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of response.body) {
      total += chunk.length
      // The bound counts the complete retained value, not a post-download tally.
      if (total > internals.maxDownloadBytes) {
        throw new Error(`remote-tunnel: ${asset} exceeds the ${String(internals.maxDownloadBytes)}-byte download bound`)
      }
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`remote-tunnel: downloading ${asset} timed out after ${String(internals.downloadTimeoutMs)} ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Install a verified asset at the cache path: raw binaries rename into place;
 * the macOS tgz extracts through the system tar.
 * @param asset - asset file name.
 * @param body - verified asset bytes.
 * @param archive - archive kind, when the asset is not a raw binary.
 * @param cachePath - final executable path.
 */
async function installBinary(asset: string, body: Buffer, archive: 'tgz' | undefined, cachePath: string): Promise<void> {
  const binDir = join(cachePath, '..')
  await mkdir(binDir, { recursive: true, mode: 0o700 })
  const tempDir = await mkdtemp(join(binDir, '.cloudflared-install-'))
  try {
    if (archive === 'tgz') {
      const tgzPath = join(tempDir, asset)
      await writeFile(tgzPath, body)
      const extracted = spawnSync('tar', ['-xzf', asset, 'cloudflared'], { cwd: tempDir, env: scrubbedParentEnv() })
      if (extracted.status !== 0) {
        throw new Error(`remote-tunnel: tar failed to extract ${asset} (status ${String(extracted.status)})`)
      }
      await chmod(join(tempDir, 'cloudflared'), 0o755)
      await rename(join(tempDir, 'cloudflared'), cachePath)
      return
    }
    await writeFile(join(tempDir, 'cloudflared'), body)
    await chmod(join(tempDir, 'cloudflared'), 0o755)
    await rename(join(tempDir, 'cloudflared'), cachePath)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}
