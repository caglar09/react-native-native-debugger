'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { NativeLogSession } = require('../cli/logs/session-store');
const { startDashboard } = require('../cli/logs/dashboard');
const { DashboardClient } = require('../cli/mcp/dashboard-client');

function event(overrides = {}) {
  return {
    id: overrides.id || Math.random().toString(36).slice(2),
    receivedAt: overrides.receivedAt || Date.now(),
    platform: 'android',
    level: 'info',
    process: 'com.example.app',
    package: 'react-native',
    service: 'React Native',
    tag: 'Example',
    message: 'hello',
    ...overrides
  };
}

test('NativeLogSession defaults to app-scoped searches and preserves stable ids', () => {
  const session = new NativeLogSession();
  session.push(event({ id: 'app-error', level: 'error', message: 'upload socket timeout' }));
  session.push(event({ id: 'system-error', process: 'system_server', package: 'Android System', level: 'error', message: 'unrelated failure' }));

  const app = { name: 'Example', bundleId: 'com.example.app', primaryProcess: 'com.example.app' };
  const result = session.search({ levels: ['error'] }, app);

  assert.equal(result.scope, 'app');
  assert.equal(result.scopeApplied, true);
  assert.equal(result.totalMatches, 1);
  assert.equal(result.logs[0].id, 'app-error');

  const all = session.search({ scope: 'all', levels: ['error'] }, app);
  assert.equal(all.totalMatches, 2);
});

test('NativeLogSession returns chronological context around a log id', () => {
  const session = new NativeLogSession();
  session.push(event({ id: 'older', receivedAt: 1000, message: 'older' }));
  session.push(event({ id: 'target', receivedAt: 2000, message: 'target' }));
  session.push(event({ id: 'newer', receivedAt: 3000, message: 'newer' }));

  const result = session.context('target', { before: 1, after: 1 });
  assert.deepEqual(result.context.map((row) => row.id), ['older', 'target', 'newer']);
});

test('NativeLogSession groups repeated native errors and crash signals', () => {
  const session = new NativeLogSession();
  const app = { bundleId: 'com.example.app', primaryProcess: 'com.example.app' };

  session.push(event({ id: 'e1', level: 'error', message: 'ECONNRESET request 123456 failed' }));
  session.push(event({ id: 'e2', level: 'error', message: 'ECONNRESET request 987654 failed' }));
  session.push(event({ id: 'fatal', level: 'fatal', message: 'FATAL EXCEPTION: main' }));

  const result = session.errorGroups({ scope: 'app', limit: 10 }, app);
  assert.equal(result.totalErrorMatches, 3);
  assert.equal(result.groups.some((group) => group.count === 2), true);
  assert.equal(result.groups.some((group) => group.crashSignal === true), true);
});

test('NativeLogSession stores runtime telemetry separately from searchable logs', () => {
  const session = new NativeLogSession();
  session.push(event({
    id: 'telemetry',
    kind: 'runtime-telemetry',
    telemetry: {
      available: true,
      process: 'com.example.app',
      pid: 42,
      fps: 58.5,
      residentMemoryBytes: 1000
    }
  }));

  assert.equal(session.search({ scope: 'all' }, {}).totalCaptured, 0);
  assert.equal(session.runtime('com.example.app').fps, 58.5);
  assert.equal(session.runtime('com.example.app').pid, 42);
});

test('dashboard observability API is consumable by MCP DashboardClient', async () => {
  const session = new NativeLogSession();
  const app = { name: 'Example', bundleId: 'com.example.app', primaryProcess: 'com.example.app' };
  session.push(event({ id: 'native-error', level: 'error', message: 'socket timeout', network: { protocol: 'HTTP' } }));

  const dashboard = await startDashboard({ host: '127.0.0.1', port: 0, open: false });
  dashboard.setSessionProvider(() => ({ app, device: { platform: 'android' }, metro: { connected: true, port: 8081 } }));
  dashboard.setMetricsProvider(() => ({ available: true, process: 'com.example.app', memoryBytes: 2048, cpuPercent: 2.5 }));
  dashboard.setProcessProvider(() => [{ pid: 42, name: 'com.example.app' }]);
  dashboard.setProcessMetricsProvider(() => [{ pid: 42, process: 'com.example.app', memoryBytes: 2048, cpuPercent: 2.5 }]);
  dashboard.setObservabilityProvider({
    searchLogs: (options) => session.search(options, app),
    logContext: (id, options) => session.context(id, options),
    errorGroups: (options) => session.errorGroups(options, app),
    stats: () => session.stats(),
    runtime: () => ({ available: true, process: 'com.example.app', fps: 60 })
  });

  const client = new DashboardClient(dashboard.url);
  assert.equal((await client.health()).ok, true);
  assert.equal((await client.searchLogs({ levels: ['error'] })).logs[0].id, 'native-error');
  assert.equal((await client.logContext('native-error')).target.id, 'native-error');
  assert.equal((await client.errorGroups()).totalErrorMatches, 1);
  assert.equal((await client.runtime('com.example.app')).fps, 60);

  await dashboard.close();
});

test('MCP server source registers evidence-first tools, resources, and prompt', () => {
  const source = fs.readFileSync(path.join(__dirname, '../cli/mcp/index.js'), 'utf8');

  for (const name of [
    'native_debugger_status',
    'search_native_logs',
    'get_native_log_context',
    'get_recent_native_errors',
    'list_native_processes',
    'get_runtime_telemetry',
    'get_network_evidence'
  ]) {
    assert.match(source, new RegExp(name));
  }

  assert.match(source, /rnnd:\/\/session/);
  assert.match(source, /rnnd:\/\/errors\/recent/);
  assert.match(source, /diagnose-native-issue/);
  assert.match(source, /StdioServerTransport/);
});
