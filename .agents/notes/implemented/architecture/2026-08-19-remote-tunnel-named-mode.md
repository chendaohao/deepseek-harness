# Agent Note: remote-tunnel named mode — a stable hostname so restarts keep the URL and the phone stays paired

Status: implemented

English | [中文](2026-08-19-remote-tunnel-named-mode.zh.md)

## Problem

`dsh web --remote` ran cloudflared in **quick mode** (`tunnel --url … --no-autoupdate`), which mints a random `*.trycloudflare.com` slug **per session**. The remote-access pairing cookie is **host-only** (no `Domain` attribute), so it binds to the exact slug origin. A dev restart therefore rotated the URL, the phone's cookie no longer matched, and the user had to re-scan the QR and re-pair on every restart — a ritual that turned a five-second restart into a re-pair.

## Decision

**Add a `named` mode to `dsh-remote-tunnel` that runs a pre-registered Cloudflare tunnel under a stable hostname, so the URL survives restarts and the 30-day pairing cookie persists.** The shipped patch keeps `mode: quick` as the default; the operator opts into stability per deployment by overlaying `mode: named` plus `name` and `hostname` in the web profile patch (`~/.dsh/profiles/web/cordis.patch.yml`).

- **Config**: `mode: 'quick' | 'named'` (default `quick`), `name?: string`, `hostname?: string`. Misconfig fails the load, in the constructor: a named mode missing `name` or `hostname`, `name`/`hostname` set outside named mode (silently dropping a `hostname` is exactly the trap the feature exists to prevent), a `hostname` that is not a bare DNS name (≥2 labels, no scheme/path/port/whitespace/trailing dot, ≤253 chars), and the existing missing-`binaryPath`-under-`deny` rule.
- **Session spec**: `open()` derives `{ mode: 'quick' } | { mode: 'named'; name; hostname }` and normalizes `hostname` to lowercase so the session URL is canonical. `CloudflaredSession` writes a per-session ingress config (`tunnel: <name>`, an ingress rule from `<hostname>` to `http://127.0.0.1:<port>`, and the `http_status:404` catch-all) and spawns `tunnel --config <file> --no-autoupdate run` in named mode — `tunnel run` accepts no `--url`, so the config carries the ingress — and, instead of scanning for a `*.trycloudflare.com` URL, resolves `https://<hostname>` once the child logs the `registered tunnel connection` marker on stderr. The config directory is removed when the session settles. Timeout, pre-ready exit, `watchExit`/`close`, and backoff stay mode-agnostic; only the readiness predicate and the timeout/exit messages differ.
- **One-time operator setup**: `cloudflared tunnel login` (browser OAuth → `~/.cloudflared/cert.pem`), `cloudflared tunnel create <name>`, and `cloudflared tunnel route dns <name> <hostname>`. The child inherits the scrubbed parent environment, which still carries `HOME`, so named mode finds `~/.cloudflared/{cert.pem,<tunnel>.json}`. The pinned binary under `$DSH_HOME/bin` is used throughout.

## Consequences

Quick mode remains the shipped default — no account, random hostname per session, and the re-pair ritual on restart. Named mode requires a Cloudflare account plus a domain and a one-time registration; `route dns` not run yet registers but answers 404 until the CNAME exists (undetectable at `open()` time, documented). remote-access's reconnect loop is untouched: `open()` re-derives the session URL from config on every attempt, so under a named tunnel the URL is constant and the phone keeps its cookie. Docs updated in both remote-tunnel and remote-access READMEs: the "cookies survive a hostname change" claim was wrong for host-only cookies and is now mode-dependent.

## Alternatives considered

- **Persist the quick-tunnel slug** — TryCloudflare always assigns a fresh random subdomain; there is no slug pinning, so the URL rotation is structural to quick mode. Only a registered (named) tunnel owns a stable hostname.
- **Lift the pairing cookie to a `Domain=` cookie** — cross-origin by construction (each restart is a different subdomain), and a domain-wide cookie on `*.trycloudflare.com` (or any suffix Cloudflare routes) would let any slug of that suffix read a pairing meant for one origin — the host-only binding is the point of the design.
- **Document the re-pair ritual** — leaves the core friction in place; rejected once a stable-hostname mode was cheap to add.
