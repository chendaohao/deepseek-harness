# Agent Note: The crew-route settings block follows the crew bundle

Status: implemented

English | [中文](2026-11-04-crew-route-settings-follow-the-bundle.zh.md)

## Problem

The Models page drew three route blocks — worker, planner, reviewer — for every web deployment. Each block edited one Host settings namespace, and `@deepseek-ai/dsh-web-app` inserted all three namespace rows unconditionally. But those settings are read only by `@deepseek-ai/dsh-crew`'s delegation rows: a deployment that never selected the crew bundle served three settings nothing consumed, and a user who changed one saw no effect. The three blocks also repeated a title, an intro, and the same refused/conflict copy three times, and every control's accessible name was role-specific only by accident of having eight locale keys per role. Adding a fourth role meant a namespace constant, an injected field, a wrapper component, eight locale keys in eight languages, and a render site.

## Decision

The three `subagent-*-route-settings` rows live in `@deepseek-ai/dsh-crew`, not in `dsh-web-app`. Visibility is therefore a Host fact, not a client setting: a deployment serves a role's namespace only when it selects the crew bundle, and the client renders nothing for a namespace the Host does not serve.

The client needed no new gate. `ConfigFormController.derive()` already turns "the namespace is absent from the describe answer" into `status: 'unavailable'`, and the page renders nothing for such a form. What did change is what "nothing" means at block level: the page filters the role table against the namespaces its own snapshot carries, and the block returns `null` for an empty list — without that, a deployment with no crew bundle would keep the block's heading and intro over an empty row set.

`subagent-route-settings-registry` stays in `dsh-web-app`. It is the generic service a deployment mounts its own role rows against, and the v0.2.2-alpha.2 migration path tells operators to mount such rows themselves; moving the registry would have broken every one of those profiles. The crew bundle already must be selected after `dsh-web-app`, so its rows resolve the registry regardless.

One table, `CREW_ROLES` in `packages/client/ui-settings-models/src/client/crew-routes.ts`, names every role with its namespace and its role-name locale key. The page derives its injected `crewRoutes` handles and its rows from it, so a fourth role is one table entry plus one locale key — on the client. A role also needs its Host row and its delegation row's `routeSettingsNamespace`, which is Host composition and stays out of the client's claim.

Copy collapses to one set of templates carrying a `{role}` placeholder rather than one set per role. The placeholder is what keeps three identical pickers apart: each control's accessible name is `{role} provider`, so the row is addressable by role in the DOM, by a screen reader, and by the browser e2e lane. Dropping the placeholder would have left three selects named "provider" on one page.

A provider change and a model change both strand the fields below them, so each edit writes the stranded fields in the same atomic `mutate()`: the new provider keeps a stored model it also advertises and otherwise takes its first catalog entry; the effort follows the resulting model's vocabulary, keeping an advertised level and falling back to that model's default otherwise. A provider or model the catalog does not describe keeps the stored value, because the picker shows it as a fallback option and the catalog cannot name a better one. The row says so in its own status line when the edit reset a field.

## Alternatives considered

**Gate the blocks on `ConfigForms.whileServed`.** The blocks would then have followed the served namespaces from the client, with no Host change. `whileServed` is `some`-semantics over its namespace list and calls its `register` callback once, so it can express "any of these is served" but not per-role visibility, and capturing the served set at registration time gives a stale snapshot. It also fixes the wrong half of the defect: the rows would still be served to deployments that cannot use them.

**Move the routes out of the Models page into a Plugins page.** `ui-settings-subagent` already does this for its own page, and it removes the growth of `ModelsSectionInjected` entirely. Rejected because it splits "choose a model" across two entry points; the route is a model choice, and the Models page is where a user looks for it.

**Merge the three Host namespaces into one.** `verify-cordis-config` requires each route-settings entry id to equal its `config.namespace`, and the durable `subagent/worker-route` marker names a namespace; one shared namespace would let a planner child resolve the worker route. The three rows stay separate.

## Consequences

A deployment upgrading from a profile that mounted one of these rows itself now has two rows for the same namespace and fails to compose with `namespace "…" is already registered by another route-settings row`. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.3/crew-route-settings-rows/guide.md) records the migration.

`apps/cli/tests/web-agent-presets.e2e.ts` asserts both directions: the shipped web surface serves none of the three namespaces, and a profile that selects the crew bundle serves all three with their composition bases. `apps/web/tests/crew-routes.e2e.ts` proves the browser half against the real profile — three rows in one block, and a provider change that carries its model along.
