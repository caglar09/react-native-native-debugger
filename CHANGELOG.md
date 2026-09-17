# Changelog

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
