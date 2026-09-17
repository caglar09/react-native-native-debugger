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
  const pid = getAndroidPid(appId, options.device);
  if (pid) args.push(`--pid=${pid}`);

  const child = spawn('adb', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const closeReader = lineReader(child,
    (line) => options.onEvent({ ...parseAndroidLine(line), app: appId || undefined }),
    (message) => options.onDiagnostic({ platform: 'android', level: 'error', tag: 'collector', message })
  );
  child.on('exit', (code, signal) => options.onExit({ platform: 'android', code, signal }));
  return {
    platform: 'android', app: appId, pid, command: `adb ${args.join(' ')}`,
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
    stop() { closeReader(); if (!child.killed) child.kill('SIGTERM'); }
  };
}

module.exports = { readApplicationId, getAndroidPid, startAndroidCollector, startIosSimulatorCollector, startIosDeviceCollector };
