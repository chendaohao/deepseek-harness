# Agent Note: opencode_usage — the OpenCode Go usage tool with dual acquisition

Status: implemented

English | [中文](2026-08-16-opencode-usage-tool.zh.md)

## Problem

The user's OpenCode Go subscription usage (5h rolling / weekly / monthly percentage windows) was only reachable through a manual `curl` against `https://opencode.ai/zen/go/v1/usage` with the api key from `~/.local/share/opencode/auth.json`. The established OpenCode-side quota plugin (opencode-quota) cannot report it: its OpenCode Go provider only supports browser-cookie dashboard scraping, and its OpenRouter provider rejects `limit_remaining: null` responses. The request was to make the usage query a first-party DeepSeek Harness tool plugin that covers BOTH acquisition scenarios — the api key and the web (cookie) query.

## Decision

**Add `@deepseek-ai/dsh-tool-opencode-usage` under a new `packages/integrations/` group, registering the `opencode_usage` tool with two acquisition modes and an explicit-precedence credential chain.**

- **api-key mode** — `GET <baseUrl>/zen/go/v1/usage` with `Authorization: Bearer <key>`; each window parses `{status, percent, resetsAt}`, a non-`ok`/invalid window becomes `null`, and a response with no usable window fails the call.
- **web mode** — `GET <baseUrl>/workspace/<workspaceId>/go` with `Cookie: auth=<cookie>`; parses the SolidJS SSR hydration payload first (both field orders), falls back to the `data-slot` format, and resolves human-readable countdowns against the request clock.
- **mode selection** — `auto` (default) prefers the api key and falls back to the dashboard scrape; a tool `mode` argument overrides config.
- **credential chain** — api key: `config.apiKey` → env `OPENCODE_GO_API_KEY` → the opencode runtime auth store (`<XDG_DATA_HOME|~/.local/share>/opencode/auth.json`, provider entry `opencode-go`, opt-out via `readOpencodeAuth`). Dashboard: config → env `OPENCODE_GO_WORKSPACE_ID` / `OPENCODE_GO_AUTH_COOKIE` (the opencode-quota ecosystem names). Missing credentials fail at execution time with a message listing the missing sources; the tool always stays visible (the tool-web precedent).
- **repo shape** — one package owning schemas, credential resolution, query modes, and presentation (the tool-todo precedent); no Service Definition / Provider / Consumer seam split (a single external-integration tool does not need a capability family). New group `integrations/` instead of `web/` because the web family is defined as search/fetch; the group container follows `packages/mcp`.
- **keyless snapshot** — a headless-agent scenario (`opencode-usage.cordis.snapshot.yml`) with a scripted mock LLM adapter (`opencode-usage-mock-llm.mjs`) that calls the tool once against a local stub server on a fixed port (39871); the persisted session is compared to `snapshots/opencode-usage/session.expected.jsonl` after normalizing the tool's live `queriedAt` to a sentinel (the goal-scenario normalization precedent). No opencode.ai traffic and no model key are needed at any point.

## Alternatives considered

- **Extending the parent-dir opencode-quota plugin with api-key support** — rejected: the user chose the in-repo package; the upstream provider also carries unrelated bugs (OpenRouter `null` validation) outside our control.
- **Putting the package under `packages/web/`** — rejected: the web group README defines the family as search/fetch operations; an external-subscription quota consumer is not web content retrieval.
- **Recording a real-model session for the snapshot** — rejected: the scripted adapter makes both record and replay keyless and deterministic; a real-model recording would need `DEEPSEEK_API_KEY` and churn on every transcript change.
- **Pointing the snapshot at a random stub port** — rejected: the committed scenario config must be stable across record and replay, so the port is fixed and documented in the test (collision risk is limited to concurrent snapshot runs).

## Consequences

- New group `packages/integrations/` appears in `packages/README.md`, the tsconfig.base.json wildcards, the tool catalog, and the module graph; the package follows every repo gate (bilingual README with Model Experience, invariant companion, 100% per-file coverage, HMR-safety and Loader composition tests, keyless snapshot).
- The `queriedAt` field is inherently time-varying, so the snapshot suite normalizes it; the canonical result keeps the honest acquisition timestamp rather than freezing it.
- The web-mode parsers are pinned to the current dashboard markup; format drift requires updating both parsers (fixture-covered).
- The tool reads the user's opencode auth.json by default, so a zero-config install works on machines that already log into OpenCode Go; the opt-out keeps CI and catalog harvest hermetic.
