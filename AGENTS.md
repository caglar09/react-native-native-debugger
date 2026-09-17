# AGENTS.md

This file is the canonical development contract for AI coding agents and human contributors working on `react-native-native-debugger`.

## Mission

`react-native-native-debugger` is a **development-only native instrumentation package** for React Native. It instruments selected third-party native modules in `node_modules`, emits structured lifecycle events, buffers them natively, and forwards them to JavaScript so React Native DevTools Console can display them.

The package must never change production behavior, transfer semantics, retry behavior, file contents, request bodies, or application business logic.

## Core architecture

```text
optional native dependency
  -> source patch with guarded instrumentation only
  -> Android RNNDInstrumentation / iOS NSNotificationCenter
  -> NativeDebugSink
  -> bounded native buffer + optional debug persistence
  -> NativeEventEmitter
  -> JS console transport / custom subscriber
```

Important boundaries:

1. Patched third-party packages must **not** acquire a compile-time dependency on this package.
2. Android integration helpers call `com.rnnativedebugger.NativeDebugSink` through reflection.
3. iOS integration patches post `RNNativeDebuggerInstrumentationEvent` using `NSNotificationCenter` under `#if DEBUG`.
4. Release builds must be no-op / compile-out for instrumentation.
5. Patch failure must never leave a dependency half-modified.

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

- Patch the smallest possible native lifecycle points.
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

## Adding a new package version

Follow this sequence:

1. Inspect the exact upstream tag/commit, not only the latest branch.
2. Record native file paths for Android and iOS.
3. Compare each existing semantic anchor against the exact target source.
4. If all anchors are identical and semantics are unchanged, add the version to `tested`.
5. If any native structure differs, create a version-specific or package-specific adapter instead of weakening anchors.
6. Add a regression test representing the validated source shape.
7. Run `npm test`.
8. Run syntax/type compilation for any generated Android helper and changed Kotlin/Java instrumentation snippets when practical.
9. Run `npm pack --dry-run` and inspect the file list.
10. Update README support matrix and CHANGELOG.

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

Prefer a separate adapter when:

- package names differ,
- Java package namespaces differ,
- Java vs Kotlin implementation differs,
- iOS file layout differs,
- lifecycle semantics differ materially.

Do not force unrelated packages into one adapter merely because their public JS API is similar.

## Event conventions

Events should follow this shape conceptually:

```text
integration: package identity
category: download | upload | network | filesystem | native
 event: started | request | response | progress | enqueued | completed | failed | ...
 data: structured metadata only
```

Guidelines:

- Prefer stable task IDs, URL, destination, status, byte counts, transport, and error class/code.
- Do not bridge request/response bodies by default.
- Never log authorization headers, cookies, passwords, tokens, API keys, or secrets.
- Keep progress instrumentation throttled. Large transfers must not flood the JS bridge.
- Instrumentation must be observational; never alter control flow to produce a log.

## Android rules

- Generated helper class: `RNNDInstrumentation.java` in the target dependency package namespace.
- The helper uses reflection so the patched dependency has no direct Gradle dependency on this library.
- Catch all reflection/instrumentation failures and silently degrade to no-op.
- The helper must check `NativeDebugSink.COMPILED_DEBUG` and runtime `isEnabled()` before emitting.
- For Kotlin dependencies, a generated public Java helper is acceptable when it lives in the same package and is compiled by the same Android module.

## iOS rules

- Inject only code guarded by `#if DEBUG`.
- Do not import this library into patched pods.
- Use `NSNotificationCenter` event `RNNativeDebuggerInstrumentationEvent`.
- Keep payloads property-list / React Native bridge friendly: strings, numbers, booleans, arrays, dictionaries, null-safe values.
- Be careful with background `NSURLSession`: callbacks can arrive before JS is ready, which is why the native sink owns buffering.

## Native core rules

Changes under `android/`, `ios/`, `index.js`, or `index.d.ts` must preserve:

- bounded buffering,
- thread safety,
- replay semantics,
- debug-only persistence,
- recursive secret redaction in JS console output,
- listener lifecycle correctness,
- compatibility with a missing optional integration.

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
- missing/ambiguous anchor fails without partial writes,
- generated helper ownership conflict rolls back source edits,
- exact version is present in the integration's `tested` list.

When touching Kotlin instrumentation, compile a representative patched fixture with `kotlinc` when available. When touching generated Java helpers, compile with `javac` against minimal stubs when practical.

## Repository hygiene

- Keep the package dependency-light. The CLI currently relies on Node built-ins intentionally.
- Do not commit `node_modules`, generated archives, build directories, or local fixture clones.
- Keep source files UTF-8 and line-ending agnostic.
- Do not put secrets or real production URLs/tokens in fixtures.
- Update `CHANGELOG.md` for user-visible behavior.
- Bump package version when shipping a release artifact.

## What not to do

Do not:

- monkey-patch application JS imports when native instrumentation can observe the real lifecycle,
- inject CDP/DevTools private protocol events,
- read unrestricted Android logcat from the application,
- parse arbitrary native log strings when a structured event can be emitted instead,
- introduce a mandatory dependency on RNFS, BlobUtil, or background-downloader,
- turn a failed patch into a warning and continue writing other files inside the same integration transaction,
- add broad fuzzy anchors that could match multiple upstream locations.

## Completion checklist for agents

Before declaring a task complete, report:

- files changed,
- integration/version matrix changed,
- tests run and their result,
- whether exact upstream tagged sources were validated,
- whether release behavior remains no-op,
- any unverified platform/build limitation.

If any validation could not be executed, state that explicitly instead of claiming the package is verified.
