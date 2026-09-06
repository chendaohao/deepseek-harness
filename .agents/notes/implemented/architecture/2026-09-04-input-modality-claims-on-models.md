# Agent Note: Input-modality claims on discovered and hand-declared models

Status: implemented

English | [中文](2026-09-04-input-modality-claims-on-models.zh.md)

## Problem

A hand-declared pi-ai model without an `input` field resolves to the route's `defaultInput` (`['text']`), so sending an image to a vision-capable third-party model — the trigger being `glm-5.3-flash` behind a gateway — was rejected with `MODEL_DOES_NOT_SUPPORT_IMAGES` before the request left the harness. Neither of the two paths that could have known better disclosed modalities: model discovery parsed only ids, names, and capacities from listing replies, and the Models page offered no editor for the `input` field at all. The only fix was editing `settings.yaml` by hand.

## Decision

`LlmDiscoveredModel` carries `input?: readonly ('text' | 'image')[]`, and the deduplication rebuild in `dsh-llm`'s `discoverModels` passes it through unchanged. `dsh-llm-pi-ai` reads two listing spellings — OpenAI-style top-level `modalities` and OpenRouter's `architecture.input_modalities` — and the installed-catalog route forwards each catalog entry's own `input`. Unrecognized modality terms (`audio`, `video`, `file`) are dropped individually, so one exotic term beside `text` does not erase the text fact; an entry naming no recognized term ships no `input` field, which reads as "the endpoint said nothing usable" and lets inheritance decide.

The Models page adopts a candidate's modalities into the editable row, badges candidates that declare images in the picker, and edits the claim per row behind the capacities fold: checking **Images** stores `input: ['text', 'image']`, unchecking leaves an explicit text-only `input: ['text']`, and a row with no `input` field inherits. The shared validator rejects a stored `input` that is not a string list or that omits `text` — a list without `text` cannot name a usable model, and the rejection names the row instead of letting the loader refuse the section.

The claim remains what the `llm-pi-ai` config schema already defined: an assertion about the endpoint, not a check of it. An endpoint that refuses images despite the claim still fails mid-turn, at the provider.

## Alternatives considered

**Treat unchecking Images as removing the field.** That would make the checkbox switch between "declares text-only" and "inherits", but the two states are not adjacent facts a user reasons about together — inheritance is a catalog-level property, and the only visible signal would be a checkbox that silently stops meaning anything. An explicit `['text']` from unchecking says exactly what the user expressed.

**Drop unknown modality terms only when nothing recognized remains.** Keeping `['text', 'image', 'audio']` as-is would forward a value the pi-ai schema (`MODALITIES`) rejects, failing the section at load; filtering per term is the only spelling that preserves known facts without inventing schema surface.

**Expose audio/video now.** No harness adapter serves them, and a schema surface without a consumer is speculative configuration.

**Edit DeepSeek-catalog modalities too.** The direct DeepSeek adapter's catalog is validated against its own fixed schema, and its official models' modalities are not deployment choices; an editor there would advertise a knob with no meaningful value.

## Consequences

Vision-capable gateway models become image-usable from the Models page: fetch, badge, adopt, or tick one checkbox. Listings that name no modality keep today's behavior — the row inherits, and a text-only verdict from an uninformative endpoint still requires the YAML `input` field. The validator's shape check can reject hand-edited values the schema would also reject; the page reports them per row either way.
