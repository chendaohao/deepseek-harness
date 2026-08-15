# @deepseek-ai/dsh-remote-tunnel

English | [中文](README.zh.md)

Remote-tunnel capability: the default-exported `RemoteTunnel` Service (`ctx.remoteTunnel`) with its cloudflared quick-tunnel provider. `open(port)` spawns a pinned `cloudflared` release (`2026.8.1`, SHA-256-verified per platform against the official release checksums) with `tunnel --url http://127.0.0.1:<port> --no-autoupdate`, scans bounded stdout/stderr windows for the `https://<slug>.trycloudflare.com` URL (real cloudflared logs the banner to stderr), retries spawn attempts with backoff, and resolves a `RemoteTunnelSession`: its `url`, and `close()` stopping the child (SIGTERM, grace, SIGKILL) and awaiting exit. Sessions emit `remote-tunnel/state` with `open` (plus URL), `ended` (child exit), or `failed` (attempt budget spent; `open()` rejects with the same message). A session's URL stays readable after `ended` but is dead.

Config `{enabled, download: 'allow'|'deny'|'system', binaryPath?}`: `allow` downloads the pinned asset into `$DSH_HOME/bin` on first use (the macOS tgz extracts through the system tar), `deny` requires an existing `binaryPath`, and `system` runs `cloudflared` from PATH. Misconfig fails the load (missing `binaryPath` under `deny`); a download whose digest mismatches the pinned hash fails loudly and keeps nothing. `open()` refuses while `enabled` is false and on non-integral or out-of-range ports. The child starts from the scrubbed parent environment (no credential-shaped or `DSH_*` names).

Restart policy belongs to the consumer: [`dsh-remote-access`](../remote-access/README.md) reopens a session on `ended`.

## Model Experience

None, as the package owns tunnel transport only; no URL, ticket, or cookie reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Single provider** — cloudflared quick tunnels are the only backend; the Service is the seam a frp/Tailscale provider would replace, but no provider registry exists until a second provider needs one.
- **Ephemeral, test-grade URLs** — TryCloudflare assigns a random subdomain per session and Cloudflare positions quick tunnels for testing; deployments needing stable domains or SLAs must front a named tunnel or another provider.
- **One network fetch to install** — `download: allow` fetches the pinned release from GitHub on first use; air-gapped hosts use `system` or `binaryPath`.

