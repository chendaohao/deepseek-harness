# Agent Note: Publish the Crew formation in dependency order

Status: proposed

English | [中文](2026-11-10-publish-the-crew-formation.zh.md)

## Problem

The Crew formation is a working feature of this fork — four presets, session-scoped per-role model routes, a per-turn run budget, and a structured `crew_git` tool — and it is invisible to anyone installing from npm. `@deepseek-ai/dsh-crew` is not on the registry, and the layers under it are fork-only in ways the bundle's own manifest does not show.

Three plausible explanations for that were measured and are all wrong, which is why this note exists: each one produces a shipping plan that fails at boot.

| Assumption | Measurement |
|---|---|
| "`preset-tool-mask` is unpublished, so replace it with `toolFilter`" | `toolFilter` is refused by the delegation tool: `packages/subagent/tool-subagent/src/index.ts:188` throws `no longer supported`, and published `0.2.2-rc.1` carries the same throw. The mask is also on `origin/master`, so it is not the blocker. |
| "Competitors narrow per-role tools with `toolFilter`" | `dsh-swarm-orchestrator@0.6.34` passes `toolFilter` through a programmatic `subagents.start()` call. The `composition.toolFilter` path it also reaches applies only on cold resume (`manager.ts:1449`); a fresh child is created with `composition: { agentPreset: spec.agentPreset }` (`manager.ts:393`). |
| "The three `dsh-tool-subagent/*` subpaths can move upstream in an afternoon" | They copy and compile, but only against this fork's `dsh-settings`. `route-settings-registry.ts` imports `SettingsWriteGuardRegistration` and calls `settingsService.guard(...)`; upstream has neither — `git show upstream/master:packages/settings/settings/src/index.ts` has zero occurrences of `guard`. |

## Proposal

Publish in this order. Each layer must ship before the one below it, because a consumer published first installs and then fails at boot, which is worse than not publishing.

1. **`dsh-settings` namespace write guards.** `SettingsWriteGuard`, `SettingsWriteGuardRegistration`, `SettingsWriteRefusedError`, `SettingsForms.guard(ns, guard)`, the `writeRefusal` descriptor field, and the refusal-republish path: 41 of the 132 added lines on `packages/settings/settings/src/index.ts`. This is a general capability — any namespace whose writes its registrant must veto needs it — and the only layer with no fork-specific vocabulary in it. It is worth landing whether or not the Crew ships, because its absence forces every fork to fork `dsh-settings`.
2. **`dsh-tool-subagent` route settings.** The five `worker-route-*` / `route-settings-registry` / `route-presets` modules (375 lines, plus 1,142 lines of tests) and the `routeSettingsNamespace` / `roleDescription` fields on the delegation row. The five are module-internal — nothing imports `index.ts` back — so they move as a unit, but `index.ts` keeps the 17 wiring sites that read the namespace.
3. **`dsh-agent-preset-registry` `userSelectable`.** 88 lines across four packages, and the only mechanism that keeps a role preset out of the picker while still letting `tool-subagent` mount it by id. Without it a published Crew offers `crew-worker`, `crew-planner`, and `crew-reviewer` as session types that cannot work.
4. **`dsh-preset-tool-mask`.** 175 lines depending only on `dsh-scope` and `dsh-tools`, both published. The cheapest of the four and it blocks nothing.
5. **`dsh-crew`.** Nothing in its manifest marks it fork-only; every `@deepseek-ai/dsh-*` dependency resolves to an upstream package. It is unpublished only because its three subpath imports do not exist in the published `dsh-tool-subagent`.

### Verification before starting

`npm i @deepseek-ai/dsh-crew@0.2.2-rc.1` in an empty directory returns E404 on this machine. Re-run that first when the work starts: a published `dsh-crew` would make steps 1–4 unnecessary.

## Alternatives considered

**Publish `dsh-crew` with the fork's `master` as its dependency range.** The bundle would resolve against this fork's published packages, which are not on the registry either; a consumer would have to add the fork as a registry to install it.

**Inline the five route modules into `dsh-crew`.** It removes the `dsh-tool-subagent` subpath exports from the chain, but `route-settings-registry.ts` still needs `settings.guard()`, so step 1 remains, and the crew bundle would then own code the delegation tool also reads.

**Drop `userSelectable` and list only the commander in the preset template.** Fewer upstream changes, but a session that names a role preset directly would fail later rather than at creation, and the roster would still offer the roles once a deployment mounts the bundle.

**Skip publication and keep the bundle as a local path.** What happens today. It costs nothing and serves the one deployment this fork exists for; the note records the price of changing that, not a demand to.

## Acceptance criteria

- A clean `npm i @deepseek-ai/dsh-crew@<version>` in an empty directory installs, and `dsh` boots a profile that selects the bundle with the commander preset available and the three role presets absent from the picker.
- The published `dsh-tool-subagent` exports `./worker-route-settings`, `./route-settings-registry`, and `./route-presets`, and its `Config` accepts `routeSettingsNamespace`.
- `packages/settings/settings` publishes `guard()`, and a namespace whose registered guard returns a reason rejects the write with `SettingsWriteRefusedError`.
- No fork-only package name appears in the published dependency graph of any published package.

## Risks

- **The chain is five deep.** A regression anywhere in it delays the Crew, and steps 1–3 are each large enough to need their own review.
- **Step 2 publishes an API this fork invented.** `routeSettingsNamespace` on the delegation row is a design one deployment has exercised; upstream review may prefer a different shape, and reshaping it after publication costs a breaking change.
- **Step 1 has no consumer upstream** until step 2 lands. Landing it alone adds a registration point nothing calls, which conflicts with the rule that an abstraction needs a current owner.
- **The Crew has one user.** Whether the four upstream changes pay for themselves is a product decision this note does not make.
