# Changelog

## 0.8.0-mcp.0

- Added a local stdio Model Context Protocol server via `rn-native-debugger mcp` so MCP-capable LLM clients can diagnose the same live native-log session shown in the dashboard.
- The `logs` host now keeps a server-side session store, allowing an MCP client that connects later to query logs captured earlier in the same debugging session.
- Added read-only MCP tools for debugger/session status, app-scoped/full native log search, log context around stable ids, grouped native errors/crash signals, process CPU/RAM telemetry, runtime telemetry, and native network evidence.
- Added MCP resources for `rnnd://session`, `rnnd://errors/recent`, and `rnnd://runtime/main`.
- Added the `diagnose-native-issue` MCP prompt with an evidence-first workflow that explicitly separates captured facts from model inference.
- Added local observability HTTP endpoints used by MCP: `/api/logs`, `/api/log-context`, `/api/errors`, `/api/log-stats`, and `/api/runtime`.
- Native-log search defaults to the detected React Native application scope; clients can explicitly expand to all captured processes for OS/daemon/network correlation.
- MCP operations are read-only: they do not execute arbitrary shell commands, clear the dashboard session, kill processes, or mutate the app/device.
- Added `@modelcontextprotocol/sdk` and Zod as CLI runtime dependencies and regression coverage for session scoping, error grouping, log context, runtime telemetry separation, and dashboard-to-MCP data flow.

## 0.7.0-observability.3

- Fixed iOS Simulator CPU/RAM sampling by resolving the simulator app PID first and sampling the matching host macOS process with `ps`.
- Added a simulator-runtime `ps` fallback when host sampling is unavailable.
- Automatically resolves the simulator app executable from the bundle id and `CFBundleExecutable`, so performance metrics no longer depend on `--process` or waiting for React Native logs to identify the app process.
- Dashboard performance cards now show the metric source and an explicit reason when sampling is unavailable.
- Added regression coverage for host `ps` RSS/CPU output parsing.

# Changelog

## 0.7.0-observability.2

- Fixed Android logcat parsing for tags that themselves contain colons, including React Native's `unknown:BridgelessReactContext` form.
- Android collector now refreshes a PID-to-process map and annotates each log with its actual process name before source classification.
- Reclassification now happens after stack/source-location extraction, improving React Native attribution from JVM stack frames.
- Unknown package/service labels now fall back to resolved process/tag metadata instead of masking useful Android source information.
- Buffered dashboard events are retroactively enriched when process discovery learns a PID mapping, so process filters work for records received just before discovery.
- Process, Package, and Service filters now include built-in search fields for large facet sets.
- Added regression coverage for colon-bearing Android tags, process fallback attribution, and searchable dashboard facets.

## 0.7.0-observability.0

- Redesigned the React dashboard into a three-column runtime observability console with device/app/session context, the existing virtualized log explorer, and live performance panels.
- Added host-side Android and iOS Simulator telemetry for per-process memory and CPU without injecting additional runtime instrumentation into the React Native app.
- Added device metadata including platform, model/device name, OS version, architecture, device id, and total memory when available.
- Added app/session metadata including project version, bundle/application id, React Native/React versions, primary process, Metro connectivity, and collector status.
- Added `/session` and `/metrics?process=...` dashboard endpoints while preserving `/events`, `/processes`, and `/health`.
- Added lightweight SVG charts for memory, CPU, and live log rate plus a session-wide log-level distribution.
- Metrics are sampled once per second and retain only a bounded chart history; captured logs continue to remain in the full in-memory session until Clear.
- Physical iOS keeps the dashboard UI but reports process CPU/memory as unavailable when the current host tooling cannot sample them.
- Added telemetry API and session metadata regression tests.

# Changelog

## 0.6.0-react.2

- Removed the dashboard's global 5000-record retention cap. Logs now remain in the in-memory session until the user explicitly presses Clear or the dashboard process/page is restarted.
- Removed severity-aware eviction because filtering must operate over the complete captured session rather than a lossy global ring buffer.
- React virtualization continues to bound DOM row count even when the in-memory log session grows.
- Replaced retention-floor tests with regression coverage that forbids reintroducing a hard buffer cap or automatic trimming.

# Changelog

## 0.6.0-react.1

- Kept the dashboard ring buffer capped at 5000 records while making retention severity-aware.
- Added protected retention floors for `fatal` (250), `error` (1000), and `warn` (750) records so high-volume `debug`, `info`, `default`, `verbose`, or unknown logs cannot immediately evict important historical failures.
- Eviction now prefers the oldest record from the lowest-retention severity class first, while still enforcing the global 5000-record memory bound.
- Filtering semantics remain `retained buffer -> filters -> visible limit`, so asking for the latest 100 errors remains stable unless the error history itself exceeds its protected retention window.
- Added regression tests covering global buffer bounds and protected error/warn/fatal history under heavy low-severity log traffic.

## 0.5.4

- Added a generic Process filter separate from package/source, service, level, search, and visible limit.
- iOS Simulator and Android collectors can now expose running processes to the dashboard; the process picker refreshes periodically and also includes processes observed in buffered logs.
- Process selection is multi-select, so an app process and related system/service processes can be inspected together without hard-coding any application name.
- Added PID-to-process enrichment for Android dashboard records when process discovery provides a matching PID.
- Android logcat now remains unfiltered by default even when the app id is auto-detected; PID filtering is applied only when `--app` is explicitly supplied, allowing related system processes to remain visible.
- Physical iOS devices continue to use observed log process names because `idevicesyslog` does not provide a portable process-list API.
- Expanded iOS compact Unified Logging parsing to accept both one-letter (`E`, `D`, `I`, etc.) and two-letter (`Er`, `Db`, etc.) priority formats generically.
- Added regression coverage for one-letter iOS priority records, process filtering UI, filter-before-limit semantics, and the `/processes` dashboard endpoint.

## 0.5.3

- Decoupled log capture speed from dashboard render speed. Incoming SSE records now enter the bounded ring buffer immediately regardless of the selected UI refresh interval.
- Render speed now controls only how often the DOM is refreshed; it no longer creates a replay backlog that must be visually drained.
- Pause captures a stable snapshot for filtering, selection, and export while the live ring buffer continues collecting new logs in the background.
- Resume discards the frozen snapshot and immediately jumps to the newest buffered state instead of replaying accumulated records one by one.
- Facets are recomputed from the active snapshot/buffer only when the UI refreshes, reducing unnecessary work during high-volume streams.

## 0.5.2

- Dashboard level, package/source, and service facets are now generated dynamically from the full in-memory buffer instead of fixed lists.
- Filter semantics are explicitly `buffer -> filters -> visible limit`, so selecting a package and `100` shows the newest 100 matching records for that package.
- Added playback/render speed controls: realtime, 250 ms, 500 ms, 1 second, and 2 seconds. Collection continues at full speed; only UI flushing is throttled.
- Pause now freezes the visible/export snapshot while incoming logs continue accumulating in a bounded pending queue for resume.
- Export actions are disabled while live/play mode is active and enabled only when paused.
- Added per-row selection checkboxes, selected-count tracking, and JSON export for selected records.
- Existing filtered JSON/NDJSON exports continue to respect the active filters and visible-record limit.
- Added regression tests for dynamic facets, playback controls, selection/export behavior, filter-before-limit semantics, and generated inline-script syntax.

## 0.5.0

- Reworked the native logs dashboard into a newer, denser inspector UI with newest records shown first.
- Batched incoming SSE events before rendering and capped the in-browser ring buffer at 5000 records to reduce repaint pressure and memory growth during high-volume logging.
- Added visible-record limits: `10`, `20`, `50`, `100`, `500`, `1000`, and `5000`.
- Added package/source and service filters in addition to severity and full-text search.
- Added per-record Copy and expandable structured Details actions.
- Added filtered JSON and NDJSON export; exports preserve the raw native log alongside normalized metadata for later automated/AI analysis.
- Expanded iOS compact Unified Logging parsing to capture process, PID, TID, source library, subsystem, category, function/tag, priority, and message when Apple exposes those fields.
- Added best-effort conservative library attribution for known React Native/native sources including RNFS, BlobUtil, background-downloader, VisionCamera, Firebase, Sentry, OkHttp, Hermes, React Native, and Apple system subsystems. Attribution includes a confidence/source-kind marker rather than pretending every OS log can be mapped to an npm package.
- Added extraction of native/JVM file, class, method, and line metadata when the emitted log or stack trace actually contains source locations.
- Added regression coverage using the current iOS compact log shape, including `[com.apple.network:category]` and optional `(source library)` fields.

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
