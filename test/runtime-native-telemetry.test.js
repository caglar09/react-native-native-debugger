'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Android runtime telemetry stays debug-gated and emits structured markers', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../android/src/main/java/com/rnnativedebugger/RuntimeTelemetry.java'),
    'utf8'
  );

  assert.match(source, /BuildConfig\.DEBUG/);
  assert.match(source, /RNND_TELEMETRY/);
  assert.match(source, /Debug\.getMemoryInfo/);
  assert.match(source, /getElapsedCpuTime/);
  assert.match(source, /Choreographer/);
  assert.match(source, /getCurrentThermalStatus/);
});

test('iOS runtime telemetry stays DEBUG-only and measures native process resources', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../ios/RNNativeDebuggerRuntimeTelemetry.m'),
    'utf8'
  );

  assert.match(source, /#if DEBUG/);
  assert.match(source, /RNND_TELEMETRY/);
  assert.match(source, /TASK_VM_INFO/);
  assert.match(source, /task_threads/);
  assert.match(source, /CADisplayLink/);
  assert.match(source, /thermalState/);
});

test('runtime telemetry is surfaced through the public JS API', () => {
  const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

  assert.match(source, /startRuntimeTelemetry/);
  assert.match(source, /stopRuntimeTelemetry/);
  assert.match(source, /getRuntimeMetrics/);
  assert.match(source, /telemetryIntervalMs/);
});
