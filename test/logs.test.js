'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { parseAndroidLine, parseIosLine, inferIosLevel, classifySource, extractLocation, extractRuntimeTelemetry, extractNetworkMetadata } = require('../cli/logs/parser');
const { readApplicationId } = require('../cli/logs/collectors');
const { startDashboard, INDEX_FILE } = require('../cli/logs/dashboard');

test('parseAndroidLine parses threadtime output', () => {
  const event = parseAndroidLine('09-17 19:40:01.123  1234  1250 E ReactNativeBlobUtil: socket closed');
  assert.equal(event.level, 'error');
  assert.equal(event.pid, 1234);
  assert.equal(event.tag, 'ReactNativeBlobUtil');
  assert.equal(event.message, 'socket closed');
  assert.equal(event.package, 'react-native-blob-util');
  assert.equal(event.service, 'ReactNativeBlobUtil');
});

test('parseAndroidLine preserves colon-bearing Android tags', () => {
  const event = parseAndroidLine('09-18 09:48:53.918  7443  7443 E unknown:BridgelessReactContext: \\tat com.facebook.react.modules.core.ReactChoreographer.doFrame(ReactChoreographer.java:42)');
  assert.equal(event.pid, 7443);
  assert.equal(event.tag, 'unknown:BridgelessReactContext');
  assert.match(event.message, /ReactChoreographer/);
  assert.equal(event.package, 'react-native');
  assert.equal(event.service, 'React Native');
});

test('source classification falls back to resolved Android process instead of Unknown', () => {
  const event = classifySource({ platform: 'android', process: 'com.example.app', tag: 'CustomNativeTag', message: 'boom' });
  assert.equal(event.package, 'com.example.app');
  assert.equal(event.service, 'CustomNativeTag');
  assert.equal(event.packageConfidence, 'process');
});

test('parseAndroidLine preserves unknown lines', () => {
  assert.equal(parseAndroidLine('hello').message, 'hello');
});

test('runtime telemetry marker is parsed as structured telemetry instead of a normal log', () => {
  const event = parseAndroidLine('09-18 10:00:00.000  7443  7443 I RNNativeDebuggerTelemetry: RNND_TELEMETRY {"available":true,"process":"ExampleApp","pid":7443,"fps":59.8,"residentMemoryBytes":123456}');
  assert.equal(event.kind, 'runtime-telemetry');
  assert.equal(event.telemetry.process, 'ExampleApp');
  assert.equal(event.telemetry.pid, 7443);
  assert.equal(event.telemetry.fps, 59.8);
  assert.equal(event.package, 'react-native-native-debugger');
});

test('network evidence is extracted only from emitted log content', () => {
  const metadata = extractNetworkMetadata('CFNetwork TLS 1.3 QUIC ECONNRESET remote 17.253.144.10:443 https://example.com/data');
  assert.equal(metadata.protocol, 'QUIC');
  assert.equal(metadata.tlsVersion, 'TLS 1.3');
  assert.equal(metadata.errorCode, 'ECONNRESET');
  assert.equal(metadata.endpoint, '17.253.144.10:443');
  assert.equal(metadata.url, 'https://example.com/data');
  assert.equal(extractNetworkMetadata('plain application log'), null);
});

test('runtime telemetry helper rejects malformed marker payloads', () => {
  assert.equal(extractRuntimeTelemetry('RNND_TELEMETRY not-json'), null);
  assert.deepEqual(extractRuntimeTelemetry('prefix RNND_TELEMETRY {"cpuPercent":12.5}'), { cpuPercent: 12.5 });
});

test('inferIosLevel identifies words, one-letter priorities, and compact codes', () => {
  assert.equal(inferIosLevel('Error thing'), 'error');
  assert.equal(inferIosLevel('Debug thing'), 'debug');
  assert.equal(inferIosLevel('Warning thing'), 'warn');
  assert.equal(inferIosLevel('2026-09-17 20:55:54.983 Db App[1:2] [x:y] z'), 'debug');
  assert.equal(inferIosLevel('2026-09-17 21:17:46.665 E App[1:2] [x:y] z'), 'error');
});

test('parseIosLine preserves raw log content', () => {
  const event = parseIosLine('2026-09-17 19:40:00.000+0300 App[100:200] (subsystem) Tag: Error happened');
  assert.equal(event.platform, 'ios');
  assert.match(event.raw, /Error happened/);
});

test('parseIosLine parses compact unified logging metadata', () => {
  const event = parseIosLine('2026-09-17 20:55:54.983 Db ExampleApp[32921:1dfc2d] [com.apple.network:] sa_dst_compare_internal <private>@0 < <private>@0');
  assert.equal(event.level, 'debug');
  assert.equal(event.process, 'ExampleApp');
  assert.equal(event.pid, 32921);
  assert.equal(event.tid, '1dfc2d');
  assert.equal(event.subsystem, 'com.apple.network');
  assert.equal(event.package, 'Apple System');
});

test('parseIosLine accepts one-letter priority without app-specific rules', () => {
  const event = parseIosLine('2026-09-17 21:17:46.665 E ExampleApp[47238:1edbeb] [com.apple.CFNetwork:Default] TCP Conn Failed : error 0:61 [61]');
  assert.equal(event.level, 'error');
  assert.equal(event.process, 'ExampleApp');
  assert.equal(event.pid, 47238);
  assert.equal(event.tid, '1edbeb');
  assert.equal(event.subsystem, 'com.apple.CFNetwork');
  assert.equal(event.category, 'Default');
  assert.equal(event.package, 'Apple System');
  assert.equal(event.service, 'com.apple.CFNetwork');
});

test('parseIosLine captures source library when present', () => {
  const event = parseIosLine('2026-09-17 20:55:54.983 Er ExampleApp[32921:1dfc2d] (Network) [com.apple.network:connection] nw_connection_copy_connected_local_endpoint failed');
  assert.equal(event.sourceLibrary, 'Network');
  assert.equal(event.subsystem, 'com.apple.network');
  assert.equal(event.category, 'connection');
  assert.equal(event.level, 'error');
  assert.equal(event.service, 'Network');
});

test('source classification identifies known React Native libraries conservatively', () => {
  assert.deepEqual(
    classifySource({ tag: 'RNBackgroundDownloader', message: 'upload failed' }),
    { package: '@kesha-antonov/react-native-background-downloader', service: 'RNBackgroundDownloader', packageConfidence: 'high', sourceKind: 'library' }
  );
  assert.equal(classifySource({ tag: 'VisionCamera' }).package, 'react-native-vision-camera');
});

test('extractLocation captures native and JVM source locations when emitted', () => {
  assert.deepEqual(extractLocation('Downloader.mm:412 request failed'), { file: 'Downloader.mm', line: 412 });
  assert.deepEqual(extractLocation('com.example.Worker.run(Worker.java:88)'), { className: 'com.example.Worker', method: 'run', file: 'Worker.java', line: 88 });
});

test('readApplicationId reads Gradle applicationId', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnnd-'));
  fs.mkdirSync(path.join(root, 'android/app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'android/app/build.gradle'), 'android { defaultConfig { applicationId "com.demo.app" } }');
  assert.equal(readApplicationId(root), 'com.demo.app');
  fs.rmSync(root, { recursive: true, force: true });
});

test('React dashboard includes searchable facets and observability workbench views', () => {
  const dashboardRoot = path.join(__dirname, '../cli/dashboard');
  const appSource = fs.readFileSync(path.join(dashboardRoot, 'src/App.jsx'), 'utf8');
  assert.ok(fs.existsSync(path.join(dashboardRoot, 'src/store.js')));
  assert.ok(fs.existsSync(path.join(dashboardRoot, 'vite.config.mjs')));
  assert.match(appSource, /SearchableFacet/);
  assert.match(appSource, /Search processes/);
  assert.match(appSource, /Unified Stream/);
  assert.match(appSource, /Process Matrix/);
  assert.match(appSource, /Errors & Crashes/);
  assert.match(appSource, /Network Inspector/);
  assert.match(appSource, /process-metrics/);
  assert.match(appSource, /MODEL CONTEXT PROTOCOL/);
  assert.match(appSource, /Connect OpenCode/);
  assert.match(appSource, /Connect Codex CLI/);
  assert.match(appSource, /native_debugger_status/);
  assert.match(appSource, /window\.location\.pathname/);
});

test('dashboard serves health and process endpoints independently from UI build', async () => {
  const dashboard = await startDashboard({ host: '127.0.0.1', port: 0, open: false });
  dashboard.setProcessProvider(() => [{ pid: 42, name: 'ExampleApp' }]);
  const port = new URL(dashboard.url).port;
  const request = (pathname) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${pathname}`, (response) => {
      let value = '';
      response.on('data', (chunk) => value += chunk);
      response.on('end', () => resolve({ status: response.statusCode, body: value }));
    }).on('error', reject);
  });

  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).ok, true);
  assert.deepEqual(JSON.parse((await request('/processes')).body), [{ pid: 42, name: 'ExampleApp' }]);

  const root = await request('/');
  const mcpPage = await request('/mcp');
  if (fs.existsSync(INDEX_FILE)) {
    assert.equal(root.status, 200);
    assert.equal(mcpPage.status, 200);
  } else {
    assert.equal(root.status, 503);
    assert.equal(mcpPage.status, 503);
    assert.match(root.body, /yarn dashboard:build/);
  }

  await dashboard.close();
});
