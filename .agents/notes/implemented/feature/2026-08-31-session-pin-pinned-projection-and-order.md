# Agent Note: Session pinning persists through the session log and orders list rows

Status: implemented

English | [中文](2026-08-31-session-pin-pinned-projection-and-order.zh.md)

## Problem

Session list surfaces ordered rows only by recency (`updatedAt = max(createdAt, lastPromptAt)`), so an important conversation kept sinking below newer activity. There was no durable, cross-device "keep this session on top" state: the workspace view store's manual order is browser-local, and the `updated` order mode promotes any newly active session over manual arrangements. A pin needed to survive restarts, replays, and device switches like titles do.

## Decision

**Pinning is a durable session-log attribute with a projection, following the `session/title` precedent.** A new `@deepseek-ai/dsh-session-pin` package owns the `session/pin` event (payload `{ pinned: boolean }`, log-only, never model-visible) and the `pinned` projection key whose value is `{ pinned: boolean, pinAt: number | null }`. `pinAt` is the event timestamp, giving the pinned group a deterministic order (newest pin first). The projection unit registers through `ctx.sessionProjections`, so cold sessions receive the pin state through the projection cache and the control stream pushes changes live, exactly like `title`.

**The host list sorts pinned rows first.** `ApiSessionList.list()` now orders: pinned rows by `pinAt` descending, then unpinned rows by `updatedAt` descending. `SessionSummary` carries optional `pinned`/`pinAt` mirrors of the projection so consumers that never read the projection block still order correctly.

**`session.setPin` is a Remote command.** `SessionController` exposes `@Remote('setPin')` delegating to `SessionCommandController.setPin()`, which appends the event through `ctx.sessionPin`. A deployment without the pin service maps to `pin-unavailable`; other failures map to `internal`. The client `ISession` face gains `setPin(pinned)`, which settles the `pinned` projection cell immediately on acceptance (higher-seq-wins replays the control frame harmlessly).

**The UI treats pin as a row-menu verb with its own section.** The sidebar session row menu gains 置顶会话/取消置顶 (Pin session/Unpin session); the action dispatches through the injected `pinSession` callback, mirroring archive's dialog-free, non-destructive posture. In workspace-grouped mode, pinned sessions leave their Workspace accounts for a leading **置顶 (Pinned)** section above every Workspace, ordered newest pin first with a browser-local drag order; the section defaults to expanded, shows no workspace actions, and its current session highlights independently. Flat mode (`deriveFlat`) keeps pinned rows at the top of the single list.

## Alternatives considered

**Browser-local pin store.** Rejected — a pin is a durable statement about the session, not a viewing preference; the local view store would lose it on device switch and the `updated` order mode would still promote over it.

**Registry-side pin set (like archive).** Rejected — archive is a UI-hiding concern outside the session log; a pin feeds host list ordering and must be reproducible from the log on replay, which only an event+projection provides.

**Reorder-pinning through `insertSessionBefore`.** Rejected — workspace accounts are per-workspace manual orders; a pin is global across lists and workspaces.

## Consequences

Pinning works across grouped and flat lists, cold and live sessions, and survives restart/replay/fork (a fork inherits its seed prefix's pin state). The event vocabulary regenerated (`known-event-types.ts`, `docs/persistence-catalog.md`). `pnpm run test:gui` covers the client suites and the new host specs cover the RPC and ordering.

## Testing

`pnpm vitest run packages/session/session-pin packages/api/session-controller packages/client/ui-workspace` (565 tests) plus `pnpm run test:gui`; new specs: `session-set-pin.host.spec.ts` (acceptance, pin-unavailable, internal mapping), `session-pin-order.host.spec.ts` (pinned-first sort via projection cache), `tree.client.spec.ts` pinned ordering, `rows.client.spec.tsx` pin/unpin menu dispatch. `pnpm run verify-persistence-catalog`, `verify-doc-graphs`, and the README gates pass.

## Related

- [Log-backed session titles and the title projection precedent](../../../../packages/session/session-title/README.md) — the event+projection pattern `session-pin` follows.
