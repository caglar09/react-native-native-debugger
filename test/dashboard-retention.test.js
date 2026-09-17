'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function loadRetention() {
  return import('../cli/dashboard/src/retention.mjs');
}

function makeEvent(id, level) {
  return { id, level, receivedAt: id };
}

test('severity-aware retention keeps total buffer bounded', async () => {
  const { MAX_BUFFER, trimRetainedBuffer } = await loadRetention();
  const buffer = [];
  for (let i = 0; i < 7000; i += 1) buffer.unshift(makeEvent(i, 'debug'));
  trimRetainedBuffer(buffer, MAX_BUFFER);
  assert.equal(buffer.length, MAX_BUFFER);
});

test('debug/info floods do not evict protected error history', async () => {
  const { MAX_BUFFER, trimRetainedBuffer } = await loadRetention();
  const buffer = [];

  for (let i = 0; i < 1000; i += 1) buffer.unshift(makeEvent(i, 'error'));
  for (let i = 1000; i < 9000; i += 1) {
    buffer.unshift(makeEvent(i, i % 2 === 0 ? 'debug' : 'info'));
    trimRetainedBuffer(buffer, MAX_BUFFER);
  }

  assert.equal(buffer.length, MAX_BUFFER);
  assert.equal(buffer.filter((event) => event.level === 'error').length, 1000);
});

test('warn and fatal histories receive protected retention floors', async () => {
  const { MAX_BUFFER, RETENTION_FLOORS, trimRetainedBuffer } = await loadRetention();
  const buffer = [];
  let id = 0;

  for (let i = 0; i < RETENTION_FLOORS.fatal; i += 1) buffer.unshift(makeEvent(id++, 'fatal'));
  for (let i = 0; i < RETENTION_FLOORS.warn; i += 1) buffer.unshift(makeEvent(id++, 'warn'));
  for (let i = 0; i < 7000; i += 1) {
    buffer.unshift(makeEvent(id++, 'default'));
    trimRetainedBuffer(buffer, MAX_BUFFER);
  }

  assert.equal(buffer.filter((event) => event.level === 'fatal').length, RETENTION_FLOORS.fatal);
  assert.equal(buffer.filter((event) => event.level === 'warn').length, RETENTION_FLOORS.warn);
  assert.equal(buffer.length, MAX_BUFFER);
});
