'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PatchPlan, removeInjectedBlocks, writeGeneratedFile, removeGeneratedFile } = require('../cli/patch-engine');

test('PatchPlan is idempotent and removable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnnd-'));
  const file = path.join(dir, 'A.java');
  fs.writeFileSync(file, 'before\nANCHOR\nafter\n');

  new PatchPlan(file).insertAfter('test.id', 'ANCHOR', 'INJECTED').commit();
  const once = fs.readFileSync(file, 'utf8');
  assert.match(once, /@rn-native-debugger:start test\.id/);
  assert.equal((once.match(/INJECTED/g) || []).length, 1);

  new PatchPlan(file).insertAfter('test.id', 'ANCHOR', 'INJECTED').commit();
  const twice = fs.readFileSync(file, 'utf8');
  assert.equal((twice.match(/INJECTED/g) || []).length, 1);

  const cleaned = removeInjectedBlocks(twice);
  assert.doesNotMatch(cleaned, /INJECTED/);
  assert.match(cleaned, /ANCHOR/);
});

test('PatchPlan refuses ambiguous anchors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnnd-'));
  const file = path.join(dir, 'A.java');
  fs.writeFileSync(file, 'ANCHOR\nANCHOR\n');
  assert.throws(() => new PatchPlan(file).insertAfter('x', 'ANCHOR', 'x'), /expected once, found 2/);
});

test('generated helper protection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnnd-'));
  const generated = path.join(dir, 'RNNDInstrumentation.java');
  writeGeneratedFile(generated, 'class A {}');
  assert.match(fs.readFileSync(generated, 'utf8'), /@rn-native-debugger:generated/);
  assert.equal(removeGeneratedFile(generated), true);

  fs.writeFileSync(generated, 'class UserOwned {}');
  assert.throws(() => writeGeneratedFile(generated, 'class B {}'), /Refusing to overwrite/);
  assert.equal(removeGeneratedFile(generated), false);
});


test('removeInjectedBlocks refuses malformed markers without returning truncated source', () => {
  const source = 'before\n// @rn-native-debugger:start broken\ninside\nafter\n';
  assert.throws(() => removeInjectedBlocks(source), /Unterminated/);
});
