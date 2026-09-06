# Agent Note: Generated-artifact merge script for the dev-workspace fork

Status: implemented

English | [中文](2026-09-04-generated-artifact-merge-script.zh.md)

## Problem

The `dev-workspace` branch merges `upstream/master` every one to three days. Upstream's highest-churn files are generator-owned artifacts — the doc catalogs, the module graph, `tsconfig.base.json`'s generated alias region, generated `api-catalog.ts` sources, `pnpm-lock.yaml`, and `THIRD_PARTY_NOTICES.md` — while the fork's highest-value changes live in its own packages. Every merge therefore spent the most time hand-resolving conflicts on files that no human intends to author, and a single stale resolution (an alias or lockfile entry dropped while picking a side) surfaced later as a build or install failure.

## Decision

`scripts/merge-upstream.sh` resolves the generator-owned artifact set mechanically and never hand-writable content:

- Start phase: run `git merge --no-ff --no-commit <ref>` (default `upstream/master`), then for every conflict on a generated artifact (the catalog and graph documents, the `cordis-api` pages, `apps/cli/composition.md`, the generated TS catalogs, `known-event-types.ts`, `pnpm-lock.yaml`, `THIRD_PARTY_NOTICES.md`), check out the merge ref's side. `pnpm install` and the `gen-*` generators rebuild whatever the ref's side under-specifies for the fork.
- `tsconfig.base.json` gets the ref's side, then the script re-injects the fork's hand-written alias block above the `BEGIN generated package aliases` marker. The generator emits no `src/*` wildcard and skips packages whose declared name differs from their directory, so `@deepseek-ai/dsh-mcp-client/src/*` and the `dsh-client-ui-remote` entries cannot be regenerated. `--finish` re-injects idempotently (sentinel comment) because a conflict-free merge takes the ref's file verbatim.
- Pairing-record conflicts (`*.i18n.yaml`) go through `pnpm run resolve-translation-pairing-conflicts`; the `dsh-translation-pairing` merge driver ([the automatic pairing note](2026-08-08-automatic-translation-pairing-merges.md)) already resolves most of them inside `git merge` itself.
- Every remaining unmerged path is a hand-written conflict. The script prints it with a per-area hint (subsystem regions, session-controller/gateway drift, web tests, compiler faces, package manifests) and exits nonzero; the operator resolves them, then reruns with `--finish` to run `pnpm install`, every `gen-*` generator, verify fork aliases survived, stage, and report translation pairs needing re-pairing. The script never commits and never aborts a merge.

## Verification

The script was exercised on throwaway branches against real upstream refs: the up-to-date short circuit, an unknown ref, a conflict-free behind merge (generated artifacts auto-resolved, alias block re-injected, all generators ran, untracked comparison stayed locale-stable), and a `--finish` rerun on a merge whose only conflict was a hand-written doc (manual queue printed with hints, regeneration and pairing report identical across reruns).

## Alternatives considered

**Keep resolving generated files by hand.** Preserves full manual judgment but spends merge time on files whose content no human authors and re-introduces the stale-pick failures the script makes impossible.

**A custom git merge driver per generated file.** Driver commands live in worktree-local config like the pairing driver and would not cover the regeneration half (the ref's side is stale for fork packages until `pnpm install` + `gen-*` run), so the wrapper script is still needed; drivers would add a second mechanism without removing it.

**Rely on `git rerere` alone.** Rerere replays recorded conflict resolutions, but each merge's generated artifacts differ wholesale (regenerated content, new catalog entries), so recorded hunks rarely match; rerere stays enabled as a complement for the recurring hand-written conflicts.

## Consequences

Merges spend human time only on the genuinely hand-written drift — currently the session-controller/gateway Session API adaptations, subsystem prose, web tests, and package manifests — and the mechanical files resolve in one command. The cost is a second artifact set to maintain: the script's generated-artifact list and fork alias block must be extended when a new generator, output path, or hand-written alias appears; a stale list fails safe (the file lands in the manual queue or the alias check dies loudly), never silently.
