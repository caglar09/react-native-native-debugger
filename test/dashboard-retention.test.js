'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('dashboard store keeps the full session until Clear', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../cli/dashboard/src/store.js'),
    'utf8'
  );

  assert.doesNotMatch(source, /MAX_BUFFER/);
  assert.doesNotMatch(source, /trimRetainedBuffer/);
  assert.match(source, /this\.buffer\.unshift\(event\)/);
});

test('Clear remains the explicit buffer reset', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../cli/dashboard/src/store.js'),
    'utf8'
  );

  assert.match(source, /clear\(\)\s*\{/);
  assert.match(source, /this\.buffer = \[\]/);
});
