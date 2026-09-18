'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { readApplicationId, listAndroidProcesses, listIosSimulatorProcesses } = require('./collectors');

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function readProjectPackage(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

function detectIosBundleId(root) {
  const ios = path.join(root, 'ios');
  if (!fs.existsSync(ios)) return null;
  const queue = [ios];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.endsWith('.xcodeproj') && !entry.name.endsWith('.xcworkspace') && !entry.name.includes('Pods')) queue.push(full);
        continue;
      }
      if (entry.name !== 'project.pbxproj') continue;
      const source = fs.readFileSync(full, 'utf8');
      const match = source.match(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/);
      if (match) return match[1].trim().replace(/^"|"$/g, '');
    }
  }
  return null;
}

function checkMetro(port = 8081) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/status', timeout: 600 }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({
        connected: res.statusCode === 200 && /packager-status:running/i.test(body),
        port
      }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ connected: false, port }); });
    req.on('error', () => resolve({ connected: false, port }));
  });
}

function androidArgs(serial, tail) {
  const args = [];
  if (serial) args.push('-s', serial);
  return args.concat(tail);
}

function getAndroidDeviceInfo(serial) {
  const prop = (key) => run('adb', androidArgs(serial, ['shell', 'getprop', key])) || null;
  const totalKb = Number((run('adb', androidArgs(serial, ['shell', 'cat', '/proc/meminfo']))
    .match(/MemTotal:\s+(\d+)\s+kB/i) || [])[1] || 0);
  return {
    platform: 'android',
    deviceName: prop('ro.product.model'),
    manufacturer: prop('ro.product.manufacturer'),
    model: prop('ro.product.device'),
    osVersion: prop('ro.build.version.release'),
    apiLevel: prop('ro.build.version.sdk'),
    architecture: prop('ro.product.cpu.abi'),
    deviceId: serial || run('adb', ['get-serialno']) || null,
    totalMemoryBytes: totalKb ? totalKb * 1024 : null
  };
}

function getIosSimulatorDeviceInfo(target = 'booted') {
  let device = null;
  try {
    const parsed = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']) || '{}');
    for (const [runtime, devices] of Object.entries(parsed.devices || {})) {
      const found = (devices || []).find((item) => item.state === 'Booted' && (target === 'booted' || item.udid === target));
      if (found) {
        device = { ...found, runtime };
        break;
      }
    }
  } catch {}
  const env = (key) => run('xcrun', ['simctl', 'getenv', target, key]) || null;
  const totalMemory = Number(run('xcrun', ['simctl', 'spawn', target, 'sysctl', '-n', 'hw.memsize'])) || 0;
  return {
    platform: 'ios',
    simulator: true,
    deviceName: device?.name || env('SIMULATOR_DEVICE_NAME'),
    model: env('SIMULATOR_MODEL_IDENTIFIER'),
    osVersion: env('SIMULATOR_RUNTIME_VERSION') || (device?.runtime || '').replace(/^.*iOS-/, '').replace(/-/g, '.'),
    architecture: process.arch,
    deviceId: device?.udid || (target !== 'booted' ? target : null),
    totalMemoryBytes: totalMemory || null
  };
}

function findAndroidProcess(name, serial) {
  if (!name) return null;
  const all = listAndroidProcesses(serial);
  return all.find((item) => item.name === name) ||
    all.find((item) => item.name.endsWith(name)) ||
    all.find((item) => item.name.includes(name)) ||
    null;
}

function sampleAndroidProcess(name, serial) {
  const processInfo = findAndroidProcess(name, serial);
  if (!processInfo) return { available: false, process: name || null };
  const pid = processInfo.pid;
  const mem = run('adb', androidArgs(serial, ['shell', 'dumpsys', 'meminfo', String(pid)]));
  const totalPssKb = Number((mem.match(/TOTAL\s+(\d+)/) || [])[1] || 0);
  const cpuInfo = run('adb', androidArgs(serial, ['shell', 'dumpsys', 'cpuinfo']));
  const cpuLine = cpuInfo.split(/\r?\n/).find((line) => new RegExp('\\b' + pid + '\\b').test(line)) || '';
  const cpuPercent = Number((cpuLine.match(/([\d.]+)%/) || [])[1] || 0);
  return {
    available: true,
    process: processInfo.name,
    pid,
    memoryBytes: totalPssKb ? totalPssKb * 1024 : null,
    cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : null,
    timestamp: Date.now()
  };
}

function sampleIosSimulatorProcess(name, target = 'booted') {
  if (!name) return { available: false, process: null };
  const rows = run('xcrun', ['simctl', 'spawn', target, 'ps', '-axo', 'pid=,rss=,%cpu=,comm=']).split(/\r?\n/);
  const candidates = [];
  for (const row of rows) {
    const match = row.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.+?)\s*$/);
    if (!match) continue;
    const command = match[4];
    const procName = path.basename(command);
    if (procName === name || command.endsWith('/' + name) || procName.includes(name)) {
      candidates.push({
        pid: Number(match[1]),
        rssKb: Number(match[2]),
        cpuPercent: Number(match[3]),
        process: procName
      });
    }
  }
  const hit = candidates[0];
  if (!hit) return { available: false, process: name };
  return {
    available: true,
    process: hit.process,
    pid: hit.pid,
    memoryBytes: hit.rssKb * 1024,
    cpuPercent: hit.cpuPercent,
    timestamp: Date.now()
  };
}

async function createSessionInfo({ collector, root, app, device, processName }) {
  const pkg = readProjectPackage(root);
  let deviceInfo;
  if (collector.platform === 'android') deviceInfo = getAndroidDeviceInfo(device);
  else if (collector.platform === 'ios') deviceInfo = getIosSimulatorDeviceInfo(collector.target || device || 'booted');
  else deviceInfo = { platform: 'ios', simulator: false, deviceId: device || null };

  const metro = await checkMetro();
  const appId = collector.platform === 'android'
    ? (app || readApplicationId(root))
    : detectIosBundleId(root);

  return {
    device: deviceInfo,
    app: {
      name: pkg.displayName || pkg.name || null,
      version: pkg.version || null,
      bundleId: appId || null,
      reactNativeVersion: pkg.dependencies?.['react-native'] || pkg.devDependencies?.['react-native'] || null,
      reactVersion: pkg.dependencies?.react || pkg.devDependencies?.react || null,
      primaryProcess: processName || collector.process || collector.app || null,
      debug: true
    },
    metro,
    collector: {
      platform: collector.platform,
      command: collector.command
    }
  };
}

function sampleMetrics({ collector, device, processName }) {
  if (collector.platform === 'android') return sampleAndroidProcess(processName, device);
  if (collector.platform === 'ios') return sampleIosSimulatorProcess(processName, collector.target || device || 'booted');
  return { available: false, process: processName || null, timestamp: Date.now() };
}

module.exports = {
  createSessionInfo,
  sampleMetrics,
  getAndroidDeviceInfo,
  getIosSimulatorDeviceInfo,
  sampleAndroidProcess,
  sampleIosSimulatorProcess
};
