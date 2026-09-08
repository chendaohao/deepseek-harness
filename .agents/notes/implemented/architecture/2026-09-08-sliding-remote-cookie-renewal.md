# Agent Note: Sliding remote-access device window and the fence cookie daily refresh

Status: implemented

English | [中文](2026-09-08-sliding-remote-cookie-renewal.zh.md)

## Problem

The device pairing gate lost its sliding renewal in the `b8221b3fbe` rework. The `v2` cookie embedded an expiry day at pairing time and never renewed: a phone that scanned the QR once stopped authenticating exactly 30 days later no matter how often it was used — the opposite of the requested behavior (daily use resets the 30-day window, per the original [remote-device-bindings design] restored from the `28f77a17f7` lineage). The desktop panel gave no visibility into the remaining lifetime, and the second fence — the `/api` browser-session cookie — had the same fixed-lifetime defect: its 30-day `Max-Age` counted from the launch-token visit, so a long-lived paired device also hit the connection fence's 401 after 30 days even with the gate fixed.

## Decision

**Expiry is owned by the registry, and every use slides it; cookies carry no expiry of their own and are refreshed on a UTC-day cadence.**

- **Cookie v3** (`remote-access/secret.ts`): the value is `v3.<deviceId>.<mac>` — the embedded expiry day is gone, so a minted cookie never expires by itself. The HMAC context changed from `v2:` to `v3:`, which invalidates every pre-existing cookie at once (pre-release stance: no compat); paired devices re-scan once after this change.
- **Sliding window** (`remote-access/devices.ts`): `touch` returns `{admitted, dayRolled}`. Admission refreshes `lastSeen`; `now - lastSeen >= 30 days` deletes the binding (auto-unbind) and denies. The 5-second liveness-notify throttle is preserved, but a day rollover always advances `lastSeen` so the refresh cadence cannot be starved by it.
- **Daily cookie refresh** (`remote-access/policy.ts`): `authorize` returns `{admitted, cookieRefresh}`; on the first admitted request of each UTC day it re-issues the presented cookie with a fresh 30-day `Max-Age`. The proxy merges that `Set-Cookie` onto the relayed response headers (appended after the target's own cookies; node guarantees the array shape). Upgrade handshakes have no response headers, so a day-rolled upgrade slides the registry window and the refresh rides the next plain request — same documented semantics as the original design.
- **The fence cookie renews the same way** (`client-connection/browser-auth.ts`): `authenticate` verifies the presented cookie and, when the UTC day crossed since `issuedAt`, mints a fresh full-lifetime cookie (new `issuedAt`/`expiresAt`, re-signed). `HostConnectionHandle.requestRejection` takes an optional `appendHeader` callback — HTTP routes (`/api` in both connection and rpc-host registrations, open-in-app) attach the refresh; the gateway's mux upgrade keeps calling without it. A rejected or token-exchange request produces no refresh, so the header only rides an already-authenticated response.
- **The panel shows the lifetime**: the control plane and `remote/devices/change` now carry `DeviceView` (`expiresAt = lastSeen + 30 days`), and the panel renders `有效期 {days} 天` / `{days}d left` beside the online/offline badge. The registry's persisted `DeviceRecord` shape is unchanged, so old roster files load as-is.

## Alternatives considered

- **Re-issuing the cookie on every admitted request** — rejected: the Set-Cookie would ride every relayed response for no benefit; the day cadence bounds staleness at 24–48h, which the 30-day window tolerates.
- **Sliding the fence cookie only, without the gate** (or vice versa) — rejected: the two fences both bind the same browser session; renewing one leaves the other to 401 the phone at its own 30-day mark.
- **Embedding a renewed expiry day into a v2-shaped cookie** — rejected: minting a fresh value per day-rolled request is strictly simpler and keeps `verifyCookie` time-free.

## Consequences

- A paired phone kept in daily use never re-pairs; the panel's countdown stays at 30 and drops only during true idle.
- One existing v2 cookie per device stops working once this deploys; the fix is a re-scan (or `--remote-reset` for a clean slate). The roster itself survives.
- The upgrade-path refresh drop means a device that only ever opens WebSocket streams across a day boundary gets its window slid (via `touch`) but not its browser Max-Age extended; any plain HTTP request (the app shell, `/api` calls) carries the refresh, so in practice the browser cookie stays ahead of the registry window.

## Verification

`secret.spec.ts` covers the v3 round-trip and rejection matrix (no expiry cases remain). `policy.spec.ts` asserts the same-day verdict carries no refresh, the day-rolled verdict echoes the exact `Set-Cookie`, and a device idle past the slid window auto-unbinds. `devices.spec.ts` keeps the roster/persistence coverage through the new `TouchResult`. `proxy.spec.ts` runs every stub policy through the `AuthorizeResult` shape. `browser-auth` and `node-half` connection specs cover the fence refresh (recorder stubs gained `appendHeader`), and the panel spec asserts the countdown rendering. No recorded-session snapshot changes: pairing-gate and fence behavior sit behind the keyless harness's loopback replay path.
