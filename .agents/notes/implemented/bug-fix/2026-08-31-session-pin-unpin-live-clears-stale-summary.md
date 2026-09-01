# Agent Note: unpin stays live in the sidebar only when the projection overrides the host summary

Status: implemented

English | [中文](2026-08-31-session-pin-unpin-live-clears-stale-summary.zh.md)

## Problem

After pinning a session, the sidebar kept showing it in the 置顶 (Pinned) section and hiding it from its Workspace group even after 取消置顶 (Unpin) — until a page refresh. The pin feature note claimed the control stream pushes projection changes live, but the unpin path never actually updated the row: the client list row's pin state is built by `SessionManager.buildListSnapshot()`, which spread the host list summary first and only *added* `pinned: true` when the projection said pinned. The host summary's `pinned`/`pinAt` fields are computed at list-pull time, so after a pin the row carried `pinned: true` from the last `session.list` response; an unpin projection frame updated the projection store, but the spread never removed the stale summary field. The row stayed pinned until the next list re-pull — the refresh the user was doing by hand. Because the stale row kept `pinned: true`, the workspace browser also kept filtering the session out of its Workspace account, so it vanished from both sections' natural location.

## Decision

In `SessionManager.buildListSnapshot()`, the `pinned` projection is now authoritative over the summary's own pin fields whenever the projection exists: when the projection is absent the summary keeps its fields; when present, the summary's `pinned`/`pinAt` are stripped first, then the projection's value is applied (pinned → `{ pinned: true, pinAt }`, unpinned → neither field). Absence remains the wire contract for unpinned, matching the host `pinFields()` output, so downstream consumers (`flattenLineage`, `projectList`, `groupByWorkspace`) need no change — a row unpinned through the control frame now drops out of the pinned set and returns to its Workspace account immediately, without a list re-pull.

## Verification

- New manager client spec `clears a stale host-summary pin when the unpin projection frame lands`: list pull returns `pinned: true, pinAt: 500`, then an unpin projection frame `{ pinned: false, pinAt: 600 }` lands — the row's `pinned` and `pinAt` are both cleared without a re-pull.
- `packages/api/session-controller` 423/423, `packages/client/ui-workspace` 149/149, session-pin + session-projection 42/42, connection fixture + client-runtime 72/72 — all pass.

## Alternatives considered

**Emit `pinned: false` on the row instead of absent.** Rejected — the wire contract (and every consumer) treats unpinned as *absence*: the host `pinFields()` omits both fields, `service.ts` maps only `pinned === true`, and `deriveGroups`/tree ranking read `pinned === true`. Introducing a new `false` row state would leak a second representation of unpinned through the list snapshot for no consumer.

## Consequences

Unpinning the last pinned session removes it from the Pinned section and restores it to its Workspace group in the same tick as the control frame, with no refresh and no list re-pull. The entry-cache comparison already covers `pinned`/`pinAt`, so the cleared fields invalidate the cached row.

## Related

- [Session pinning persists through the session log and orders list rows](../feature/2026-08-31-session-pin-pinned-projection-and-order.md) — the feature this fix completes; its claim that the control stream keeps the pin live is now true for the unpin direction too.
