# Agent Note: Remote-access device bindings — per-device cookies, sliding 30-day unbind, Settings page

Status: implemented

English | [中文](2026-08-15-remote-device-bindings.zh.md)

## Problem

The remote-access gate ([remote phone access note](2026-08-14-remote-phone-access.md)) minted stateless cookies: the `v1` value encoded only an expiry day, so every device paired the same day shared one cookie value. There was no device identity, no last-use signal, no revocation, and nothing to show in the GUI — while the product asks for a device list in Web Settings with bindings that lapse after 30 idle days and refresh with use.

## Decision

**Move binding state server-side; the cookie becomes a per-device capability and the registry owns expiry.**

- **Cookie v2** (`secret.ts`): `v2.<deviceId>.<mac>` with a fresh random 16-byte device id per pairing; HMAC binds the id to the master secret, constant-time verified. The embedded expiry day is gone — expiry is the registry's call. The v1 shape is rejected wholesale (pre-release stance: no compat).
- **Device registry** (`devices.ts`): one record per pairing (`deviceId, label, boundAt, lastUsedAt`), persisted at `$DSH_HOME/secrets/remote-devices.json` with atomic tmp+rename 0600 writes; a malformed file fails load loud. Writes throttle to once per UTC day per device; `flush()` awaits quiescence for tests and teardown.
- **Sliding window**: `authorize` verifies the cookie, then `touch` — admission refreshes `lastUsedAt`; `now - lastUsedAt >= 30 days` deletes the binding and answers 401 (auto-unbind). `list()` lazily GCs expired rows. WS upgrades gate once at handshake; the window slides on the next plain request (documented semantics).
- **Browser cookie refresh**: browsers honor Max-Age, so the first admitted request of each UTC day piggybacks a `Set-Cookie` (same value, fresh 30-day Max-Age) onto the relayed response — merged after any target set-cookie arrays (node guarantees client-side arrays).
- **Pairing labels**: `/pair/<ticket>?name=` (sanitized, ≤64 chars) over the User-Agent prefix; the mobile app sends its model name (expo-device).
- **Remote surface**: `RemoteAccessGateway extends TypertRemoteService` (namespace `remoteAccessDevices`) with `list()`/`unbind(deviceId)`, plugged in the service init only while enabled; the client assembly mounts the generated namespace, and the new [`ui-settings-remote`](../../../../packages/client/ui-settings-remote/README.md) Settings page renders the list (label, bound date, relative last use, countdown) with a two-step manual unbind.
- **`resetSecret` rotates the secret AND clears the registry** — every v2 cookie's HMAC breaks at once; stale bindings must not survive.

## Alternatives considered

- **Keep the stateless cookie and mint longer Max-Age** — rejected: no per-device revocation, no last-use, and the GUI list would need a parallel registry anyway; two truths for one binding.
- **Registry-side expiry inside the cookie (embed lastUsed)** — rejected: a client-controlled cookie would then assert its own freshness; only the server can own the window.
- **Session/projection events for live list updates** — deferred: the Settings page reloads on open/retry/unbind; a pushed invalidation event can follow the settings-document precedent when a consumer needs liveness.
- **Hiding the Settings section when the host lacks the plugin** — rejected for now: the typert namespace mounts client-side regardless, so absence detection would need an eager probe in `apply` (the pattern every settings Remote page avoids); the page degrades to its failure alert instead, and the limitation is recorded in its README.

## Consequences

- The cookie contract is public vocabulary of the remote plugin: the value format (`v2.<id>.<mac>`), the `?name=` pairing parameter, and the 30-day `DEVICE_INACTIVITY_MS` window are all host-owned and consumed by the mobile core's pairing only opaquely (it stores the cookie verbatim).
- Registry writes are day-throttled: a crash loses at most one day of window progress (the 30-day window tolerates it); teardown flushes before disposal.
- The Settings nav gains 远程访问/Remote Access on every web deployment (golden snapshots refreshed accordingly); on non-`--remote` deployments the page shows its failure state until that is distinguished by error code.
- Long-lived WebSockets outlive their device's unbinding until reconnect — same as the previous cookie semantics; documented in the README security model.
- The rebuilt typert faces (`./typert`, `./remote` exports) ride the standard host build; the client assembly mounts the namespace beside pluginInventory.
