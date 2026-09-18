# react-native-native-debugger

Dev-only **native debugging toolkit** for React Native.

It has three complementary layers:

1. A host-side native log collector that shows real Android `adb logcat` and iOS logging output in a local browser dashboard, including logs from packages that have no debugger integration.
2. An optional local **Model Context Protocol (MCP)** server that exposes the captured native-log session, error groups, process metrics, runtime telemetry, and network evidence to an LLM/MCP client.
3. Optional source-patch integrations for selected libraries that mirror upstream native logs into React Native DevTools Console and surface real caught/swallowed native errors.

The core rule is simple: **the debugger does not invent normal-operation lifecycle events.** An `output.write(...)`, request start, progress callback, or file move does not become a debugger event just because it might be useful. Existing native logs are collected or mirrored; real failures are surfaced.

## Generic Native Logs dashboard

The `logs` command does not require a source patch for the library producing the log.

Android:

```bash
npx rn-native-debugger logs
```

or explicitly:

```bash
npx rn-native-debugger logs --platform android
```

The CLI auto-detects `android/app/build.gradle` / `build.gradle.kts` `applicationId`. If that application process is currently running, it resolves the PID and runs logcat with `--pid=<pid>`. You can override either value:

```bash
npx rn-native-debugger logs \
  --platform android \
  --app com.example.app \
  --device emulator-5554
```

The browser dashboard opens at `http://127.0.0.1:9876` by default. It includes severity filtering, full-text search, pause/resume, clear, auto-scroll, and live/disconnected state.

This collector reads the logs that the native libraries actually emit. For example, if VisionCamera, Firebase, OkHttp, React Native core, BlobUtil, RNFS, or another SDK writes a native Android log, that record can appear without adding a package-specific patch.

### iOS Simulator

```bash
npx rn-native-debugger logs --ios-simulator
```

This uses Apple Unified Logging through:

```text
xcrun simctl spawn <device> log stream --style compact --level debug
```

Use a specific Simulator and optional process filter:

```bash
npx rn-native-debugger logs \
  --ios-simulator \
  --device <SIMULATOR_UDID> \
  --process Audit
```

### Physical iOS device

Physical-device streaming is supported through `idevicesyslog` when `libimobiledevice` is installed and available on `PATH`:

```bash
npx rn-native-debugger logs --ios-device
```

or:

```bash
npx rn-native-debugger logs --ios-device --device <DEVICE_UDID>
```

The package does not install or modify device tooling automatically.

### Dashboard architecture

```text
Android device/emulator                    iOS Simulator / device
        |                                           |
     adb logcat                         Unified Logging / idevicesyslog
        |                                           |
        +--------------------+----------------------+
                             |
                    rn-native-debugger CLI
                             |
                       parser / normalizer
                             |
                       Node HTTP + SSE
                             |
                             v
                  http://127.0.0.1:9876
                       Native Logs UI
```

This layer is intentionally independent of React Native JS and the app process's NativeModule bridge. It therefore remains useful for debugging native libraries before JS listeners are installed or when a library does not have a dedicated debugger integration.

## MCP server — diagnose native logs with an LLM

The debugger can expose the **same live native-log session** to any MCP client.

The MCP server does not contain or call an LLM itself. It exposes evidence through Model Context Protocol; the MCP client/model performs the reasoning.

The recommended architecture is:

```text
Android / iOS runtime
        |
 native OS logging
        |
rn-native-debugger logs
        |
        +-------------------- browser dashboard
        |
        +---- server-side live session store
                    |
             local HTTP API
                    |
          rn-native-debugger mcp
             (stdio MCP)
                    |
          MCP-capable LLM client
                    |
     "Why did my upload fail?"
```

This avoids starting a second `adb logcat` / Unified Logging collector just for the LLM. The dashboard and MCP server query the same captured session.

### 1. Start native log collection

Android:

```bash
npx rn-native-debugger logs --platform android
```

iOS Simulator:

```bash
npx rn-native-debugger logs --ios-simulator
```

Keep that process running. The default dashboard/session endpoint is:

```text
http://127.0.0.1:9876
```

The host process now retains the captured session for both the browser dashboard and MCP queries. An MCP client may connect later and still inspect logs captured earlier in that same `logs` session.

### 2. Configure an MCP client

Use the client-specific MCP configuration format to launch:

```bash
npx rn-native-debugger mcp --connect http://127.0.0.1:9876
```

A common stdio MCP configuration shape is:

```json
{
  "mcpServers": {
    "react-native-native-debugger": {
      "command": "npx",
      "args": [
        "rn-native-debugger",
        "mcp",
        "--connect",
        "http://127.0.0.1:9876"
      ]
    }
  }
}
```

### OpenCode

With the debugger package installed in the React Native project, add the local stdio MCP server from that project:

```bash
opencode mcp add rn-native-debugger -- \
  npx rn-native-debugger mcp \
  --connect http://127.0.0.1:9876
```

Then verify the connection:

```bash
opencode mcp list
```

To make it available to every OpenCode project instead of only the current project:

```bash
opencode mcp add rn-native-debugger --global -- \
  npx rn-native-debugger mcp \
  --connect http://127.0.0.1:9876
```

Equivalent OpenCode V2 project configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "rn-native-debugger": {
        "type": "local",
        "command": [
          "npx",
          "rn-native-debugger",
          "mcp",
          "--connect",
          "http://127.0.0.1:9876"
        ]
      }
    }
  }
}
```

Example prompt:

```text
Use rn-native-debugger to inspect my current React Native app.
Find the most important native errors, inspect the log context around them,
and correlate them with CPU/RAM/FPS and network evidence.
```

### Codex CLI

Add the debugger as a local stdio MCP server:

```bash
codex mcp add rn-native-debugger -- \
  npx rn-native-debugger mcp \
  --connect http://127.0.0.1:9876
```

Verify it:

```bash
codex mcp list
```

Inside Codex TUI, use:

```text
/mcp
```

to inspect the active MCP servers and tools.

Example prompt:

```text
Use the rn-native-debugger MCP tools to diagnose why the latest upload failed.
Start with app-scoped errors, inspect the surrounding native log context,
then expand to system/network processes only if the evidence points there.
```

> Start `rn-native-debugger logs` first. OpenCode/Codex starts the MCP stdio adapter, but the adapter connects to the already-running debugger session at `127.0.0.1:9876`.

If the dashboard uses another host/port, point `--connect` at it.

The MCP process uses **stdio** for the protocol, so it is normally launched by the MCP client rather than kept in a separate interactive terminal.

### MCP tools

The server is intentionally read-only. It cannot mutate the application, execute arbitrary shell commands, clear logs, kill processes, or change device state.

| Tool | Purpose |
| --- | --- |
| `native_debugger_status` | Read current app/device/Metro/collector state, log statistics, and latest runtime telemetry. The model should normally call this first. |
| `search_native_logs` | Search the complete captured session by text, level, process, package, service, subsystem, tag, time window, and order. |
| `get_native_log_context` | Retrieve chronological logs immediately before/after one stable log id. Useful for reconstructing failure sequences. |
| `get_recent_native_errors` | Group real error/fatal/crash-signal logs by normalized signature and return sample log ids. |
| `list_native_processes` | Return observed processes with CPU/RAM telemetry when available and merge their captured-log counts. |
| `get_runtime_telemetry` | Read real host/native metrics such as memory, CPU, FPS, threads, thermal state, battery, heaps, or traffic counters when available. |
| `get_network_evidence` | Search real CFNetwork/Network.framework/OkHttp/TLS/QUIC/socket evidence emitted into the native logs. |

`search_native_logs` and the error tools default to:

```text
scope = app
```

This keeps the model focused on the current React Native application first.

When the failure may involve a related system process, network daemon, permission service, or OS subsystem, the model can explicitly request:

```text
scope = all
```

App scoping is based on the detected application/bundle id and primary process. If the application identity cannot be determined, the response explicitly reports that the requested app scope could not be applied rather than pretending the records were app-only.

### MCP resources

The server also exposes read-only resources:

```text
rnnd://session
rnnd://errors/recent
rnnd://runtime/main
```

These are useful for MCP clients that prefer resources as persistent context rather than explicit tool calls.

### Diagnostic prompt

The MCP server registers:

```text
diagnose-native-issue
```

This prompt guides the model through an evidence-first debugging workflow:

```text
status
  ↓
error groups
  ↓
log context around sample ids
  ↓
source/package/process-specific search
  ↓
network evidence when relevant
  ↓
CPU / RAM / FPS / process telemetry
  ↓
observed facts vs inference
  ↓
likely causes + next debugging actions
```

It explicitly tells the model not to invent missing stack frames, HTTP metadata, source attribution, or root causes.

### Example questions for an MCP-connected LLM

```text
Why did the last native upload fail?
```

```text
Find the errors emitted by react-native-blob-util in the last 5 minutes,
show the surrounding native logs, and explain the strongest likely cause.
```

```text
My app freezes while processing a 400 MB file.
Check app RAM/CPU/FPS telemetry and native errors around the spike.
```

```text
Search the whole device scope for network/TLS evidence related to the
app's ECONNRESET errors and distinguish app logs from OS daemon logs.
```

### MCP data model and evidence rules

Each captured log keeps a stable session id. Search results therefore give the LLM a concrete id that can be passed back to `get_native_log_context`.

The server does deterministic work only:

- application/process scoping
- native log filtering/search
- error signature grouping
- crash-signal pattern detection
- process/log-count correlation
- extraction of network evidence already present in the native log
- exposure of measured runtime telemetry

The model is responsible for diagnosis and interpretation.

A `crashSignal: true` value means the captured native text matched a real fatal/crash pattern. It is **not** an independently invented crash diagnosis.

### MCP privacy and local access

The MCP server exposes whatever the native platform log stream contains. Native logs can contain URLs, identifiers, paths, request metadata, or other application-specific information.

The recommended setup keeps both components on loopback:

```text
Dashboard/API: 127.0.0.1:9876
MCP:           local stdio child process
```

Do not bind the dashboard to a public interface unless that exposure is intentional.

The MCP integration is a development-time feature. It does not add an LLM or remote AI service to the release application.

MCP options:

```text
--connect <dashboard-url>   default: http://127.0.0.1:9876
--mcp-timeout <ms>         dashboard request timeout, default: 5000
```

## Supported source-patch integrations

| Package | Validated versions | What is mirrored/surfaced |
| --- | --- | --- |
| `react-native-fs` | `2.20.0` | existing Android/iOS download logs plus real download/upload failures and existing upload `NSLog` |
| `@dr.pogodin/react-native-fs` | `2.36.2` | existing Kotlin/Objective-C++ download/upload logs plus real caught failures |
| `react-native-blob-util` | `0.22.2`, `0.25.0` | existing iOS `NSLog` diagnostics and real Android/iOS request/file/network failures; 0.25.0 custom-CA logs included |
| `@kesha-antonov/react-native-background-downloader` | `4.6.3` | centralized Android logger, iOS `DLog` / native debug-log path, and real event-emitter failures |

Every integration is optional. Unknown dependency versions are skipped by default instead of being patched speculatively.

## Source-patch architecture

```text
supported third-party native package
        |
        | existing Log.* / NSLog / library logger
        | or real caught native failure
        v
 small transactional mirror patch
        |
        +-- Android RNNDInstrumentation (reflection)
        +-- iOS NSNotificationCenter (#if DEBUG)
        |
        v
   NativeDebugSink
   |            |
 ring buffer   debug persistence
        |
        v
 NativeEventEmitter
        |
        v
 React Native DevTools Console
```

The original upstream log statement remains intact. Android patches use reflection to call `com.rnnativedebugger.NativeDebugSink`, so the patched dependency gains no compile-time Gradle dependency on this package. iOS patches post `RNNativeDebuggerInstrumentationEvent` and are guarded by `#if DEBUG`.

## Install

```bash
npm install --save-dev react-native-native-debugger
```

Then inspect native package support:

```bash
npx rn-native-debugger doctor
```

For the generic log dashboard, no package patch is required:

```bash
npx rn-native-debugger logs
```

If you also want the selected integration logs mirrored into React Native DevTools Console:

```bash
npx rn-native-debugger patch
cd ios && pod install && cd ..
```

Because `patch` changes native dependency source, rebuild the native application after patching.

For deterministic reinstalls, add:

```json
{
  "scripts": {
    "postinstall": "rn-native-debugger patch"
  }
}
```

## DevTools Console transport

Install the transport once near application bootstrap if you use the optional source-patch bridge:

```js
import dbg from 'react-native-native-debugger';
// or:
// const dbg = require('react-native-native-debugger');

if (__DEV__) {
  dbg.installConsoleTransport({
    includeData: true,
    replayBuffered: true,
    levels: ['info', 'error', 'fatal'],
  });
}
```

> **Important:** use `levels` for severity values such as `debug`, `info`, `warn`, `error`, or `fatal`.  
> `events` filters the event **name** stored in `event.event`, such as `log` or `exception`. It is not a severity filter.

`installConsoleTransport(options)` returns a Promise that resolves to the underlying React Native event subscription:

```js
const subscription = await dbg.installConsoleTransport({
  levels: ['warn', 'error'],
});

// Later, if needed:
subscription.remove();
```

### Console transport options

All options are optional.

| Prop | Type | Default | Purpose |
| --- | --- | --- | --- |
| `integrations` | `string[]` | no filter | Only allow records whose `event.integration` exactly matches one of the supplied integration names. |
| `categories` | `string[]` | no filter | Only allow records whose `event.category` exactly matches one of the supplied categories, typically `native-log` or `native-error`. |
| `events` | `string[]` | no filter | Only allow records whose `event.event` exactly matches one of the supplied event names, typically `log` or `exception`. |
| `levels` | `string[]` | no filter | Filter by log severity. Values are normalized to lowercase before matching. Typical values are `debug`, `info`, `warn`, `error`, and `fatal`. |
| `redactKeys` | `string[]` | `[]` | Add extra object-key names that must be redacted before an event is exposed to `onEvent` or written to Console. Built-in sensitive keys are always redacted as well. |
| `includeData` | `boolean` | `true` | Controls whether structured `event.data` is printed to Console. For native logs/errors the human-readable message is still printed when this is `false`; only the extra structured details are omitted. |
| `replayBuffered` | `boolean` | `true` | Replays events that were captured by the native sink before the JS transport subscribed. Set to `false` if you only want newly arriving events. |
| `silent` | `boolean` | `false` | When `true`, suppresses the warning emitted if the native module is not linked/available. |
| `prefix` | `string` | `''` | Prepends custom text to the standard `[NATIVE][...]` Console prefix. |
| `onEvent` | `(event) => void` | none | Receives each filtered, deduplicated, and redacted event before it is printed to Console. Useful for custom debug UIs or forwarding into another dev-only sink. |

Empty filter arrays behave like an unset filter. When more than one filter is supplied, they are combined with **AND** semantics.

For example:

```js
dbg.installConsoleTransport({
  integrations: ['react-native-blob-util'],
  categories: ['native-log', 'native-error'],
  events: ['log', 'exception'],
  levels: ['warn', 'error', 'fatal'],
});
```

means:

```text
integration matches
AND category matches
AND event name matches
AND level matches
```

### `integrations`

Use this when you only want output from one or more patched libraries:

```js
dbg.installConsoleTransport({
  integrations: [
    'react-native-blob-util',
    '@kesha-antonov/react-native-background-downloader',
  ],
});
```

Matching is exact against `event.integration`. There is no wildcard or substring matching.

If `integrations` is omitted, events from every integration are allowed.

### `categories`

The source-patch bridge primarily emits these categories:

```text
native-log
native-error
```

Example:

```js
dbg.installConsoleTransport({
  categories: ['native-error'],
});
```

This keeps real surfaced native failures while excluding mirrored normal native log messages.

### `events`

This filters the `event.event` field, not the severity.

Current source-patch records are primarily:

```text
category: native-log
event: log
```

and:

```text
category: native-error
event: exception
```

So this is valid:

```js
dbg.installConsoleTransport({
  events: ['exception'],
});
```

This is usually **not** what you want:

```js
dbg.installConsoleTransport({
  events: ['info', 'error', 'fatal'], // wrong field for severity
});
```

Use:

```js
dbg.installConsoleTransport({
  levels: ['info', 'error', 'fatal'],
});
```

instead.

### `levels`

Use `levels` to control severity:

```js
dbg.installConsoleTransport({
  levels: ['error', 'fatal'],
});
```

The configured values are normalized to lowercase. Matching is then performed against the lowercase value of `event.level`.

Typical levels are:

```text
debug
info
warn
error
fatal
```

The type intentionally also accepts custom strings because integrations may expose an additional native severity name in the future.

### `includeData`

Default:

```js
includeData: true
```

For a `native-log` / `native-error`, the transport separates the human-readable message from the rest of the structured data.

With:

```js
dbg.installConsoleTransport({
  includeData: true,
});
```

Console output can look like:

```text
[NATIVE][ANDROID][REACT-NATIVE-BLOB-UTIL][REACTNATIVEBLOBUTILREQ][ERROR]
Socket timeout while sending request
{ errorType: 'SocketTimeoutException', stackTrace: '...' }
```

With:

```js
dbg.installConsoleTransport({
  includeData: false,
});
```

the message remains visible but the extra details object is omitted:

```text
[NATIVE][ANDROID][REACT-NATIVE-BLOB-UTIL][REACTNATIVEBLOBUTILREQ][ERROR]
Socket timeout while sending request
```

For non-`native-log` / non-`native-error` records, setting `includeData: false` prints only the generated prefix.

### `replayBuffered`

The native bridge can capture records before the JS transport has been installed.

By default:

```js
replayBuffered: true
```

so bootstrap-time native records can still appear after `installConsoleTransport()` runs.

Use:

```js
dbg.installConsoleTransport({
  replayBuffered: false,
});
```

when you only want records emitted after the subscription is installed.

The transport subscribes to live events **before** replaying the native buffer. Event IDs are deduplicated, so the small overlap window between live subscription and replay does not normally result in duplicate Console records.

### `redactKeys`

The transport recursively redacts common sensitive object keys before calling `onEvent` or printing event data.

Built-in protected keys include:

```text
authorization
proxy-authorization
cookie
set-cookie
x-api-key
api-key
apikey
token
access_token
refresh_token
password
secret
```

You can add project-specific keys:

```js
dbg.installConsoleTransport({
  redactKeys: [
    'sessionId',
    'customerAccessKey',
    'privateCredential',
  ],
});
```

Matching is case-insensitive and also treats a key containing a protected term as sensitive.

For example:

```js
{
  authorization: 'Bearer abc',
  customerAccessKey: '123',
}
```

is exposed as:

```js
{
  authorization: '[REDACTED]',
  customerAccessKey: '[REDACTED]',
}
```

Redaction traverses nested objects and arrays. Extremely deep structures are bounded and become `[MAX_DEPTH]`.

### `prefix`

Use `prefix` when several apps/environments share the same development Console:

```js
dbg.installConsoleTransport({
  prefix: '[AUDIT] ',
});
```

Example output:

```text
[AUDIT] [NATIVE][IOS][REACT-NATIVE-FS][RNFS][ERROR] ...
```

The supplied prefix is added **before** the standard debugger prefix; it does not replace it.

### `onEvent`

Use `onEvent` when you want access to the normalized event in addition to the normal Console output:

```js
dbg.installConsoleTransport({
  onEvent(event) {
    // event has already passed transport filters
    // and sensitive values have already been redacted.
    myDebugStore.push(event);
  },
});
```

The callback receives the event after:

```text
filtering
  ↓
event-id deduplication
  ↓
redaction
  ↓
onEvent(event)
  ↓
console.debug/info/warn/error(...)
```

Returning a value from `onEvent` does not cancel the normal Console output.

### `silent`

If the native module is unavailable, the default behavior is:

```text
[react-native-native-debugger] Native module is not linked; console transport was not installed.
```

For setups where the dependency may intentionally be absent, suppress that warning with:

```js
dbg.installConsoleTransport({
  silent: true,
});
```

The function still resolves to a harmless subscription-like object with a `remove()` method.

### Recommended configurations

Show everything with full metadata:

```js
dbg.installConsoleTransport({
  includeData: true,
  replayBuffered: true,
});
```

Only warnings and failures:

```js
dbg.installConsoleTransport({
  levels: ['warn', 'error', 'fatal'],
  includeData: true,
  replayBuffered: true,
});
```

Only real surfaced native errors:

```js
dbg.installConsoleTransport({
  categories: ['native-error'],
  events: ['exception'],
  levels: ['error', 'fatal'],
  includeData: true,
});
```

Only one integration:

```js
dbg.installConsoleTransport({
  integrations: ['react-native-blob-util'],
  includeData: true,
});
```

Custom dev-only event handling without losing normal Console output:

```js
dbg.installConsoleTransport({
  onEvent(event) {
    debugEventStore.add(event);
  },
});
```

Typical mirrored upstream log:

```text
[NATIVE][ANDROID][@DR.POGODIN/REACT-NATIVE-FS][DOWNLOADER][DEBUG]
File compress with GZIP. Decompress...
```

Typical real native failure:

```text
[NATIVE][ANDROID][REACT-NATIVE-BLOB-UTIL][REACTNATIVEBLOBUTILREQ][ERROR]
Socket timeout while sending request
```

Or leave all transport filters unset and use the React Native DevTools Console search box with `[NATIVE]`, an integration/package name, tag, category, or level.


## Record model

```ts
type NativeDebugEvent = {
  id: string;
  timestamp: number;
  platform: 'android' | 'ios';
  integration: string;
  category: 'native-log' | 'native-error' | string;
  event: string;
  level?: 'debug' | 'info' | 'warn' | 'error' | string;
  data: Record<string, unknown>;
};
```

Source-patch integration records are primarily:

```text
category: native-log
 event: log
 data: { tag, message, ...safeContext }
```

or:

```text
category: native-error
 event: exception
 data: { tag, message, errorType/errorDomain, errorCode, stackTrace, ...safeContext }
```

The native sink keeps a bounded buffer and debug-only persisted history so records created before JS subscribes can be replayed.

## Runtime API

```ts
import {
  installConsoleTransport,
  subscribe,
  getBufferedEvents,
  clearBufferedEvents,
  setEnabled,
} from 'react-native-native-debugger';
```

Read buffered records directly:

```js
const events = await getBufferedEvents();
```

Or subscribe without the default Console transport:

```js
const subscription = subscribe((event) => {
  console.log(event);
});

subscription.remove();
```

## CLI

```bash
npx rn-native-debugger logs
npx rn-native-debugger mcp --connect http://127.0.0.1:9876
npx rn-native-debugger doctor
npx rn-native-debugger patch
npx rn-native-debugger status
npx rn-native-debugger unpatch
```

Log collector flags:

```text
--platform android|ios
--app <applicationId>
--device <serial-or-udid>
--process <ios-simulator-process-name>
--ios-simulator
--ios-device
--host <host>
--port <port>
--no-open
```

Patch/status flags:

```bash
npx rn-native-debugger patch --strict
npx rn-native-debugger doctor --json
npx rn-native-debugger patch --root /path/to/app
```

Patch operations are transactional and idempotent. All anchors for an integration are validated before source files are written. If a later anchor or generated-helper ownership check fails, source edits are rolled back.

When upgrading an existing installation from pre-0.3 patches, `patch` removes older debugger-owned marker blocks in-memory and applies the log/error model inside the same transaction. It does not remove upstream code.

## Configuration

Create `rn-native-debugger.config.js` in the consumer React Native project:

```js
module.exports = {
  strict: false,
  allowUntestedVersions: false,
  integrations: {
    rnfs: { enabled: true },
    drPogodinRnfs: { enabled: true },
    blobUtil: { enabled: true },
    backgroundDownloader: { enabled: true },
  },
};
```

A project may temporarily opt into an unvalidated version, but exact anchors still have to match:

```js
module.exports = {
  integrations: {
    blobUtil: {
      enabled: true,
      allowUntestedVersions: true,
    },
  },
};
```

## What this package intentionally does not do

It does not generate synthetic telemetry such as:

```text
FS_WRITE_STARTED
REQUEST_STARTED
DOWNLOAD_PROGRESS
FILE_MOVED
```

unless that diagnostic already exists in the upstream native library and is being mirrored.

The generic dashboard only displays records that actually reach the platform logging system. If a library performs work silently and emits no native log, the generic collector cannot invent one. The optional source-patch layer can surface real caught errors for explicitly supported libraries without manufacturing normal-operation events.

## Release behavior

- The host-side log dashboard is a development CLI and is not linked into release app runtime behavior.
- iOS injected mirror code is under `#if DEBUG` and is compiled out in release builds.
- Android generated helpers resolve `NativeDebugSink.COMPILED_DEBUG`; release builds permanently degrade the helper to a no-op.
- Mirror failures are swallowed and must never alter library control flow.
- Existing upstream native log calls are preserved.
- Request/response bodies are not bridged to JS by default.

## Development

```bash
npm test
node --check cli/index.js
node --check cli/logs/index.js
node --check cli/logs/collectors.js
node --check cli/logs/dashboard.js
node --check cli/logs/parser.js
node --check cli/logs/session-store.js
node --check cli/mcp/index.js
node --check cli/mcp/dashboard-client.js
ruby -c react-native-native-debugger.podspec
npm pack --dry-run
```

`AGENTS.md` is the canonical development contract for coding agents. `CLAUDE.md` and `GEMINI.md` point to it. In particular, contributors must not add debugger-invented lifecycle/domain events to source integrations.

When adding another dependency version, inspect the exact upstream tag first. Add it to an integration's `tested` list only after its native log/error anchors have been validated. If the source shape differs materially, use version-specific logic or a separate adapter rather than weakening anchors.

## License

MIT
