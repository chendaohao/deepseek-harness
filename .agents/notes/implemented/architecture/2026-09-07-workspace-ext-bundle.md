# Agent Note: The web profile's fork-local rows compose in the dsh-workspace-ext bundle

Status: implemented

English | [中文](2026-09-07-workspace-ext-bundle.zh.md)

## Problem

The fork mounted its session-pin and remote-access plugins directly inside the shipped `dsh-base` and `dsh-web-app` patch files and their dependency lists. Every upstream bundle edit therefore carried merge surface unrelated to upstream behavior, and the fork's composition intent was indistinguishable from rows upstream owns — a `git diff` against upstream mixed "what the fork adds" into "where upstream composes".

## Decision

A new patch-carrier bundle, `@deepseek-ai/dsh-workspace-ext` (`packages/bundle/workspace-ext`), owns the four fork-local rows — `session-pin`, `remote-tunnel`, `remote-access`, `client-ui-remote` — as one insert list, and the web profile template lists it after `dsh-web-app`, so its rows compose over the finished upstream tree. The bundle declares exactly the four mounted plugins as dependencies (verify-cordis-config requires the row names in the declaring manifest), and `apps/cli` depends on the bundle so the two-anchor resolution and the module-fallback mirror reach it. `dsh-base` and `dsh-web-app` return to their upstream content except two retained fork edits that ride planned upstream PRs: the webserver row's compression/keep-alive restatement, and the web startup flag family in `startup.ts` that the moved rows read through `ctx.webStartup` unchanged.

Product and test composition stay locked together: the keyless web e2e scaffold, the schedule-catalog roster check, the assembled-jsdom boot layers, and the windows-shell profile init stack the same third patch layer, while the agent-preset composition tests keep their own synthetic bundle list because they exercise preset mechanics, not the shipped template.

## Consequences

Deployments that already initialized a customized `web` profile must add `@deepseek-ai/dsh-workspace-ext` to their profile's `dsh.profile.bundles` once: `normalizeShippedProfile` rewrites only manifests still matching the shipped template tuple, so a profile that appended out-of-tree plugins keeps its own list, and its patch rows that override the moved rows fail loud until the bundle is listed. Future fork-local host rows belong in this bundle's insert list, never back in the shipped patches.

## Alternatives considered

- **A custom `$DSH_HOME` profile naming this bundle out-of-tree**: rejected — two-anchor resolution cannot reach an in-repo workspace bundle from a home profile without profile-local installs, and the snapshot manifest closes profile names to the shipped set, so a separate profile name would fork test composition from product.
- **Env-var gating now (`--remote` → `DSH_REMOTE`) to delete the `startup.ts` diff**: rejected for this move — the flag family moves upstream together with the webserver compression change; keeping the flags preserves the CLI surface and keeps the moved rows byte-identical.
- **Restating the webserver row's config from the ext bundle**: rejected — a later-layer id override replaces the targeted row's whole config and would shadow future upstream fields; the modification stays in `dsh-web-app` until upstreamed.
