# Agent Note: The /m mobile surface — a self-contained bundle over the platform protocol

Status: implemented

English | [中文](2026-08-18-mobile-surface-bundle.zh.md)

## Problem

Phone remote control needs a small-screen surface, but the desktop Web GUI is a cordis-plugin composition: every browser half is a `__ModuleLoader__` bundle that assumes the shell's module table and runtime are already mounted. A phone page cannot boot that shell, and squeezing the desktop UI into a phone viewport is a different product than the mobile control surface the pairing flow promises. The third-party plugin solved this with a parallel `/m/api` proxy and its own wire format — a second protocol the platform does not own.

## Decision

**`/m` is a standalone, self-bootstrapped React bundle that talks the platform protocol directly.** It is built in `@deepseek-ai/dsh-client-ui-remote` beside the desktop panel's plugin bundle:

- **Two tsdown outputs from one package**: `clientBundle(...)` emits the desktop panel's `lib/client.js`; a second config (`noExternal: () => true`, ESM, `clean: false`, the same `define` block) emits `lib/mobile.js` — react/react-dom inlined, no `__ModuleLoader__` banner, self-contained. The node half serves `/m` (document shell) and `/m/mobile.js` from `lib/`, gated by the same `enabled` row.
- **Platform protocol, no `/m/api`**: a thin hand-rolled wire layer calls `POST /api/<method>` with the standard `client-request`/`server-response` envelope (errors fold to a result union) and subscribes to the `/api/events.mux` WebSocket for `session/event` frames, degrading to `session.history` polling with backoff when the socket dies. The paired-device cookie authenticates the page with no extra channel.
- **Session-log discipline holds**: rendering derives only from `session.history` data and `session/event` frames; sends go through `session.prompt`; model changes through `session.selectModel`; titles through `session.rename`. The bundle holds no model-visible state of its own.
- **Three-level state machine** (workspaces → sessions → chat) with search, create-then-open, a model bottom sheet, and a CSS-variable light/dark toggle.

## Consequences

The wire layer is hand-rolled structural validation rather than inlining the host-apiproxy zod schemas (keeps the bundle zod-free and immune to host-only types); the host RPC map is the source of truth, so a method-shape drift fails the /m client loudly at parse time. `session.list` is consumed flat (host v1 returns no cursor). The bundle is rebuilt by the package's `bundle` script; the `/m` route answers 500 with a build hint when `lib/mobile.js` is absent.

## Alternatives considered

- **Reuse the full client-runtime in /m** — the standalone page has no cordis/shell module table; a thin wire layer is the smallest correct surface and keeps the bundle small.
- **Port the third-party's `/m/api` proxy** — a second protocol the platform does not own duplicates the RPC map and bypasses the trust fence; the platform unary + events.mux already cover every method /m needs.
