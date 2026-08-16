# Agent Note: Anthropic model listings are discoverable

Status: implemented

English | [中文](2026-08-15-anthropic-model-listing-discovery.zh.md)

## Problem

The Models page's "fetch available models" action could only interrogate OpenAI-compatible protocols: `discoverModels` answered `DISCOVERY_UNSUPPORTED` for `anthropic-messages` even though pi-ai already serves that protocol for hand-declared routes. A Claude-protocol gateway or the official endpoint forced hand-entry of model ids that Anthropic's `GET /models` endpoint advertises, and the failure message did not name the working alternative.

## Decision

`dsh-llm-pi-ai` discovery now reads the Anthropic Messages listing: `GET {baseURL}/models?limit=100` with `x-api-key` and `anthropic-version: 2023-06-01` headers, following `has_more`/`last_id` pages up to a 20-page ceiling (2000 entries). The OpenAI protocols keep their single-page bearer behavior. The listable-protocol set became a per-protocol table (`ListingProtocol`: URL builder, headers, continuation cursor), and both families share the byte ceiling, the `data`-array parser (which already reads Anthropic's `id`/`display_name` entries), credential handling, and error mapping, including the 401/403 credential diagnostic and `ABORTED` cancellation semantics. A reply announcing more pages without a `last_id` fails rather than truncating silently.

## Alternatives considered

- **Read a single page without pagination.** Rejected: Anthropic's listing defaults to 20 entries, and truncating would silently omit models the user expected.
- **Probe Anthropic like OpenAI (bearer auth).** Rejected: Anthropic authenticates with `x-api-key`; a bearer probe would answer 401 and read as a credential problem.
- **Leave the protocol unreadable.** Rejected: the fetch action exists for gateways the catalog does not ship, and Anthropic's listing is as standard as OpenAI's.

## Consequences

Claude-protocol gateways and the official endpoint answer the fetch action with ids and display names (no capacities — adoption keeps whatever the endpoint discloses). The page ceiling only trips on a listing that paginates forever; a malformed continuation fails loud. The [draft-provider endpoint interrogation](../../implemented/architecture/2026-08-04-draft-provider-endpoint-interrogation.md) decision is unchanged: discovery is still advisory candidates, never a catalog refresh.
