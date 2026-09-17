# react-native-native-debugger

Dev-only native instrumentation and structured log transport for React Native.

The package patches supported third-party native modules in `node_modules`, captures native lifecycle events, buffers them in the app process, and forwards them to JavaScript so they can be viewed in the normal React Native DevTools Console. Application imports do not need wrappers or Babel transforms.

## Supported integrations

| Package | Validated versions | Android | iOS |
| --- | --- | --- | --- |
| `react-native-fs` | `2.20.0` | download lifecycle | download lifecycle |
| `@dr.pogodin/react-native-fs` | `2.36.2` | Kotlin download lifecycle | Objective-C++ download lifecycle |
| `react-native-blob-util` | `0.22.2`, `0.25.0` | OkHttp + DownloadManager | NSURLSession download/upload/network |
| `@kesha-antonov/react-native-background-downloader` | `4.6.3` | centralized download lifecycle | background NSURLSession lifecycle |

Every integration is optional. Unknown dependency versions are skipped by default instead of being patched speculatively.

## Architecture

```text
optional native package
        |
        | transactional source instrumentation
        v
 RNNDInstrumentation / NSNotificationCenter
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

Patched Android dependencies use reflection to call `com.rnnativedebugger.NativeDebugSink`, so they do not gain a compile-time Gradle dependency on this package. iOS patches emit `RNNativeDebuggerInstrumentationEvent` through `NSNotificationCenter` and are guarded by `#if DEBUG`.

## Install

```bash
npm install --save-dev react-native-native-debugger
```

For a local/package artifact:

```bash
npm install --save-dev ./react-native-native-debugger-0.2.0.tgz
```

Then:

```bash
npx rn-native-debugger doctor
npx rn-native-debugger patch
cd ios && pod install && cd ..
```

For deterministic reinstalls, add the patch command to the consumer app:

```json
{
  "scripts": {
    "postinstall": "rn-native-debugger patch"
  }
}
```

## DevTools Console transport

Install once near app bootstrap:

```js
if (__DEV__) {
  const { installConsoleTransport } = require('react-native-native-debugger');
  installConsoleTransport();
}
```

Filter when needed:

```js
installConsoleTransport({
  integrations: ['react-native-blob-util'],
  categories: ['network', 'upload'],
  includeData: true,
});
```

Typical output:

```text
[NATIVE][ANDROID][REACT-NATIVE-BLOB-UTIL][NETWORK][REQUEST]
{ taskId: '42', method: 'POST', url: 'https://example.invalid/upload', transport: 'OkHttp' }
```

Common secret keys such as authorization, cookies, API keys, tokens, passwords and secrets are recursively redacted by the JS console transport.

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

Events are structured:

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

The native sink keeps a bounded buffer and debug-only persisted history so events that happen before JS subscribes can be replayed. It cannot execute while the entire app process is dead; OS-owned transfers such as iOS background `NSURLSession` or Android `DownloadManager` are observed again when the OS wakes/relaunches the process and callbacks return.

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

## Configuration

Create `rn-native-debugger.config.js` in the consumer React Native project:

```js
module.exports = {
  strict: false,
  allowUntestedVersions: false,
  progressThrottleMs: 500,
  integrations: {
    rnfs: { enabled: true },
    drPogodinRnfs: { enabled: true },
    blobUtil: { enabled: true },
    backgroundDownloader: { enabled: true },
  },
};
```

A project may temporarily opt into an unvalidated version, but semantic anchors still have to match exactly:

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

## Release behavior

- iOS injected instrumentation is under `#if DEBUG` and is compiled out in release builds.
- Android generated helpers resolve `NativeDebugSink.COMPILED_DEBUG`; release builds permanently degrade the helper to a no-op.
- Instrumentation errors are swallowed and must never alter transfer control flow.
- Transfer bodies are not bridged to JS by default.
- Progress events are throttled before persistence/bridge work.

## Development

```bash
npm test
node --check cli/index.js
node --check cli/helpers.js
node --check cli/patch-engine.js
ruby -c react-native-native-debugger.podspec
npm pack --dry-run
```

The repository includes `AGENTS.md` as the canonical development contract for coding agents. `CLAUDE.md` and `GEMINI.md` point back to that file so architecture and patch-safety rules remain centralized.

When adding support for another dependency version, inspect the exact upstream tag first. Add the version to an integration's `tested` list only after its native source anchors have been validated. If the implementation shape differs materially, create a separate adapter rather than weakening anchors.

## License

MIT
