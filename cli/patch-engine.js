'use strict';

const fs = require('fs');
const path = require('path');

const START = '// @rn-native-debugger:start ';
const END = '// @rn-native-debugger:end ';
const GENERATED = '// @rn-native-debugger:generated';

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) !== -1) {
    count++;
    position += needle.length;
  }
  return count;
}

function markedBlock(id, body) {
  return `${START}${id}\n${body.trim()}\n${END}${id}`;
}

class PatchPlan {
  constructor(filePath) {
    this.filePath = filePath;
    this.original = fs.readFileSync(filePath, 'utf8');
    this.content = this.original;
    this.actions = [];
  }

  hasMarker(id) {
    return this.content.includes(`${START}${id}`);
  }

  insertAfter(id, anchor, body) {
    if (this.hasMarker(id)) {
      this.actions.push({ id, state: 'already-patched' });
      return this;
    }
    const count = countOccurrences(this.content, anchor);
    if (count !== 1) {
      throw new Error(`${path.basename(this.filePath)}: anchor for ${id} expected once, found ${count}`);
    }
    const replacement = `${anchor}\n${markedBlock(id, body)}`;
    this.content = this.content.replace(anchor, replacement);
    this.actions.push({ id, state: 'patched' });
    return this;
  }

  insertBefore(id, anchor, body) {
    if (this.hasMarker(id)) {
      this.actions.push({ id, state: 'already-patched' });
      return this;
    }
    const count = countOccurrences(this.content, anchor);
    if (count !== 1) {
      throw new Error(`${path.basename(this.filePath)}: anchor for ${id} expected once, found ${count}`);
    }
    const replacement = `${markedBlock(id, body)}\n${anchor}`;
    this.content = this.content.replace(anchor, replacement);
    this.actions.push({ id, state: 'patched' });
    return this;
  }

  commit() {
    if (this.content !== this.original) {
      fs.writeFileSync(this.filePath, this.content);
    }
    return this.actions;
  }
}

function removeInjectedBlocks(content) {
  const lines = content.split(/\r?\n/);
  const out = [];
  let skipping = false;
  let currentId = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!skipping && trimmed.startsWith(START)) {
      skipping = true;
      currentId = trimmed.slice(START.length);
      if (!currentId) throw new Error('Malformed react-native-native-debugger start marker');
      continue;
    }
    if (skipping && trimmed.startsWith(START)) {
      throw new Error(`Nested react-native-native-debugger marker while removing ${currentId}`);
    }
    if (skipping && trimmed.startsWith(END) && trimmed !== `${END}${currentId}`) {
      throw new Error(`Mismatched react-native-native-debugger end marker for ${currentId}`);
    }
    if (skipping && trimmed === `${END}${currentId}`) {
      skipping = false;
      currentId = null;
      continue;
    }
    if (!skipping) out.push(line);
  }

  if (skipping) {
    throw new Error(`Unterminated react-native-native-debugger marker for ${currentId}`);
  }
  return out.join('\n');
}

function unpatchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const original = fs.readFileSync(filePath, 'utf8');
  const next = removeInjectedBlocks(original);
  if (next === original) return false;
  fs.writeFileSync(filePath, next);
  return true;
}


function assertGeneratedFileWritable(filePath) {
  if (!fs.existsSync(filePath)) return;
  const current = fs.readFileSync(filePath, 'utf8');
  if (!current.startsWith(GENERATED)) {
    throw new Error(`Refusing to overwrite non-generated file: ${filePath}`);
  }
}

function commitTransaction(plans, generatedFiles = []) {
  const sourceSnapshots = (plans || []).map((plan) => ({
    filePath: plan.filePath,
    content: plan.original
  }));
  const generatedSnapshots = generatedFiles.map(({ filePath }) => ({
    filePath,
    existed: fs.existsSync(filePath),
    content: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null
  }));

  // Validate ownership before the first write.
  for (const { filePath } of generatedFiles) assertGeneratedFileWritable(filePath);

  try {
    const results = [];
    for (const plan of plans || []) results.push(plan.commit());
    for (const generated of generatedFiles) {
      writeGeneratedFile(generated.filePath, generated.content);
    }
    return results;
  } catch (error) {
    // Best-effort rollback. Never leave a half-instrumented dependency behind.
    for (const snapshot of sourceSnapshots) {
      try { fs.writeFileSync(snapshot.filePath, snapshot.content); } catch (_) {}
    }
    for (const snapshot of generatedSnapshots) {
      try {
        if (snapshot.existed) fs.writeFileSync(snapshot.filePath, snapshot.content);
        else if (fs.existsSync(snapshot.filePath)) fs.unlinkSync(snapshot.filePath);
      } catch (_) {}
    }
    throw error;
  }
}

function writeGeneratedFile(filePath, content) {
  assertGeneratedFileWritable(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${GENERATED}\n${content.trim()}\n`);
}

function removeGeneratedFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.startsWith(GENERATED)) return false;
  fs.unlinkSync(filePath);
  return true;
}

function markerStatus(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, markers: 0 };
  const content = fs.readFileSync(filePath, 'utf8');
  return { exists: true, markers: countOccurrences(content, START) };
}

module.exports = {
  START,
  END,
  GENERATED,
  PatchPlan,
  assertGeneratedFileWritable,
  commitTransaction,
  countOccurrences,
  markerStatus,
  removeGeneratedFile,
  removeInjectedBlocks,
  unpatchFile,
  writeGeneratedFile
};
