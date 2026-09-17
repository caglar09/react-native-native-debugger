# Changelog

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
