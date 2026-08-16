# @deepseek-ai/dsh-mobile-app

English | [中文](README.zh.md)

The DSH mobile voice app: a native Expo (React Native) client that pairs with a DSH host through the [remote-access tunnel](../../packages/remote/README.md) and chats by voice — on-device speech recognition turns your words into prompts, replies stream live, and on-device speech synthesis reads them back. Everything runs through the existing pairing gate and /api protocol; no host-side plugin changes.

## Requirements

- A host running `dsh web --remote` with a configured model (the app is a relay; the agent runs on the host). The terminal prints the pairing URL and QR code.
- A phone with Expo Go, or a development build (`npx expo run:android` / `npx expo run:ios`).
- Android speech recognition needs the Google app's speech services; iOS uses the system SFSpeechRecognizer.

## Run

```sh
pnpm install
pnpm build          # builds @deepseek-ai/dsh-client-mobile for Metro
cd apps/mobile
npx expo start      # scan the Expo QR with your phone
```

Then scan the host's pairing QR (or paste the `https://…/pair/<ticket>` URL) and talk.

## Build an installable APK on GitHub Actions

The repository ships `.github/workflows/mobile-android-build.yml`: run it from the Actions tab (branch input, default `master`). It checks out the workspace, installs with the frozen lockfile, builds every `lib/` output the app imports (`pnpm run build:lib` — `dsh-client-mobile` and its host-side dependencies resolve through `lib/`), generates the native Android project (`expo prebuild`), and assembles the release-variant APK, which the workflow uploads as an artifact. The release variant is required: RN's Gradle plugin bundles the JS only for non-debuggable variants, so a debug APK would need a reachable Metro; the Expo-generated template signs the release variant with the platform debug keystore, so no secrets are needed.

On the phone (tested on MIUI 14 / Android 12):

1. Open the run's artifact page and download the `dsh-mobile-app` artifact (or enable USB debugging and run `adb install -r app-release.apk`).
2. Open the APK in the file manager; MIUI asks once to allow installs from that source ("安装未知应用").
3. Start the host with `pnpm dsh web --remote`, scan the printed QR with the app, and talk.

The APK is signed with the platform debug keystore, so it installs side by side with Expo Go and needs no signing secrets; the generated template keeps minification off by default.

## Voice UX

- Press and hold the microphone to talk; release to send. While the agent works the mic key becomes an explicit stop button (stops speech and cancels the turn).
- Continuous listening (auto-start the mic after each reply) is a settings toggle.
- Replies stream into the chat and are spoken sentence by sentence; code blocks are never read aloud. Replies render as Markdown — block code carries a language label and a copy button — and tool activity appears as expandable inline rows showing the command or file being worked on, with one-tap command copy in the expanded detail.
- The empty conversation is a hero with starter prompts; the list auto-scrolls only while you sit near the bottom, and a back-to-bottom button appears once you scroll up.
- Send images from the camera or gallery; the agent sees them together with the text, and the message row renders the images. Long-press any message to copy or share it.
- The header shows the current session's title and connection state; the sessions drawer lists host sessions with title, workspace folder, age, and running state — switch or create one there.
- Approvals show the model's justification and the gated command; agent questions support multi-select and option descriptions; plan-mode banners and a collapsible todo checklist render as inline panels.
- Settings pick the session's model, recognition/reading language, TTS rate and pitch, auto-speak, and auto-listen, and show the paired host.
- UI copy follows the device language (中文/English); dark mode follows the system theme; the layout respects notch safe areas; the app icon is the DeepSeek whale mark on black.

## Checks

`pnpm --filter @deepseek-ai/dsh-mobile-app typecheck` runs the app's own strict `tsc --noEmit`; the repository's oxlint/coverage gates exclude this native-toolchain app by design (its logic lives under [packages/client/mobile](../../packages/client/mobile/README.md) with full coverage).

## Known Limitations

- **Pairing cookie lives in the device keychain** — the host's sliding 30-day inactivity window and day-scoped ticket semantics apply: a device unused for 30 consecutive days auto-unbinds (any use refreshes the window), and after `--remote-reset` scan a fresh QR. Pairing sends the phone's model name so the host's Settings → Remote Access page lists it by name.
- **No push notifications** — a finished turn only alerts in-app; delivery needs FCM plus host-side webhook cooperation and is deferred.
- **Image rendering loads per attachment** — message images download through the host's attachment round trip, cached per attachment id.
- **Speech engines are the platform's own** — quality and availability vary by device and system language packs; no server-side ASR/TTS yet.
- **expo-speech-recognition tracks Expo SDK 56** while the app is on SDK 57 (the module declares loose peers); watch for the SDK 57 release.
