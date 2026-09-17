# react-native-native-debugger

Dev-only native instrumentation for React Native.

The package patches supported third-party native modules in `node_modules` and forwards structured native lifecycle events into the React Native JavaScript runtime. A built-in console transport then prints those events into the normal React Native DevTools Console.

It does **not** replace `fetch`, does **not** require a custom Network tab, and does **not** require application code to wrap RNFS/BlobUtil/downloader APIs.

## What it instruments

Current v0.1.0 integrations:

| Package | Tested version | Android | iOS |
| --- | --- | --- | --- |
| `react-native-fs` | `2.20.0` | download start/response/progress/complete/fail | download start/progress/complete/fail |
| `react-native-blob-util` | `0.25.0` | OkHttp + DownloadManager lifecycle | NSURLSession request/response/download/upload progress/complete/fail |
| `@kesha-antonov/react-native-background-downloader` | `4.6.3` | centralized begin/progress/complete/fail | background NSURLSession start/progress/complete/fail |

All three are optional. If none are installed, the native logger module still links normally.

Unknown dependency versions are skipped by default. This is intentional: source instrumentation should fail safe rather than mutate an unverified native implementation.

## Architecture

```text
RNFS / BlobUtil / BackgroundDownloader
                |
                | source instrumentation
                v
       native debug event
          /           \
     Android          iOS
 reflection sink   NSNotification
          \           /
           NativeDebugSink
                |
       ring + disk buffer
                |
       NativeEventEmitter
                |
         console transport
                |
    React Native DevTools Console
```

### Why patches do not import this package

A patched third-party Android module calls `com.rnnativedebugger.NativeDebugSink` using reflection. It therefore does not acquire a compile-time Gradle dependency on this module.

The iOS patches post an `NSNotificationCenter` event named `RNNativeDebuggerInstrumentationEvent`. They do not import this pod.

This keeps the dependency graph one-way and makes `unpatch` safe.

## Install

```bash
npm install --save-dev react-native-native-debugger
```

For a local copy:

```bash
npm install --save-dev ./react-native-native-debugger
```

Then patch the optional integrations:

```bash
npx rn-native-debugger doctor
npx rn-native-debugger patch
```

Run CocoaPods after adding the library for the first time:

```bash
cd ios && pod install
```

For deterministic reinstalls, add the patch command to the **consumer app's** `postinstall` script:

```json
{
  "scripts": {
    "postinstall": "rn-native-debugger patch"
  }
}
```

The package itself intentionally does not mutate sibling packages from its own install script.

## Enable the DevTools Console transport

Call it once near application bootstrap:

```js
if (__DEV__) {
  const { installConsoleTransport } = require('react-native-native-debugger');

  installConsoleTransport();
}
```

Example output:

```text
[NATIVE][ANDROID][REACT-NATIVE-BLOB-UTIL][NETWORK][REQUEST]
{ taskId: '42', method: 'POST', url: 'https://api.example.com/upload', transport: 'OkHttp' }

[NATIVE][IOS][REACT-NATIVE-FS][DOWNLOAD][PROGRESS]
{ url: 'https://cdn.example.com/a.zip', current: 105906176, total: 419430400 }

[NATIVE][IOS][@KESHA-ANTONOV/REACT-NATIVE-BACKGROUND-DOWNLOADER][DOWNLOAD][COMPLETED]
{ taskId: 'asset-42', location: '/...', current: 419430400, total: 419430400 }
```

### Filter console output

```js
installConsoleTransport({
  integrations: ['react-native-blob-util'],
  categories: ['network', 'upload'],
  includeData: true,
});
```

### Default secret redaction

The JS transport recursively redacts common sensitive keys such as:

- `authorization`
- `cookie` / `set-cookie`
- `x-api-key`
- keys containing `token`, `password`, or `secret`

Add project-specific keys:

```js
installConsoleTransport({
  redactKeys: ['x-company-session', 'customerSecret'],
});
```

## Native buffer / app restart

Native events are retained in a bounded ring buffer (1000 events) and, in debug builds, persisted into the app cache directory. When the JS transport is attached, buffered events are replayed.

This is useful when a callback occurs before the JS listener is ready or during a native-heavy launch path.

Important OS limitation: an iOS background `NSURLSession` or Android `DownloadManager` can continue work outside the app process. Code in this package cannot execute while the app process itself is dead. It records enqueue/lifecycle state before termination and records callbacks again when the OS wakes/relaunches the app process.

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

Raw event shape:

```ts
type NativeDebugEvent = {
  id: string;
  timestamp: number;
  platform: 'android' | 'ios';
  integration: string;
  category: string;
  event: string;
  level?: string;
  data: Record<string, unknown>;
};
```

Use a custom handler instead of console output:

```js
const subscription = subscribe((event) => {
  // Render your own debug overlay, write a test assertion, etc.
});

subscription.remove();
```

## CLI

### `doctor`

```bash
npx rn-native-debugger doctor
```

Shows installed optional packages, versions and patch marker status.

### `patch`

```bash
npx rn-native-debugger patch
```

Patch behavior is:

1. Detect package.
2. Verify the exact tested version unless explicitly overridden.
3. Load every target file.
4. Verify every semantic source anchor exists exactly once.
5. Build all edits in memory.
6. Commit only after validation succeeds.
7. Add marker comments and a generated Android helper.

The operation is idempotent.

### `unpatch`

```bash
npx rn-native-debugger unpatch
```

Only sections enclosed by this package's markers and helper files marked as generated are removed.

### JSON output

```bash
npx rn-native-debugger doctor --json
```

### Strict mode

By default a failed/unsupported optional integration is reported and skipped instead of breaking `npm install`.

For CI:

```bash
npx rn-native-debugger patch --strict
```

## Configuration

Create `rn-native-debugger.config.js` in the React Native project root:

```js
module.exports = {
  strict: false,
  allowUntestedVersions: false,
  progressThrottleMs: 500,

  integrations: {
    rnfs: {
      enabled: true,
    },
    blobUtil: {
      enabled: true,
    },
    backgroundDownloader: {
      enabled: true,
    },
  },
};
```

An individual integration can explicitly allow a newer version while you validate it locally:

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

Even then, all source anchors must match exactly or the patch is skipped without modifying that integration.

`progressThrottleMs` is applied on both Android and iOS before expensive persistence/JS bridge work. A final `current == total` progress event is never suppressed.

## Debug/release behavior

### iOS

Injected instrumentation is wrapped in:

```objc
#if DEBUG
// instrumentation
#endif
```

It is compiled out of release builds.

### Android

The generated helper resolves `NativeDebugSink.COMPILED_DEBUG` once. In release builds it permanently becomes a no-op. It never throws into the instrumented library.

## Patch markers

Injected blocks look like:

```java
// @rn-native-debugger:start blob.android.okhttp-response
RNNDInstrumentation.emit(...);
// @rn-native-debugger:end blob.android.okhttp-response
```

Generated helper files start with:

```java
// @rn-native-debugger:generated
```

The CLI refuses to overwrite a same-named file that it does not own.

## Development / tests

```bash
npm test
```

The included tests cover:

- patch marker idempotency
- ambiguous-anchor rejection
- generated-file ownership
- RNFS integration anchors
- BlobUtil integration anchors
- background-downloader integration anchors
- transactional behavior when a later target file is incompatible

## Known limitations of v0.1.0

- It is a source-instrumentation tool. Updating an integrated package requires a matching integration definition or an explicit untested-version opt-in followed by local validation.
- It does not inject requests into the React Native DevTools Network panel; that is intentionally out of scope.
- It does not stream the entire Android system `logcat` into JS. Android platform log access is intentionally kept separate from structured app instrumentation.
- It does not yet implement a generic iOS `OSLogStore` collector like `margelo/react-native-app-logs`; v0.1.0 focuses on deterministic structured events from the instrumented libraries.
- Native compilation was designed for the normal React Native autolinking path and old-Native-Module interoperability used by current New Architecture releases; it is not a C++/JSI-only TurboModule implementation.
- v0.1.0 assumes a writable physical `node_modules` tree (npm/classic Yarn). Yarn PnP and pnpm store-backed installs should use a package-manager-native patch workflow instead of mutating shared package contents directly.

## Safe failure principle

Instrumentation must never change transfer behavior. Generated helpers swallow their own reflection errors, native sinks are debug-only, and patch application refuses ambiguous or missing source anchors.
