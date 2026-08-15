# Agent Note: Mobile chat UI aligned with the Web GUI

Status: implemented

English | [中文](2026-08-16-mobile-chat-ui-web-alignment.zh.md)

## Problem

The DSH voice app's chat screen lagged the Web GUI (the original app decision lives in the [mobile voice app note](2026-08-14-mobile-voice-app.md)): replies rendered as plain text without Markdown, tool activity appeared as a detached horizontal chip strip, the input area split attention between a large mic ball and a separate send button, the palette was hardcoded light-only, and the app shipped the Expo default icon.

## Decision

**Align the mobile conversation UI with the Web GUI's information architecture while keeping the /api protocol untouched.**

- **Client projection extension** (`packages/client/mobile`): `ChatMessage` variants carry the event `seq`; `ToolStatusLine` became a rich row with `status` (`running`/`done`/`error`), raw `argumentsText`, and a result `resultSummary` bounded at 300 characters (first text block, nested tool-result blocks recursed). History replay and live folding share the same code path; the wire vocabulary is unchanged.
- **ChatScreen rebuild** (`apps/mobile`): Markdown rendering through `react-native-marked` + `react-native-svg` via the `useMarkdown` hook (no nested FlatList inside bubbles); tool rows render inline in the conversation flow ordered by message/tool `seq`; the composer is a single input bar with an embedded voice key and a send button that appears with draft content; approval/question cards and the settings sheet consume a tokenized light/dark palette that follows the system scheme; mic presses give haptic feedback; the keyboard avoids the composer on iOS.
- **App icon**: the DeepSeek whale mark (extracted from the site favicon) recolored white on a black rounded tile, plus an adaptive foreground; wired into `app.json`.
- **Delivery**: unchanged — the release-variant GitHub Actions workflow builds the installable APK.

## Alternatives considered

- **`react-native-markdown-display` / fork** — rejected: unmaintained or lagging; `react-native-marked` declares RN ≥ 0.76 peer support and is actively maintained.
- **Markdown via the library's FlatList component** — rejected: a virtualized list nested inside chat bubbles misbehaves; the `useMarkdown` hook yields plain element arrays.
- **Host-side protocol changes** — rejected: the session events already carry arguments, result content, and error identity; only the mobile projection was dropping them.

## Consequences

- The /api protocol and the host surface are untouched; the projection now surfaces arguments, result summaries, and error status the web already had, so tool rows can grow web-style detail without further wire changes.
- Seq-bearing messages and tool lines are public view vocabulary: the app merges them into one timeline, so changing the seq contract changes the view types.
- `react-native-marked` and `react-native-svg` are new app dependencies (Expo SDK 57 matched versions); markdown renders through the `useMarkdown` hook so bubbles never nest a virtualized list.
- Result summaries are bounded at 300 characters; raw arguments stay exactly as the model produced them.
- Dark mode follows the system scheme; both palettes live in one theme module.
