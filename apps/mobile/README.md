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

The repository ships `.github/workflows/mobile-android-build.yml`: run it from the Actions tab (branch input, default `master`). It checks out the workspace, installs with the frozen lockfile, builds every `lib/` output the app imports (`pnpm run build:lib` — `dsh-client-mobile` and its host-side dependencies resolve through `lib/`), generates the native Android project (`expo prebuild`), and assembles the debug APK, which the workflow uploads as an artifact.

On the phone (tested on MIUI 14 / Android 12):

1. Open the run's artifact page and download `dsh-mobile-app-debug.apk` (or enable USB debugging and run `adb install -r app-debug.apk`).
2. Open the APK in the file manager; MIUI asks once to allow installs from that source ("安装未知应用").
3. Start the host with `pnpm dsh web --remote`, scan the printed QR with the app, and talk.

Debug builds are signed with the platform debug keystore, so they install side by side with Expo Go. A release APK needs a signing keystore secret and an `assembleRelease` step; the workflow stays on debug so personal builds need no secrets.

## Voice UX

- Tap the microphone to talk; the transcript is sent automatically when you finish (or tap again to end).
- Replies stream into the chat and are spoken sentence by sentence; code blocks are never read aloud.
- Tapping the microphone while the agent is working stops speech and cancels the turn (barge-in).
- Approvals and agent questions render as inline answer cards.
- Settings: recognition/reading language (中文/English) and auto-speak toggle.

## Checks

`pnpm --filter @deepseek-ai/dsh-mobile-app typecheck` runs the app's own strict `tsc --noEmit`; the repository's oxlint/coverage gates exclude this native-toolchain app by design (its logic lives under [packages/client/mobile](../../packages/client/mobile/README.md) with full coverage).

## Known Limitations

- **Pairing cookie lives in the device keychain** — the host's 30-day cookie and day-scoped ticket semantics apply: after a tunnel restart or `--remote-reset`, scan a fresh QR.
- **Tap-to-talk only** — hands-free continuous listening (auto-listen after each reply) is not implemented yet.
- **Speech engines are the platform's own** — quality and availability vary by device and system language packs; no server-side ASR/TTS yet.
- **expo-speech-recognition tracks Expo SDK 56** while the app is on SDK 57 (the module declares loose peers); watch for the SDK 57 release.
