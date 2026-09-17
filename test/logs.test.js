'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { parseAndroidLine, parseIosLine, inferIosLevel, classifySource, extractLocation } = require('../cli/logs/parser');
const { readApplicationId } = require('../cli/logs/collectors');
const { startDashboard } = require('../cli/logs/dashboard');

test('parseAndroidLine parses threadtime output', () => {
  const event = parseAndroidLine('09-17 19:40:01.123  1234  1250 E ReactNativeBlobUtil: socket closed');
  assert.equal(event.level, 'error');
  assert.equal(event.pid, 1234);
  assert.equal(event.tag, 'ReactNativeBlobUtil');
  assert.equal(event.message, 'socket closed');
  assert.equal(event.package, 'react-native-blob-util');
  assert.equal(event.service, 'ReactNativeBlobUtil');
});

test('parseAndroidLine preserves unknown lines', () => {
  assert.equal(parseAndroidLine('hello').message, 'hello');
});

test('inferIosLevel identifies common levels and compact codes', () => {
  assert.equal(inferIosLevel('Error thing'), 'error');
  assert.equal(inferIosLevel('Debug thing'), 'debug');
  assert.equal(inferIosLevel('Warning thing'), 'warn');
  assert.equal(inferIosLevel('2026-09-17 20:55:54.983 Db App[1:2] [x:y] z'), 'debug');
});

test('parseIosLine preserves raw log content', () => {
  const event = parseIosLine('2026-09-17 19:40:00.000+0300 App[100:200] (subsystem) Tag: Error happened');
  assert.equal(event.platform, 'ios');
  assert.match(event.raw, /Error happened/);
});

test('parseIosLine parses compact unified logging metadata', () => {
  const event = parseIosLine('2026-09-17 20:55:54.983 Db LenaFieldRN[32921:1dfc2d] [com.apple.network:] sa_dst_compare_internal <private>@0 < <private>@0');
  assert.equal(event.platform, 'ios');
  assert.equal(event.level, 'debug');
  assert.equal(event.process, 'LenaFieldRN');
  assert.equal(event.pid, 32921);
  assert.equal(event.tid, '1dfc2d');
  assert.equal(event.subsystem, 'com.apple.network');
  assert.equal(event.category, '');
  assert.equal(event.function, 'sa_dst_compare_internal');
  assert.equal(event.package, 'Apple System');
  assert.equal(event.service, 'com.apple.network');
  assert.equal(event.sourceKind, 'system');
});

test('parseIosLine captures source library when present', () => {
  const event = parseIosLine('2026-09-17 20:55:54.983 Er LenaFieldRN[32921:1dfc2d] (Network) [com.apple.network:connection] nw_connection_copy_connected_local_endpoint failed');
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
  assert.deepEqual(
    extractLocation('com.example.Worker.run(Worker.java:88)'),
    { className: 'com.example.Worker', method: 'run', file: 'Worker.java', line: 88 }
  );
});

test('readApplicationId reads Gradle applicationId', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnnd-'));
  fs.mkdirSync(path.join(root, 'android/app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'android/app/build.gradle'), 'android { defaultConfig { applicationId "com.demo.app" } }');
  assert.equal(readApplicationId(root), 'com.demo.app');
  fs.rmSync(root, { recursive: true, force: true });
});

test('dashboard serves UI health endpoint', async () => {
  const dashboard = await startDashboard({ host: '127.0.0.1', port: 0, open: false });
  const port = new URL(dashboard.url).port;
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/health`, (response) => {
      let value = '';
      response.on('data', (chunk) => value += chunk);
      response.on('end', () => resolve(value));
    }).on('error', reject);
  });
  assert.equal(body, '{"ok":true}');
  await dashboard.close();
});
