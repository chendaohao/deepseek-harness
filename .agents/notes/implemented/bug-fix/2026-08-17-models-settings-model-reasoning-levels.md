# Agent Note: Custom pi-ai model rows declare their reasoning levels in the Models settings

Status: implemented

English | [中文](2026-08-17-models-settings-model-reasoning-levels.zh.md)

## Problem

The Models settings page could not configure reasoning levels for custom providers. The pi-ai adapter has supported per-model `reasoningEfforts` since its per-model reasoning work, but the settings UI's model rows only edited `id`/`name`/`contextWindow`/`maxTokens`. A provider declared through 添加自定义提供方 therefore had to be configured in `settings.yaml` to offer any thinking level; the composer's picker only ever saw the adapter default for such models. A provider-scoped effort control had been deliberately removed earlier because effort is a per-model capability and models under one provider disagree about levels — but the per-model place to set it was never surfaced.

## Decision

Each pi-ai model row's expanded area gains a reasoning declaration editor with three modes:

- **Inherit** (default): no `reasoningEfforts` field is written. A hand-declared model does not reason; a catalog model keeps its catalog capability.
- **No reasoning**: stores `false`.
- **Custom levels**: assembles a dict of offered levels. Checking a level writes it (fresh levels spell their wire value as themselves, editable per gateway); `off` may stay empty — stored as `null`, meaning "supported, send nothing" — while every other declared level needs a non-empty wire value.

The level vocabulary is read out of the owning namespace's schema (the same schema read `protocolChoices` makes, on the dict's `sKey` union), so the offered levels cannot drift from the ones `resolveModelReasoning` accepts. The same per-row checks gate the save: a declaration must offer at least one level beyond `off`, and every declared level except `off` must name its wire value. The `ModelListEditor` is shared by the custom-provider create card and the provider editor, so both surfaces gain the control together; catalog (shipped) pi-ai routes editing their model list get it too.

## Alternatives considered

- **Reintroduce a provider-scoped effort control.** Rejected: the earlier removal reason stands — a provider-level value would be refused by some models and hide the whole provider from the picker behind one error row.
- **Hard-code the level vocabulary in the client.** Rejected: the adapter's `Config` is the authority; a schema read keeps the UI and the adapter from drifting, matching the existing `protocolChoices` pattern.

## Consequences

A custom provider's models can declare selectable thinking levels from the Models settings page, and the composer's effort pane offers exactly the declared levels (with their wire spellings) for those models. The `reasoningEfforts` field remains adapter-owned and per-model; only the editing surface is new. DeepSeek-family model rows are unchanged because `llm-deepseek` has no per-model reasoning field — its thinking/effort settings are connection-level.
