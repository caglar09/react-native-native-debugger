'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { parseAndroidLine, parseIosLine, inferIosLevel } = require('../cli/logs/parser');
const { readApplicationId } = require('../cli/logs/collectors');
const { startDashboard } = require('../cli/logs/dashboard');

test('parseAndroidLine parses threadtime output', () => {
  const event = parseAndroidLine('09-17 19:40:01.123  1234  1250 E ReactNativeBlobUtil: socket closed');
  assert.equal(event.level, 'error');
  assert.equal(event.pid, 1234);
  assert.equal(event.tag, 'ReactNativeBlobUtil');
  assert.equal(event.message, 'socket closed');
});

test('parseAndroidLine preserves unknown lines', () => {
  assert.equal(parseAndroidLine('hello').message, 'hello');
});

test('inferIosLevel identifies common levels', () => {
  assert.equal(inferIosLevel('Error thing'), 'error');
  assert.equal(inferIosLevel('Debug thing'), 'debug');
  assert.equal(inferIosLevel('Warning thing'), 'warn');
});

test('parseIosLine preserves raw log content', () => {
  const event = parseIosLine('2026-09-17 19:40:00.000+0300 App[100:200] (subsystem) Tag: Error happened');
  assert.equal(event.platform, 'ios');
  assert.match(event.raw, /Error happened/);
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
