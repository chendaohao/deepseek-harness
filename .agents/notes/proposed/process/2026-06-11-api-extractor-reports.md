# Agent Note: API extractor reports

Status: proposed

English | [中文](2026-06-11-api-extractor-reports.zh.md)

> The doc-block-typechecking and event-taxonomy parts shipped ([doc-sync enforcement](../../archived/process/2026-06-11-doc-sync-enforcement.md)); this remaining API-report part is deferred as a standalone proposal until the conditions below make it worth building.

## Problem

Public API changes are invisible — nothing makes "this commit changed the public API" an explicit, reviewable fact. A reviewer reading a diff can miss that an exported type gained a field or a method signature shifted.

The [release family](../../../../scripts/release/families.ts) publishes every non-private `packages/*/*` and `apps/*` manifest to npm under one shared version. External consumers can therefore depend on `@deepseek-ai/dsh-*` entry points, and an accidental widening or signature shift reaches them as a version change rather than a review finding.

## Proposal

api-extractor (or `tsc --emitDeclarationOnly` + a normalized public-API dump) producing a checked-in `etc/<pkg>.api.md` per published package; CI fails if regeneration differs. Every public-API change becomes a diff line a reviewer (or review agent) must see.

Scope follows the release family's published set, not every workspace manifest: a package marked `private` publishes nothing, so it carries no report.

## Alternatives considered

**`tsc --emitDeclarationOnly` plus a normalized public-API dump** — the lighter mechanism if api-extractor proves too heavy; either satisfies the checked-in, diffable report shape the proposal needs.

**Extend the type-equivalence manifest.** [`verify-type-equiv`](../../../../scripts/verify-type-equiv.ts) already pins named declarations against source JSDoc, but it covers only symbols a document chooses to quote. Completeness, not accuracy, is the gap this proposal closes: a report per entry point lists every export, including the ones no page quotes.

**Include private packages.** A `private: true` manifest publishes nothing and has no external consumer, so an `etc/<pkg>.api.md` for it would add regeneration cost and diff noise without a reader.

## Acceptance criteria

- Every published package has a checked-in `etc/<pkg>.api.md`; CI fails when regeneration differs from the committed report.
- A public-API change (a new export, a widened field, a shifted signature) is visible as a report diff line in review.
- Private packages carry no report, and the scope check derives the published set from the release family rather than a hand-maintained list.

## Risks

The dependency is heavy and finicky, and the report format churns with compiler upgrades. Package count scales the regeneration cost: the family covers roughly 350 publishable packages, so a per-package report is the expensive shape and a per-entry-point report needs measurement before adoption.

The [pre-stable API policy](../../../../AGENTS.md) lets any public API change every consumer without a compatibility promise, so a report records breakage rather than preventing it. The proposal's value is review visibility alone.

## Reopen condition

The deferral rested on one premise: "the packages stay unpublished". That premise no longer holds. The [release family](../../../../scripts/release/families.ts) publishes `@deepseek-ai/dsh-*` to npm, so the surface this proposal makes visible is the surface external consumers install.

What the deferral got right is cost, not value. Report generation over roughly 350 publishable packages is expensive, and no measurement establishes that the churn is affordable yet. Implementation therefore starts with that measurement, not with adoption:

- Measure regeneration time and report diff size over the published set.
- If per-package reports prove too expensive, adopt the `tsc --emitDeclarationOnly` shape above or narrow the report to packages a released plugin actually imports.

The proposal stays proposed until that measurement exists. Publication alone does not prove the reports earn their maintenance cost; it removes the argument that there is no external surface to protect.
