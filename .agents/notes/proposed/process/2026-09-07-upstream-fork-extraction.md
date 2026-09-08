# Agent Note: Extract the fork's upstreamable changes through rebased, conflict-resolved PR branches

Status: proposed

English | [中文](2026-09-07-upstream-fork-extraction.zh.md)

## Problem

`dev-workspace` carries roughly 85 fork commits over 452 files since the last upstream merge base, and the two sides co-evolved: upstream shipped 0.1.2-rc.1 through 0.1.3-alpha.1 while the fork built the remote stack, mobile UI work, and session pinning. Fork and upstream edits now overlap in the same regions, so fork changes cannot be proposed upstream by cherry-picking. A trial extraction of the reasoning-effort commit (`87e95da357`) three-way-merges with conflicts in `packages/core/agent-loop/src/agent.ts` because upstream's v2 embedded-assistant-streams refactor (2026-09-01) rewrote the same region the degradation retry patched; the web-transport commit (`2ccf8bd2c0`) conflicts in the web-app patch row and docs pairing. Without an explicit strategy the fork permanently carries a ~3.1k-line client-UI merge surface plus seam-owner diffs.

## Proposal

Extract in five ordered steps, each a branch off `upstream/master` verified by its own focused tests before any PR is opened. The recipe that surfaced the conflict inventory below: branch from `upstream/master`, apply the commit's own diff (`git diff <commit>^ <commit> -- <paths> | git apply -3`) scoped to upstreamable paths only, resolve, run the touched packages' tests and the doc gates.

1. **LLM effort normalization + loop degradation (re-implementation).** Port `87e95da357`'s intent onto the v2 embedded-streams loop: re-home the last-resort effort-degradation retry (`isEffortRejection`, `dropReasoningEffort`, one retry per step) into upstream's current request-failure path in `agent-loop/src/agent.ts`; the `llm/llm` `resolveCallConfig` normalization, `llm-pi-ai` canonical fallback, adapter tests, and the three feature notes re-apply with doc re-anchoring. Scope out: the fork's `ui-model-selection`/`ui-remote` presentation of degradation.
2. **Input-modality claims (selective paths).** From `ae6bd16f8d` take `packages/llm/**` and subsystem docs only; the Models-editor hunks wait for the client-UI extraction (step 4) because `ui-settings-models` is fork-diverged.
3. **Web transport optimization (single feature).** Cherry-pick `2ccf8bd2c0` (webserver compression `auto` + keep-alive, static-asset caching, service worker, transport downlink compression); conflicts are the web-app patch row context and docs pairing — resolve by restating the row from upstream's current text.
4. **Client-UI fixes (precursor first).** The mobile composer/popups/scrollport commits depend on the fork-new `ui-primitives` package; propose that package first, then rebase the fix commits (`8540d115f1`, `3694cf98b7`, `35069a5ead`, `ee1791f205`, …) onto it.
5. **Feature-level decisions, fork-local until accepted.** `session-pin` (plugin + `session/pin` format admission + pinned-first ordering) is proposed as one whole feature; the remote stack proposes only the wire-vocabulary forwarding extensibility, keeping the tunnel and pairing gate fork-local.

Fork-only debt blocks none of this but should land before the UI PRs: split `ui-remote` into host/client tsconfig faces (its host half type-imports a connection type owned only by connection's host face, so the client-face reference the face gate prescribes breaks the build with TS2878), and route the `/m` mobile surface's 56 hard-coded strings through the locale dictionaries.

## Alternatives considered

- **Keep everything fork-local forever.** The merge surface grows with every upstream release and the seam diffs (effort semantics, format admission) stay unmaintainable; rejected because most of the fork's value is generic.
- **Mechanical cherry-pick pipeline without conflict triage.** Tried in this session: produces branches that do not build or encode fork-side context upstream never had; rejected in favor of per-PR conflict resolution.
- **Carry a quilt of patches over upstream tags instead of branches.** Keeps the fork working but nothing becomes reviewable upstream; rejected because review is the point.

## Acceptance criteria

Each step ships as a branch where `pnpm run typecheck`, the touched packages' tests, and `pnpm run test:docs` pass against `upstream/master`; opened PRs keep CI green; after all steps, `git diff upstream/master...dev-workspace` shrinks to the composition bundle, not-yet-accepted feature work, and fork-only packages.

## Risks

Upstream may reshape or reject pieces (the effort-normalization semantics change a documented rejection behavior); the v2-stream port can drift from the fork's tested behavior, so the loop's recorded-snapshot lane must cover it; extraction work rots as upstream moves, so each step is timeboxed and re-based immediately before its PR.
