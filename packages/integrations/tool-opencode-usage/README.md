# @deepseek-ai/dsh-tool-opencode-usage

English | [中文](README.zh.md)

The model-facing `opencode_usage` tool: queries the OpenCode Go subscription usage — the 5h rolling, weekly, and monthly windows with percent used and reset times.

## What it does

Registers one tool, `opencode_usage(mode?)`, on `ctx.tools` plus a short system-prompt guidance section. The tool queries OpenCode Go through one of two acquisition modes:

- **api-key**: `GET <baseUrl>/zen/go/v1/usage` with `Authorization: Bearer <apiKey>`, parsed from the `{ usage: { rolling, weekly, monthly } }` response.
- **web**: `GET <baseUrl>/workspace/<workspaceId>/go` with the `auth` cookie, parsing the dashboard HTML — the SolidJS SSR hydration payload first, then the `data-slot` format, with human-readable countdowns ("1 hour 56 minutes") resolved against the request clock.

`mode` defaults to `auto`: the api-key acquisition wins when a key resolves, otherwise the dashboard scrape runs. The canonical result reports the used mode and the three windows; a window the response omits or reports as non-`ok` stays `null`.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Register the tool. |
| `mode` | `auto` | `api-key`, `web`, or `auto`. |
| `apiKey` | — | Explicit OpenCode Go api key. |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | Environment variable holding the api key. |
| `readOpencodeAuth` | `true` | Fall back to the opencode runtime auth store. |
| `workspaceId` / `authCookie` | — | Dashboard-scrape credentials (config or `OPENCODE_GO_WORKSPACE_ID` / `OPENCODE_GO_AUTH_COOKIE` env). |
| `baseUrl` | `https://opencode.ai` | API origin; tests point this at a local stub. |
| `timeoutMs` | `15000` | Cooperative request timeout. |

### Credential resolution

The api key resolves through the explicit-precedence chain: `config.apiKey`, then `apiKeyEnv` from the environment, then — when `readOpencodeAuth` is enabled — the opencode runtime auth store at `<XDG_DATA_HOME|~/.local/share>/opencode/auth.json` (provider entry `opencode-go`). The auth store is a fallback, never a load-time failure: a missing, invalid, or entry-less store resolves to null and the tool fails at execution time with a message listing exactly which sources are missing. Dashboard credentials resolve from config, then from the `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE` environment variables (the opencode-quota ecosystem names, for drop-in reuse).

## Validation

The schema constrains `mode` to `auto`/\`api-key`/\`web`. `execute` rejects a missing credential for the selected mode, an HTTP non-2xx response (with the status and a sanitized snippet), an unparseable body, and a response with no usable window. A single broken window yields `null` rather than failing the query.

## Rendering

The canonical result is `{ mode, queriedAt, windows: { rolling, weekly, monthly } }`; the Native renderer formats one line per window ("5h rolling: 6% used (94% remaining), resets <ISO>"). The pending card is a generic search-kind card titled "Query OpenCode Go usage".

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`opencode_usage` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-opencode-usage).

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each assistant tool call carries the optional `mode` argument. Success returns the rendered window lines above. Stable failures are `no usable OpenCode Go credentials: set config apiKey, the OPENCODE_GO_API_KEY environment variable, or an 'opencode-go' entry in the opencode auth.json`, `mode '<mode>' needs credentials: ...`, `OpenCode Go usage API error <status>: <snippet>`, and `OpenCode Go usage API returned ...` parse failures. The request itself carries the bearer key or the auth cookie out to `baseUrl`; nothing is logged beyond the tool call and its canonical result.

#### Token effect

One call adds the tool call arguments (the optional `mode`), the canonical result, and the rendered window lines; the result is small and fixed-shape regardless of window count.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Dashboard format drift** — the web mode parses the current SSR and `data-slot` dashboard markup; a future markup change needs the two parsers updated together (the parsers are unit-covered with fixtures).
- **No quotaProviders ecosystem** — the package reads only the OpenCode Go sources above; openrouter and other subscription quotas remain out of scope.
- **Consumer-visible gap** — the tool cannot report usage for models billed per token through OpenCode Go (the subscription reports percentage windows only).
