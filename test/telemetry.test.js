'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionInfo, sampleMetrics, parseHostPsSample } = require('../cli/logs/telemetry');

test('createSessionInfo returns app and device metadata without app-specific rules', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnnd-telemetry-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'example-app',
    version: '1.2.3',
    dependencies: { react: '19.1.0', 'react-native': '0.83.0' }
  }));

  const collector = {
    platform: 'ios-device',
    app: null,
    command: 'idevicesyslog'
  };

  const session = await createSessionInfo({
    collector,
    root,
    device: 'device-1',
    processName: 'ExampleApp'
  });

  assert.equal(session.device.platform, 'ios');
  assert.equal(session.device.simulator, false);
  assert.equal(session.app.name, 'example-app');
  assert.equal(session.app.version, '1.2.3');
  assert.equal(session.app.reactNativeVersion, '0.83.0');
  assert.equal(session.app.primaryProcess, 'ExampleApp');
  assert.equal(session.collector.command, 'idevicesyslog');
  assert.equal(typeof session.metro.connected, 'boolean');

  fs.rmSync(root, { recursive: true, force: true });
});

test('physical iOS metrics degrade explicitly when unavailable', () => {
  const result = sampleMetrics({
    collector: { platform: 'ios-device' },
    device: 'device-1',
    processName: 'ExampleApp'
  });

  assert.equal(result.available, false);
  assert.equal(result.process, 'ExampleApp');
  assert.equal(typeof result.timestamp, 'number');
});


test('dashboard exposes session and per-process metrics endpoints', async () => {
  const http = require('node:http');
  const { startDashboard } = require('../cli/logs/dashboard');
  const dashboard = await startDashboard({ host: '127.0.0.1', port: 0, open: false });
  dashboard.setSessionProvider(() => ({ app: { name: 'ExampleApp' } }));
  dashboard.setMetricsProvider((processName) => ({ available: true, process: processName, memoryBytes: 1234 }));

  const port = new URL(dashboard.url).port;
  const get = (pathname) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${pathname}`, (response) => {
      let body = '';
      response.on('data', (chunk) => body += chunk);
      response.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });

  assert.equal((await get('/session')).app.name, 'ExampleApp');
  const metrics = await get('/metrics?process=ExampleApp');
  assert.equal(metrics.process, 'ExampleApp');
  assert.equal(metrics.memoryBytes, 1234);

  await dashboard.close();
});


test('parseHostPsSample parses macOS ps RSS and CPU columns', () => {
  assert.deepEqual(parseHostPsSample('  184320   12.5'), { rssKb: 184320, cpuPercent: 12.5 });
  assert.equal(parseHostPsSample(''), null);
  assert.equal(parseHostPsSample('garbage'), null);
});
