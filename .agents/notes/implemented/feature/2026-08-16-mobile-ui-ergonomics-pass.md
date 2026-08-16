# Agent Note: Mobile app ergonomics pass — titles, approvals, scroll, and the icon set

Status: implemented

English | [中文](2026-08-16-mobile-ui-ergonomics-pass.zh.md)

## Problem

After the [P1/P2 capability pass](2026-08-16-mobile-p1-p2-capabilities.md) the app had the features but not the ergonomics: the session sheet showed raw `sessionId.slice(-8)` (the wire already carries the host-computed title), the approval card showed only a tool name (the frame carries the model's `reason` and the gated `callId`), multi-select questions answered on first tap with a single label, the conversation list forced `scrollToEnd` on every layout change so reading history fought the auto-scroll, header and paperclip controls were text glyphs (☰ ⚙ 📎 🎤), and neither screen handled notch safe areas. The desktop Web GUI already solved the information-design half of each of these (titled sidebar rows, an approval panel with justification + command, per-tool card previews, a back-to-bottom affordance).

## Decision

**Close the gap with view-projection extensions plus an app-side ergonomics pass; the /api protocol stays untouched.**

- **Projection passthrough** (`packages/client/mobile`): `SessionSummary` carries the host's `title` (from the list row's `projections.values.title`, typed via the session-title package's map augmentation — the same type-only dependency pattern the web runtime uses) and `cwd`; `PendingApproval` carries `reason` and `callId`; `PendingQuestionItem` carries `header`, `detail`, `multiSelect`, and option `description`s. Every field is already on the wire; the fold only stopped dropping them.
- **Approval card parity** (`apps/mobile`): warning strip + the model's justification as headline + the gated command joined from `callId` → `ToolStatusLine.argumentsText` (the same join the web `ApprovalPanel` performs, computed in the app so frame/call arrival order cannot matter). The controller's optimistic clear already gives one-shot button semantics; a transport failure restores the card.
- **Question card**: single-select answers on tap; multi-select toggles a local selection and submits it together. Option descriptions render under labels.
- **Scroll behavior**: `onScroll` tracks near-bottom; auto-scroll (both the snapshot effect and `onContentSizeChange`) stays armed only while near the bottom, and a back-to-bottom button appears once the user scrolls away. Sending a prompt re-arms the auto-scroll.
- **Session surface**: the header shows the current session's list title (refreshed per switch); the sessions drawer lists title, workspace folder basename, relative age, and a running dot, with create/switch actions.
- **Tool rows**: the first line previews the command or file being worked on (`command`/`file_path`/`path`/`pattern`/`query`, in that order, parsed from the arguments JSON); the expanded detail renders the command in a mono block with copy, key/value argument lines, and the bounded result summary. Status is a spinner/check/cross glyph, not text.
- **Icons and chrome**: the web `ic_ds_*` SVG set is ported verbatim to `react-native-svg` components (`src/components/Icon.tsx`) and replaces every text glyph; `react-native-safe-area-context` (new app dependency) drives header/composer insets; the mic key pulses while listening and turns into a stop key while the agent works; the pair screen adopts the theme and safe areas (it was hardcoded light).
- **Markdown code blocks**: a `react-native-marked` renderer override wraps block code with a language label and a copy button.

## Alternatives considered

- **Host-side changes for richer approvals** — rejected: the approval frame already carries `reason`/`callId`; the missing command was a join the app can do from tool rows it already folds.
- **Reading the title projection as an untyped record cast** — rejected: the session-title package's client-namespace augmentation gives the typed `title` key with zero runtime imports; a cast would restate the wire shape locally.
- **A bottom "unread" banner instead of back-to-bottom** — rejected: unread counts need read-tracking state the app has no home for; a single affordance covers the reading-history case.
- **Custom-drawn glyphs for every icon** — rejected: porting the web set verbatim keeps one visual language across the two clients and inherits the figma-sourced paths.
- **Slider controls for TTS rate/pitch** — kept the steppers from the prior pass: the dependency surface stays small.

## Consequences

- `dsh-client-mobile` depends on `dsh-session-title` type-only (client namespace), mirroring `dsh-plan-mode`; the tsconfig reference and package dependency follow the runtime's precedent.
- The new view fields are additive; the 100% coverage gate covers each branch (titled/untitled rows, reason/callId presence, multi-select projection).
- The header title is list-sourced and refreshed per switch: a title the host generates mid-session appears on the next drawer open or switch, not live (the `session/projection` push frame stays unfolded — noted as core known-limitation territory if live titles are ever wanted).
- The icon port is a one-time snapshot of the web set; new web icons need a manual re-port.
- Safe-area handling adds `react-native-safe-area-context` (Expo-pinned `~5.7.0`) as an app dependency; the core package stays React-free.
- Manual verification remains on-device (Expo); the repo's browser-GIF demo skill does not cover native apps.
