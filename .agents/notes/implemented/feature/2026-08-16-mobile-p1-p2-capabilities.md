# Agent Note: Mobile app P1/P2 — attachments, voice UX, sessions, models, plan/todo

Status: implemented

English | [中文](2026-08-16-mobile-p1-p2-capabilities.zh.md)

## Problem

The UI-alignment pass ([mobile chat UI note](2026-08-16-mobile-chat-ui-web-alignment.md)) closed the visual gap, but the app still lacked the capability surface: no image input, no hands-free loop, no way to switch sessions or models, and no visibility into plan mode or todos. The question was whether the /api protocol could carry all of it without host-side changes.

## Decision

**Everything except push notifications rides the existing /api protocol; the mobile projection and the Expo shell grew the capability surface.**

- **Image attachments.** `session.prompt` already accepts image content parts (canonical base64; the host validates, saves, and echoes durable `ImageAttachmentRef`s). `submitContent(parts)` sends text+image prompts without the text-only optimistic echo; the live `user/message` echo projects image refs onto the message row, and `downloadImage` fetches them through `session.attachment` as data URIs (cached by attachment id in the app). The composer gains a picker (camera/gallery via expo-image-picker + expo-image-manipulator, JPEG ≤1600px).
- **Voice UX.** Hold-to-talk on the mic (press to listen, release to send) plus tap-to-barge-in; continuous listening (`autoListen`) restarts the mic after each finished turn unless an approval/question is pending or speech is still active; TTS rate and pitch (0.5..2.0, clamped) flow through the speaker port to expo-speech.
- **Sessions.** `sessions.list` / `sessions.create` + a new `switchSession` that resets the view and restarts the stream (the history refetch rebuilds the new session); a header button opens the sessions sheet (a titled drawer since the [ergonomics pass](2026-08-16-mobile-ui-ergonomics-pass.md)).
- **Model selection.** `session.models` (catalog + `current`) and `session.selectModel`; the settings sheet lists the session's models and remembers the last selection in memory.
- **Plan/todo panels.** The client folds `plan/mode` (typed via the plan-mode package's SessionEventMap augmentation) and `todo/write` into the snapshot; the UI renders a plan banner and a todo panel.
- **i18n.** A small zh/en dictionary (`useI18n`, expo-localization `useLocales`) replaces every hardcoded string in the pair and chat screens; quick prompt chips come from the same dictionary.
- **Deferred: push notifications** — delivery needs FCM plus host-side webhook cooperation through the tunnel; documented as a known limitation.

## Alternatives considered

- **Host-side protocol extensions** — rejected: every needed RPC already existed (`sessions.attachment`, `session.models`, `session.selectModel`, `plan/mode`, `todo/write`); only the projection dropped them.
- **Local-only sessions** — rejected: switching must rebuild history from the host; `switchSession` reuses the existing history/watermark machinery.
- **react-native-slider for rate/pitch** — rejected: stepper buttons keep the dependency surface small.

## Consequences

- The public view vocabulary grew (`SessionSummary`, `ModelOption`, `TodoItemView`, `PromptPart`, speaker rate/pitch); `SpeechSpeakerPort.speak` changed signature and its callers were updated together.
- Image prompts deliberately skip the optimistic echo: the user message row appears when the host echoes it (no local refs to dedupe by).
- Plan-mode typing requires the plan-mode package's augmentation: `dsh-client-mobile` depends on `dsh-plan-mode` (type-only) and `dsh-attachment` (types).
- The 100% coverage gate covers every new branch (image failure paths, session/model failures, guards).
