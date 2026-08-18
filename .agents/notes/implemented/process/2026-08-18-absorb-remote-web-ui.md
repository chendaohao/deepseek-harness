# Agent Note: Absorbing @linxin666/dsh-remote-web-ui into the first-party remote family

Status: implemented

English | [中文](2026-08-18-absorb-remote-web-ui.zh.md)

## Problem

The web profile shipped the third-party plugin `@linxin666/dsh-remote-web-ui` for mobile remote control: an in-GUI panel (phone entry, QR, live status, device revocation) and a `/m` small-screen surface. It duplicated the first-party remote family's tunnel and pairing as a parallel implementation with its own `/m/api` protocol, and it bundled a one-click updater for the `@linxin666/dsh-web-ui` family. Two overlapping remote-control stacks ran side by side: one product-owned, one external.

## Decision

**Absorb the mobile remote-control capability as first-party `@deepseek-ai/dsh-client-ui-remote`, reusing the first-party tunnel and pairing gate; do not port the parallel infrastructure.** The host pairing gate gained a device model (one-time tokens, a revocable roster, a desktop-only `/remote/*` control plane); the desktop panel and the `/m` bundle are new first-party surfaces speaking the platform protocol (see the [device-model](../architecture/2026-08-18-remote-device-model.md) and [mobile-surface](../architecture/2026-08-18-mobile-surface-bundle.md) notes). The third-party's **remote-update feature is out of scope**: updating a third-party UI family is unrelated to remote access and stays with the vendor.

**Uninstalling `@linxin666/dsh-remote-web-ui` is a separate, user-confirmed step, not part of the feature PR.** It is pulled in transitively by the `@linxin666/dsh-web-ui-all` aggregator bundle, so removal means disabling the `remote-web-ui` row in the profile's user layer (`- disable: remote-web-ui` in `~/.dsh/profiles/web/cordis.patch.yml`), leaving the aggregator's other plugins (skins, ssh, pet, live-stats, …) untouched. The confirmation gate exists because the aggregator is external and the user owns that profile.

## Consequences

The third-party remains installed until the user approves its disablement; the first-party panel and `/m` surface already coexist with it in the profile. Its `api/gate` listener (for the LAN pairing fence) is currently a no-op — the platform has no `api/gate` event — so no behavior changes there. Keeping the feature's UX equivalent to the third-party's is the acceptance bar for the absorption.

## Alternatives considered

- **Make the third-party reuse first-party infrastructure** — retained the ownership split and two pairing stores; rejected because remote control is core to the product and the first-party already owns the tunnel and gate.
- **Uninstall immediately in the feature PR** — the aggregator is external and user-owned; forcing removal without confirmation would break the profile's other plugins or surprise the user.
