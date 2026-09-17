'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');
const { parseAndroidLine, parseIosLine } = require('./parser');

function commandExists(command) {
  const result = spawnSync(command, ['--help'], { stdio: 'ignore' });
  return !result.error;
}

function readApplicationId(root) {
  const candidates = [
    path.join(root, 'android/app/build.gradle'),
    path.join(root, 'android/app/build.gradle.kts')
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const match = source.match(/applicationId\s*(?:=\s*)?["']([^"']+)["']/);
    if (match) return match[1];
  }
  return null;
}

function getAndroidPid(appId, serial) {
  if (!appId) return null;
  const args = [];
  if (serial) args.push('-s', serial);
  args.push('shell', 'pidof', appId);
  const result = spawnSync('adb', args, { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const first = String(result.stdout || '').trim().split(/\s+/)[0];
  return /^\d+$/.test(first) ? first : null;
}

function normalizeProcesses(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item || !item.name) return false;
    const key = `${item.pid || ''}:${item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)) || Number(a.pid || 0) - Number(b.pid || 0));
}

function listAndroidProcesses(serial) {
  const args = [];
  if (serial) args.push('-s', serial);
  args.push('shell', 'ps', '-A', '-o', 'PID,NAME');
  let result = spawnSync('adb', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const fallback = [];
    if (serial) fallback.push('-s', serial);
    fallback.push('shell', 'ps', '-A');
    result = spawnSync('adb', fallback, { encoding: 'utf8' });
  }
  if (result.status !== 0) return [];
  const rows = String(result.stdout || '').split(/\r?\n/).slice(1);
  const items = [];
  for (const row of rows) {
    const trimmed = row.trim();
    if (!trimmed) continue;
    const columns = trimmed.split(/\s+/);
    let pid = Number(columns[0]);
    let name = columns.slice(1).join(' ');
    if (!Number.isFinite(pid)) {
      const pidIndex = columns.findIndex((value) => /^\d+$/.test(value));
      if (pidIndex < 0) continue;
      pid = Number(columns[pidIndex]);
      name = columns[columns.length - 1];
    }
    items.push({ pid, name: path.basename(name || '') });
  }
  return normalizeProcesses(items);
}

function listIosSimulatorProcesses(target = 'booted') {
  const result = spawnSync('xcrun', ['simctl', 'spawn', target, 'ps', '-axo', 'pid=,comm='], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  const items = [];
  for (const row of String(result.stdout || '').split(/\r?\n/)) {
    const match = row.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const command = match[2];
    items.push({ pid: Number(match[1]), name: path.basename(command), command });
  }
  return normalizeProcesses(items);
}

function lineReader(child, onLine, onError) {
  const stdout = readline.createInterface({ input: child.stdout });
  stdout.on('line', onLine);
  const stderr = readline.createInterface({ input: child.stderr });
  stderr.on('line', (line) => onError(String(line)));
  return () => { stdout.close(); stderr.close(); };
}

function startAndroidCollector(options) {
  if (!commandExists('adb')) throw new Error('adb was not found. Install Android platform-tools and ensure adb is on PATH.');
  const appId = options.app || readApplicationId(options.root);
  const args = [];
  if (options.device) args.push('-s', options.device);
  args.push('logcat', '-v', 'threadtime');
  // Only constrain logcat when the user explicitly requested an app. Auto-detected app ids
  // remain metadata so the dashboard can still inspect related system processes.
  const pid = options.app ? getAndroidPid(options.app, options.device) : null;
  if (pid) args.push(`--pid=${pid}`);

  const child = spawn('adb', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const closeReader = lineReader(child,
    (line) => options.onEvent({ ...parseAndroidLine(line), app: appId || undefined }),
    (message) => options.onDiagnostic({ platform: 'android', level: 'error', tag: 'collector', message })
  );
  child.on('exit', (code, signal) => options.onExit({ platform: 'android', code, signal }));
  return {
    platform: 'android', app: appId, pid, command: `adb ${args.join(' ')}`,
    listProcesses() { return listAndroidProcesses(options.device); },
    stop() { closeReader(); if (!child.killed) child.kill('SIGTERM'); }
  };
}

function startIosSimulatorCollector(options) {
  if (!commandExists('xcrun')) throw new Error('xcrun was not found. Install Xcode Command Line Tools.');
  const target = options.device || 'booted';
  const args = ['simctl', 'spawn', target, 'log', 'stream', '--style', 'compact', '--level', 'debug'];
  if (options.process) args.push('--predicate', `process == "${String(options.process).replace(/"/g, '\\"')}"`);
  const child = spawn('xcrun', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const closeReader = lineReader(child,
    (line) => options.onEvent(parseIosLine(line)),
    (message) => options.onDiagnostic({ platform: 'ios', level: 'error', tag: 'collector', message })
  );
  child.on('exit', (code, signal) => options.onExit({ platform: 'ios', code, signal }));
  return {
    platform: 'ios', target, command: `xcrun ${args.join(' ')}`,
    listProcesses() { return listIosSimulatorProcesses(target); },
    stop() { closeReader(); if (!child.killed) child.kill('SIGTERM'); }
  };
}

function startIosDeviceCollector(options) {
  if (!commandExists('idevicesyslog')) {
    throw new Error('Physical iOS log streaming requires idevicesyslog (libimobiledevice) on PATH. Use --ios-simulator for Simulator, or install libimobiledevice.');
  }
  const args = [];
  if (options.device) args.push('-u', options.device);
  const child = spawn('idevicesyslog', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const closeReader = lineReader(child,
    (line) => options.onEvent(parseIosLine(line)),
    (message) => options.onDiagnostic({ platform: 'ios', level: 'error', tag: 'collector', message })
  );
  child.on('exit', (code, signal) => options.onExit({ platform: 'ios', code, signal }));
  return {
    platform: 'ios-device', command: `idevicesyslog ${args.join(' ')}`,
    // idevicesyslog exposes the log stream but not a portable process-list API. The UI
    // still discovers process names from observed log records for physical devices.
    listProcesses() { return []; },
    stop() { closeReader(); if (!child.killed) child.kill('SIGTERM'); }
  };
}

module.exports = {
  readApplicationId,
  getAndroidPid,
  listAndroidProcesses,
  listIosSimulatorProcesses,
  startAndroidCollector,
  startIosSimulatorCollector,
  startIosDeviceCollector
};
