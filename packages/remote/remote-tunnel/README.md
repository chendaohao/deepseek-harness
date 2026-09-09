---
description: "Tunnel capability Service (`ctx.remoteTunnel`): pinned cloudflared quick and named tunnels with verified downloads."
kind: "package-reference"
---
# @deepseek-ai/dsh-remote-tunnel

English | [中文](README.zh.md)

## Summary

`dsh-remote-tunnel` exposes a local port on a public HTTPS URL by spawning a pinned, SHA-256-verified `cloudflared` release: quick mode needs no Cloudflare account and mints a random `*.trycloudflare.com` hostname per session; named mode runs a pre-registered tunnel under a stable hostname you own. `open(port)` retries with backoff and resolves a `RemoteTunnelSession` (`url`, `close()`); sessions emit `remote-tunnel/state` with `open`, `ended`, or `failed`. The child runs from a scrubbed environment; misconfiguration fails the load.

## Operation

Config `{enabled, download: 'allow'|'deny'|'system', binaryPath?, mode: 'quick'|'named', name?, hostname?}`: `allow` downloads the pinned asset into `$DSH_HOME/bin` on first use (the macOS tgz extracts through the system tar), `deny` requires an existing `binaryPath`, and `system` runs `cloudflared` from PATH. Quick mode (default) needs no Cloudflare account and mints a random hostname per session; named mode runs a pre-registered tunnel under a stable `hostname`, so restarts keep the same URL, and requires both `name` (the tunnel name or UUID from `cloudflared tunnel create`) and `hostname` (a bare DNS name; the session URL is `https://<hostname>`). Misconfig fails the load: a named mode missing `name` or `hostname`, `name`/`hostname` set outside named mode, a `hostname` that is not a bare DNS name, and a missing `binaryPath` under `deny`. A download whose digest mismatches the pinned hash fails loudly and keeps nothing. `open()` refuses while `enabled` is false and on non-integral or out-of-range ports. The child starts from the scrubbed parent environment (no credential-shaped or `DSH_*` names), which still carries `HOME` so named mode finds `~/.cloudflared/{cert.pem,<tunnel>.json}`.

Named mode needs the tunnel registered once under the deployment's Cloudflare account before it can run: `cloudflared tunnel login` (browser OAuth writes `~/.cloudflared/cert.pem`), `cloudflared tunnel create <name>`, and `cloudflared tunnel route dns <name> <hostname>`, all with the pinned binary (or any matching `cloudflared`). A `route dns` not run yet registers fine but answers 404 in the browser until the CNAME exists.

Restart policy belongs to the consumer: [`dsh-remote-access`](../remote-access/README.md) reopens a session on `ended`.

## Table of Contents

- [Operation](#operation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----
<a id="model-experience"></a>
## Model Experience

None, as the package owns tunnel transport only; no URL, ticket, or cookie reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Single provider** — cloudflared tunnels are the only backend; the Service is the seam a frp/Tailscale provider would replace, but no provider registry exists until a second provider needs one.
- **Quick mode is ephemeral** — TryCloudflare assigns a random subdomain per session and Cloudflare positions quick tunnels for testing; deployments needing stable domains register a named tunnel (`mode: named`) as documented above.
- **One network fetch to install** — `download: allow` fetches the pinned release from GitHub on first use; air-gapped hosts use `system` or `binaryPath`.

<a id="dev-note"></a>
### Invariant ownership

No runtime invariant companion is published because the tunnel's child-process lifecycle is covered by the package's tests; no owned relation needs a boot-time recheck.

### Dev Note

<details>
<summary>Provider facts</summary>

The pinned release (`2026.8.1`) is SHA-256-verified per platform against the official release checksums; a digest mismatch fails loudly and keeps nothing. Quick mode mints a random `*.trycloudflare.com` hostname per session; named mode runs a pre-registered tunnel under a stable hostname so the pairing cookie survives restarts. Sessions emit `remote-tunnel/state` (`open`/`ended`/`failed`); restart policy belongs to the consumer.

</details>
