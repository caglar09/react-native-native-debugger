# react-native-native-debugger

Dev-only **native log and error bridge** for React Native.

For explicitly supported third-party packages, this library patches small native source points so diagnostics the upstream package already emits can also appear in React Native DevTools Console. It also surfaces real native exceptions/errors that are caught or reduced to callbacks and would otherwise be difficult to inspect.

The key rule in v0.3 is simple: **the debugger does not invent normal-operation lifecycle events.** An `output.write(...)`, request start, progress callback, or file move does not become a debugger event just because it might be useful. Existing upstream native logs are mirrored; real failures are surfaced.

## Supported integrations

| Package | Validated versions | What is mirrored/surfaced |
| --- | --- | --- |
| `react-native-fs` | `2.20.0` | existing Android/iOS download logs plus real download/upload failures and existing upload `NSLog` |
| `@dr.pogodin/react-native-fs` | `2.36.2` | existing Kotlin/Objective-C++ download/upload logs plus real caught failures |
| `react-native-blob-util` | `0.22.2`, `0.25.0` | existing iOS `NSLog` diagnostics and real Android/iOS request/file/network failures; 0.25.0 custom-CA logs included |
| `@kesha-antonov/react-native-background-downloader` | `4.6.3` | centralized Android logger, iOS `DLog` / native debug-log path, and real event-emitter failures |

Every integration is optional. Unknown dependency versions are skipped by default instead of being patched speculatively.

This version does **not** yet collect arbitrary logs from every native package in the app or stream host-side `adb logcat` / Apple Unified Logging. That broader device-log collector is intentionally a separate next-stage feature.

## Architecture

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

For the local/package artifact:

```bash
npm install --save-dev ./react-native-native-debugger-0.3.0.tgz
```

Then:

```bash
npx rn-native-debugger doctor
npx rn-native-debugger patch
cd ios && pod install && cd ..
```

Because the patch changes native dependency source, rebuild the native application after patching.

For deterministic reinstalls, add:

```json
{
  "scripts": {
    "postinstall": "rn-native-debugger patch"
  }
}
```

## DevTools Console transport

Install once near application bootstrap:

```js
if (__DEV__) {
  require('react-native-native-debugger').installConsoleTransport({
    includeData: true,
    replayBuffered: true,
  });
}
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

You can filter at transport level:

```js
installConsoleTransport({
  integrations: ['react-native-blob-util'],
  categories: ['native-log', 'native-error'],
  levels: ['warn', 'error'],
  includeData: true,
  replayBuffered: true,
});
```

Or leave filters unset and use the React Native DevTools Console search box with `[NATIVE]`, a package name, tag, or level.

Common secret keys such as authorization, cookies, API keys, tokens, passwords, and secrets are recursively redacted by the JS Console transport.

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

For v0.3 source-patch integrations, normal records are primarily:

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
npx rn-native-debugger doctor
npx rn-native-debugger patch
npx rn-native-debugger status
npx rn-native-debugger unpatch
```

Useful flags:

```bash
npx rn-native-debugger patch --strict
npx rn-native-debugger doctor --json
npx rn-native-debugger patch --root /path/to/app
```

Patch operations are transactional and idempotent. All anchors for an integration are validated before source files are written. If a later anchor or generated-helper ownership check fails, source edits are rolled back.

When upgrading an existing installation from pre-0.3 patches, `patch` removes older debugger-owned marker blocks in-memory and applies the new log/error model inside the same transaction. It does not remove upstream code.

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

It also does not currently read all Android logcat or iOS Unified Logging records from the device. A generic host-side native log viewer/collector is a separate planned layer because it has different transport, device-selection, PID/bundle filtering, and permission constraints.

## Release behavior

- iOS injected mirror code is under `#if DEBUG` and is compiled out in release builds.
- Android generated helpers resolve `NativeDebugSink.COMPILED_DEBUG`; release builds permanently degrade the helper to a no-op.
- Mirror failures are swallowed and must never alter library control flow.
- Existing upstream native log calls are preserved.
- Request/response bodies are not bridged to JS by default.

## Development

```bash
npm test
node --check cli/index.js
node --check cli/helpers.js
node --check cli/patch-engine.js
ruby -c react-native-native-debugger.podspec
npm pack --dry-run
```

`AGENTS.md` is the canonical development contract for coding agents. `CLAUDE.md` and `GEMINI.md` point to it. In particular, contributors must not add debugger-invented lifecycle/domain events to source integrations.

When adding another dependency version, inspect the exact upstream tag first. Add it to an integration's `tested` list only after its native log/error anchors have been validated. If the source shape differs materially, use version-specific logic or a separate adapter rather than weakening anchors.

## License

MIT
