# AGENTS.md

This file is the canonical development contract for AI coding agents and human contributors working on `react-native-native-debugger`.

## Mission

`react-native-native-debugger` is a **development-only native log and error bridge** for React Native. For explicitly supported third-party native modules, source patches mirror diagnostics that the upstream library already emits and surface real native failures that would otherwise be swallowed or difficult to observe. The native sink buffers those records and forwards them to JavaScript so React Native DevTools Console can display them.

The package must never invent normal-operation domain events merely to make activity visible. It must never change production behavior, transfer semantics, retry behavior, file contents, request bodies, or application business logic.

## Cardinal observability rule

This rule overrides convenience:

1. If upstream already calls `Log.v/d/i/w/e`, `NSLog`, `os_log`, a library-owned logging helper, or an equivalent native logger, preserve that call and mirror the same diagnostic.
2. If upstream catches a real `Throwable`, `Exception`, `NSError`, or `NSException` and the failure is swallowed, reduced to a callback string, or otherwise hard to inspect, the integration may surface that real failure as `native-error`.
3. Do **not** add synthetic `started`, `request`, `response`, `progress`, `completed`, `file-written`, `move`, or similar lifecycle/domain events unless the upstream library itself already logs/emits that diagnostic and the adapter is mirroring it.
4. Do not reinterpret an ordinary source line (for example `output.write(...)`) as a semantic event.
5. Prefer no event over a debugger-invented event.

A useful review question is: **“Would this record exist because the library actually logged/raised something, or only because the debugger author wanted more telemetry?”** Only the first category belongs in the source-patch integrations.

## Core architecture

```text
supported native dependency
  -> preserve upstream native log / observe real caught failure
  -> small source patch that mirrors it
  -> Android RNNDInstrumentation / iOS NSNotificationCenter
  -> NativeDebugSink
  -> bounded native buffer + debug persistence
  -> NativeEventEmitter
  -> JS Console transport / custom subscriber
```

Important boundaries:

1. Patched third-party packages must **not** acquire a compile-time dependency on this package.
2. Android integration helpers call `com.rnnativedebugger.NativeDebugSink` through reflection.
3. iOS integration patches post `RNNativeDebuggerInstrumentationEvent` using `NSNotificationCenter` under `#if DEBUG`.
4. Original upstream log calls remain intact; mirroring is additive.
5. Release builds must be no-op / compile-out for debugger instrumentation.
6. Patch failure must never leave a dependency half-modified.
7. Generic device-wide/package-wide log collection (`adb logcat`, Apple Unified Logging host collectors) is a separate architecture and must not be faked through source instrumentation.

## Supported integration matrix

Treat this matrix as strict. Do not silently expand it.

| Integration key | Package | Validated versions |
| --- | --- | --- |
| `rnfs` | `react-native-fs` | `2.20.0` |
| `drPogodinRnfs` | `@dr.pogodin/react-native-fs` | `2.36.2` |
| `blobUtil` | `react-native-blob-util` | `0.22.2`, `0.25.0` |
| `backgroundDownloader` | `@kesha-antonov/react-native-background-downloader` | `4.6.3` |

A version belongs in `tested` only after its exact tagged source was inspected and all patch anchors were validated against that version.

## Non-negotiable patch rules

When changing or adding an integration:

- Patch the smallest possible existing log or real error point.
- Preserve the original logger/error handling and control flow.
- Do not replace complete dependency files.
- Every insertion must use `PatchPlan.insertBefore()` or `PatchPlan.insertAfter()` with an anchor expected **exactly once**.
- Build all `PatchPlan`s before the first write.
- Commit multi-file changes only through `commitTransaction()`.
- Generated helpers must begin with `// @rn-native-debugger:generated`.
- Never overwrite a same-named file that is not owned by this project.
- Instrumented blocks must remain removable by `unpatch` markers.
- Re-running `patch` must be idempotent.
- `unpatch` must remove only this project's generated blocks/files.
- If an anchor drifts, fail closed. Do not guess a nearby insertion point.
- Never set `allowUntestedVersions` as a library default.
- When upgrading from an older debugger instrumentation model, legacy marker blocks may be stripped in-memory, but only inside the same transaction that validates the replacement patch.

## Adding a new package version

Follow this sequence:

1. Inspect the exact upstream tag/commit, not only the latest branch.
2. Record native file paths for Android and iOS.
3. Identify the upstream native log calls and meaningful caught failures that actually exist in that version.
4. Compare every intended anchor against the exact target source.
5. If all anchors and semantics are unchanged, add the version to `tested`.
6. If logging/error structure differs, create version-specific logic or a separate adapter rather than weakening anchors.
7. Add a regression test representing the validated source shape.
8. Run `npm test`.
9. Compile generated Java/Kotlin snippets when practical.
10. Run `npm pack --dry-run` and inspect the file list.
11. Update README support matrix and CHANGELOG.

## Adding a new integration

Create `cli/integrations/<name>.js` and implement:

```js
{
  key,
  packageName,
  tested,
  files(packageRoot),
  patch(packageRoot, options),
  unpatch(packageRoot),
  status(packageRoot)
}
```

Then register it in `cli/index.js` and add its package as an optional peer dependency when appropriate.

Prefer a separate adapter when package names, Java/Kotlin namespaces, iOS layouts, or logging/error semantics differ materially. Do not force unrelated packages into one adapter merely because their public JS API is similar.

## Record conventions

Source-patch integrations should emit only these conceptual record classes:

```text
native-log
  integration: upstream package identity
  level: debug | info | warn | error
  tag: original/native logger tag or class
  message: same upstream diagnostic meaning
  data: optional non-secret context already available at the log site

native-error
  integration: upstream package identity
  level: error
  tag: originating native component
  message: real failure message
  data: error type/domain/code/stack and safe context when available
```

Guidelines:

- Never bridge request/response bodies by default.
- Never log authorization headers, cookies, passwords, tokens, API keys, or secrets.
- Preserve original severity when the upstream logger provides one.
- Avoid duplicate reporting of the same exception at nested catch/rethrow boundaries; prefer the location where the failure is actually logged or swallowed.
- Instrumentation must be observational; never alter control flow to produce a log.

## Android rules

- Generated helper class: `RNNDInstrumentation.java` in the target dependency package namespace.
- The helper uses reflection so the patched dependency has no direct Gradle dependency on this library.
- `RNNDInstrumentation.log(level, tag, message)` mirrors an existing upstream native log.
- `RNNDInstrumentation.error(tag, message, throwable)` surfaces a real caught failure and includes stack information.
- Catch all reflection/instrumentation failures and silently degrade to no-op.
- The helper must check `NativeDebugSink.COMPILED_DEBUG` and runtime `isEnabled()` before emitting.
- For Kotlin dependencies, a generated public Java helper is acceptable when it lives in the same package and is compiled by the same Android module.
- Do not attempt to read unrestricted Android logcat from inside the app.

## iOS rules

- Inject only code guarded by `#if DEBUG`.
- Do not import this library into patched pods.
- Preserve upstream `NSLog`/logger calls and add a mirror after them.
- Use `NSNotificationCenter` event `RNNativeDebuggerInstrumentationEvent`.
- Keep payloads property-list / React Native bridge friendly: strings, numbers, booleans, arrays, dictionaries, null-safe values.
- Real `NSError` / `NSException` failures may be surfaced even if upstream did not print them, because they represent actual failure state rather than invented lifecycle telemetry.
- Be careful with background `NSURLSession`: callbacks can arrive before JS is ready, which is why the native sink owns buffering.

## Native core rules

Changes under `android/`, `ios/`, `index.js`, or `index.d.ts` must preserve:

- bounded buffering,
- thread safety,
- replay semantics,
- debug-only persistence,
- recursive secret redaction in JS console output,
- listener lifecycle correctness,
- compatibility with a missing optional integration,
- top-level log severity so Console uses the corresponding debug/info/warn/error method.

Do not make the native sink depend on any instrumented third-party package.

## Tests required before completion

Run at minimum:

```bash
npm test
node --check cli/index.js
node --check cli/helpers.js
node --check cli/patch-engine.js
npm pack --dry-run
```

When touching an integration, tests must cover:

- successful patch,
- second patch is idempotent,
- successful unpatch,
- no synthetic lifecycle markers/events are introduced,
- relevant real upstream log/error anchors are mirrored,
- missing/ambiguous anchor fails without partial writes,
- generated helper ownership conflict rolls back source edits,
- exact version is present in the integration's `tested` list.

When touching Kotlin instrumentation, compile a representative patched fixture with `kotlinc` when available. When touching generated Java helpers, compile with `javac` when practical.

## Repository hygiene

- Keep the package dependency-light. The CLI currently relies on Node built-ins intentionally.
- Do not commit `node_modules`, generated archives, build directories, or local fixture clones.
- Keep source files UTF-8 and line-ending agnostic.
- Do not put secrets or real production URLs/tokens in fixtures.
- Update `CHANGELOG.md` for user-visible behavior.
- Bump package version when shipping a release artifact.

## What not to do

Do not:

- add synthetic transfer/filesystem lifecycle events merely for visibility,
- monkey-patch application JS imports when native diagnostics can be observed directly,
- inject CDP/DevTools private protocol events,
- read unrestricted Android logcat from the application,
- parse or reinterpret arbitrary source behavior as domain events,
- introduce a mandatory dependency on RNFS, BlobUtil, or background-downloader,
- turn a failed patch into a warning and continue writing other files inside the same integration transaction,
- add broad fuzzy anchors that could match multiple upstream locations.

## Completion checklist for agents

Before declaring a task complete, report:

- files changed,
- integration/version matrix changed,
- tests run and their result,
- whether exact upstream tagged sources were inspected,
- whether release behavior remains no-op,
- any unverified platform/build limitation.

If any validation could not be executed, state that explicitly instead of claiming the package is verified.
