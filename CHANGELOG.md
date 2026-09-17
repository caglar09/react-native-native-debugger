# Changelog

## 0.4.0

- Added `rn-native-debugger logs`, a host-side native log collector with a local browser dashboard.
- Android collector streams real `adb logcat` output, auto-detects the React Native app `applicationId`, and applies `--pid` filtering when the app process is running.
- iOS Simulator collector streams Apple Unified Logging through `xcrun simctl spawn <device> log stream --level debug`.
- Physical iOS devices are supported through `idevicesyslog` when `libimobiledevice` is installed.
- Added dashboard filtering by severity and full-text search across tag/process/message, plus pause/resume, clear, auto-scroll, bounded DOM retention, and live connection state.
- The generic collector is independent of source-patch integrations, so native logs from unpatched libraries such as VisionCamera, Firebase, OkHttp, React Native core, and other SDKs can be inspected when those libraries actually emit native logs.
- Added parser/applicationId/dashboard tests without adding runtime npm dependencies; the dashboard uses Node HTTP + Server-Sent Events.

## 0.3.0

- Reframed supported integrations from synthetic lifecycle instrumentation to a native log/error bridge.
- Removed debugger-invented `started`, `request`, `response`, `progress`, `completed`, and similar transfer events from integration patches.
- Existing upstream `Log.*` / `NSLog` diagnostics are now mirrored to React Native DevTools Console without replacing the original native log call.
- Real caught/swallowed native failures are surfaced as `native-error` events with error type/message and stack information where available.
- Added top-level log severity propagation and `levels` filtering in `installConsoleTransport()`.
- Added native-log Console formatting: `[NATIVE][PLATFORM][INTEGRATION][TAG][LEVEL] message`.
- Expanded both RNFS integrations to cover real upload errors/logs as well as download diagnostics.
- `react-native-blob-util@0.25.0` now mirrors the custom-CA/pinning `NSLog` diagnostics introduced in that exact version.
- `@kesha-antonov/react-native-background-downloader@4.6.3` now mirrors its centralized Android logger and iOS `DLog`/native debug-log pathways rather than synthesizing download lifecycle events.
- Patch application strips legacy debugger marker blocks in-memory before validating/applying the 0.3 log/error model, preserving transactional rollback.

## 0.2.0

- Added validated `@dr.pogodin/react-native-fs` 2.36.2 instrumentation for Android Kotlin and iOS Objective-C++.
- Added validated `react-native-blob-util` 0.22.2 support alongside 0.25.0.
- Made generated Android instrumentation helper public so Kotlin integrations can call it reliably from the same native package.
- Added `AGENTS.md` as the canonical coding-agent development contract plus `CLAUDE.md` and `GEMINI.md` pointers.
- Expanded optional peer dependency metadata and configuration examples for the Dr. Pogodin RNFS fork.

## 0.1.0

- Initial native event sink for Android and iOS.
- Persistent bounded debug event buffer with JS replay.
- React Native DevTools Console transport with recursive secret redaction.
- Optional source-patch integrations for:
  - react-native-fs 2.20.0
  - react-native-blob-util 0.25.0
  - @kesha-antonov/react-native-background-downloader 4.6.3
- `patch`, `unpatch`, `doctor`, `status` CLI commands.
- Idempotent marker-based and transactional source instrumentation.
- Release-build no-op/compile-out behavior.
