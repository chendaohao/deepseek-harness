# Agent Note: Read-only settings for forwarded clients, and the /m surface removal

Status: implemented

English | [中文](2026-09-08-forwarded-settings-fence-and-m-removal.zh.md)

## Problem

Two surfaces disagreed about who may write the settings document. A phone browser opening the desktop web shell over the paired remote-access tunnel got the full settings page, but `ui-settings` resolved its persistence from `remote.$host.isLoopback` and kept a non-loopback page process-local: the phone showed a dead mirror instead of following the host values it was paired to see. Conversely, nothing server-side distinguished a tunnel caller from the desktop, so any future client that did issue settings writes from a forwarded request would have reached the host document with the desktop's full reach — including permission presets, which bypass the agent approval flow — and credential values.

At the same time the standalone `/m` mobile page duplicated the transport, theming, and pairing surfaces for a second rendering of the same state, and the user's actual usage is the desktop shell opened from the phone.

## Decision

**The Host fence owns writability; the client renders the describe answer.** `client-connection` installs per-request facts (lower-cased, single-string headers) into an `AsyncLocalStorage` around every `/api` dispatch, and the Gateway's WebSocket mux re-installs the upgrade request's facts around every stream open. The remote-access reverse proxy stamps `x-dsh-proxied` on every relayed request and strips it from inbound traffic (the header constant moved to `host-webserver`, the shared owner below both the proxy and the controllers). `settings-controller` checks that marker: `describe` reports `writable: provider.writable && (!forwarded || config.forwardedWrite)`, and every settings write refuses with the new `settings/forwarded-write-disabled` code when forwarded while the switch is off. A direct in-process call installs no facts and is unaffected — the desktop keeps its semantics.

**Credential writes never open.** Even with `forwardedWrite: true`, `credentials.set`/`unset` refuse forwarded callers unconditionally, and `credentials.describe` reports every reference non-writable to them. A tunnel client can rearrange the settings document but cannot change the API keys the host calls out with.

**The switch is an explicit deployment choice.** `forwardedWrite` defaults to `false`, the web-app bundle pins it explicitly, and `--remote` does not imply it. The failure is loud: a named error code the UI can render and the log can grep.

**The client drops its client-side guess.** `ui-settings` deletes the `memory` persistence mode: the mirror always reads, `persistence` is no longer a constructor or binder parameter, and `SettingsScopeSnapshot.mode` is the literal `'host'`. Writability is the describe answer, so a phone page now follows host values live and every writable control it backs is disabled by the same fact the server enforces. Consumers that did not gate on `writable` yet — theme and locale preference writes — skip the durable store when the snapshot says read-only, keeping the in-session switch without a doomed wire call. The settings-document action stays loopback-only because the raw yaml carries unredacted secrets.

**`/m` is gone.** The mobile directory, its standalone tsdown entry, the two route effects and the config gate in ui-remote's host half, its tests and snapshots, and the bundle row's `webStartup` config all went away; ui-remote's host half is an inert Loader entry and its tsdown config is the plain preset `clientBundle`. The `cssInlinePlugins` extraction in `tsdown.client.ts` stays: `clientConfig` itself consumes it, and the `stylesheetFileId` bare-specifier resolution fixed the desktop bundle's `katex` CSS. The workspace-ext `client-ui-remote` row keeps only `id`/`name`. TODO's `/m` i18n task is retired with the surface.

## Verification

settings-controller specs cover the fence both ways (refusal with the named code, `forwardedWrite` allowing the write, describe truthfulness in all three postures, credential non-writability), request-facts specs pin header normalization, nesting, and concurrency, and the gateway stream spec proves upgrade facts reach a stream open. ui-settings, ui-settings-models, ui-settings-plugins, ui-settings-general, ui-permission-presets, ui-theme, and locale suites exercise the read-only postures. Snapshot policy: the recorded sessions replay on loopback, where describe values are unchanged, so no new recorded-session case is added; the fence is a value-semantics change on a non-loopback path the keyless harness cannot produce.

## Alternatives considered

**Pass an explicit `forwarded` parameter through every settings write.** Rejected: `describe` is one shared answer for all callers, so the client's writable truth would still need a second source, and the parameter would thread through every seam between the route and the controller.

**Let the gateway rewrite `describe`'s writable field.** Rejected: the gateway returning business results it does not own puts a transport layer inside the settings contract; the controller owns the endpoint list and the fence.

**Keep `/m` and add settings consistency to it too.** Rejected: the user reaches the host through the desktop shell; a second mobile rendering duplicated transport, theming, and pairing code for a surface nothing but habit kept alive.

## Consequences

- A phone paired over the tunnel sees the live settings document and can be granted write access by one `cordis.yml` field; without it, every write surfaces a named, greppable refusal instead of a silent no-op or an unauthenticated success.
- The request-facts channel is process-local by construction: a worker-thread or subprocess capability that re-dispatches a settings call loses the facts and lands on the desktop side. A future cross-process dispatch must forward the marker explicitly.
- The `/m` removal shrinks ui-remote to the desktop panel; `pnpm run bundle` emits one fewer artifact per client build, and the mobile-css-inline Agent Note's subject (the standalone mobile artifact) no longer exists — that note is retired with the directory.
- ui-settings tests and the shared client test stub default to `writable: true`; a spec that wants the read-only posture publishes it explicitly.
