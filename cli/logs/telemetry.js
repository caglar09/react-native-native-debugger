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
  for (const entry of fs.readdirSync(ios, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.xcodeproj')) continue;
    const projectFile = path.join(ios, entry.name, 'project.pbxproj');
    if (!fs.existsSync(projectFile)) continue;
    const source = fs.readFileSync(projectFile, 'utf8');
    const match = source.match(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/);
    if (match) return match[1].trim().replace(/^"|"$/g, '');
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

function getIosSimulatorAppExecutable(target = 'booted', bundleId) {
  if (!bundleId) return null;
  const appPath = run('xcrun', ['simctl', 'get_app_container', target, bundleId, 'app']);
  if (!appPath) return null;
  const plist = path.join(appPath, 'Info.plist');
  if (!fs.existsSync(plist)) return null;
  const executable = run('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist]);
  return executable || null;
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

function findIosSimulatorProcess(name, target = 'booted') {
  if (!name) return null;
  const processes = listIosSimulatorProcesses(target);
  const needle = String(name).toLowerCase();
  return processes.find((item) => String(item.name).toLowerCase() === needle) ||
    processes.find((item) => String(item.command || '').toLowerCase().endsWith('/' + needle)) ||
    processes.find((item) => String(item.name).toLowerCase().includes(needle)) ||
    null;
}

function parseHostPsSample(value) {
  const match = String(value || '').trim().match(/^(\d+)\s+([\d.]+)$/);
  if (!match) return null;
  const rssKb = Number(match[1]);
  const cpuPercent = Number(match[2]);
  if (!Number.isFinite(rssKb) || !Number.isFinite(cpuPercent)) return null;
  return { rssKb, cpuPercent };
}

function sampleIosSimulatorProcess(name, target = 'booted') {
  if (!name) return { available: false, process: null, timestamp: Date.now(), reason: 'No process selected' };

  const processInfo = findIosSimulatorProcess(name, target);
  if (!processInfo?.pid) {
    return { available: false, process: name, timestamp: Date.now(), reason: 'Process not found in simulator' };
  }

  // Simulator app processes are host macOS processes with the same PID. Sampling from
  // host ps is more reliable than asking the simulator runtime ps implementation for
  // rss/%cpu columns, which varies between runtime/Xcode versions.
  const hostSample = parseHostPsSample(run('ps', ['-p', String(processInfo.pid), '-o', 'rss=,%cpu=']));
  if (hostSample) {
    return {
      available: true,
      source: 'host-ps',
      process: processInfo.name,
      pid: processInfo.pid,
      memoryBytes: hostSample.rssKb * 1024,
      cpuPercent: hostSample.cpuPercent,
      timestamp: Date.now()
    };
  }

  // Fallback for environments where host ps cannot observe the simulator process.
  const simulatorRows = run('xcrun', ['simctl', 'spawn', target, 'ps', '-axo', 'pid=,rss=,%cpu=,comm=']).split(/\r?\n/);
  const row = simulatorRows.find((line) => new RegExp('^\\s*' + processInfo.pid + '\\s+').test(line));
  const fallback = row && row.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.+?)\s*$/);
  if (fallback) {
    return {
      available: true,
      source: 'simctl-ps',
      process: path.basename(fallback[4]),
      pid: Number(fallback[1]),
      memoryBytes: Number(fallback[2]) * 1024,
      cpuPercent: Number(fallback[3]),
      timestamp: Date.now()
    };
  }

  return {
    available: false,
    process: processInfo.name || name,
    pid: processInfo.pid,
    timestamp: Date.now(),
    reason: 'Could not sample simulator process with host or simctl ps'
  };
}

function parseElapsedSeconds(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const daySplit = text.split('-');
  let days = 0;
  let clock = text;
  if (daySplit.length === 2) {
    days = Number(daySplit[0]) || 0;
    clock = daySplit[1];
  }
  const parts = clock.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  let seconds = days * 86400;
  if (parts.length === 3) seconds += parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) seconds += parts[0] * 60 + parts[1];
  else seconds += parts[0];
  return seconds;
}

function sampleIosSimulatorProcessMatrix(target = 'booted') {
  const simulatorProcesses = listIosSimulatorProcesses(target);
  if (!simulatorProcesses.length) return [];

  const simulatorByPid = new Map(simulatorProcesses.map((item) => [Number(item.pid), item]));
  const rows = run('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,state=,etime=,comm=']).split(/\r?\n/);
  const result = [];

  for (const row of rows) {
    const match = row.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const simulatorProcess = simulatorByPid.get(pid);
    if (!simulatorProcess) continue;
    result.push({
      pid,
      ppid: Number(match[2]),
      process: simulatorProcess.name,
      command: simulatorProcess.command || match[7],
      memoryBytes: Number(match[3]) * 1024,
      memoryKind: 'rss',
      cpuPercent: Number(match[4]),
      state: match[5],
      elapsedSeconds: parseElapsedSeconds(match[6]),
      platform: 'ios',
      source: 'host-ps'
    });
  }

  return result;
}

function parseAndroidCpuInfo(value) {
  const cpuByPid = new Map();
  for (const line of String(value || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([\d.]+)%\s+(\d+)\/([^:]+):/);
    if (!match) continue;
    cpuByPid.set(Number(match[2]), {
      cpuPercent: Number(match[1]),
      process: match[3].trim()
    });
  }
  return cpuByPid;
}

function sampleAndroidProcessMatrix(serial) {
  const args = androidArgs(serial, ['shell', 'ps', '-A', '-o', 'PID,PPID,RSS,STAT,NAME']);
  let output = run('adb', args);
  let hasExtendedColumns = Boolean(output);
  if (!output) {
    hasExtendedColumns = false;
    output = run('adb', androidArgs(serial, ['shell', 'ps', '-A']));
  }
  if (!output) return [];

  const cpuByPid = parseAndroidCpuInfo(run('adb', androidArgs(serial, ['shell', 'dumpsys', 'cpuinfo'])));
  const result = [];
  const lines = output.split(/\r?\n/).filter(Boolean);
  const header = lines.shift() || '';
  const headerColumns = header.trim().split(/\s+/);
  const pidIndex = headerColumns.indexOf('PID');
  const ppidIndex = headerColumns.indexOf('PPID');
  const rssIndex = headerColumns.indexOf('RSS');
  const stateIndex = headerColumns.findIndex((name) => name === 'STAT' || name === 'S');
  const nameIndex = headerColumns.findIndex((name) => name === 'NAME' || name === 'CMD' || name === 'ARGS');

  for (const line of lines) {
    const columns = line.trim().split(/\s+/);
    const pid = Number(columns[pidIndex >= 0 ? pidIndex : 1]);
    if (!Number.isFinite(pid)) continue;
    const cpu = cpuByPid.get(pid);
    const processName = nameIndex >= 0
      ? columns.slice(nameIndex).join(' ')
      : (columns[columns.length - 1] || cpu?.process || '');
    const rssKb = rssIndex >= 0 ? Number(columns[rssIndex]) : null;

    result.push({
      pid,
      ppid: ppidIndex >= 0 ? Number(columns[ppidIndex]) || null : null,
      process: path.basename(processName || cpu?.process || ''),
      command: processName || cpu?.process || '',
      memoryBytes: Number.isFinite(rssKb) ? rssKb * 1024 : null,
      memoryKind: Number.isFinite(rssKb) ? 'rss' : null,
      cpuPercent: Number.isFinite(cpu?.cpuPercent) ? cpu.cpuPercent : null,
      state: stateIndex >= 0 ? columns[stateIndex] : null,
      platform: 'android',
      source: hasExtendedColumns ? 'adb-ps' : 'adb-ps-fallback'
    });
  }

  return result;
}

function sampleProcessMatrix({ collector, device, mainProcess }) {
  let items = [];
  if (collector.platform === 'android') items = sampleAndroidProcessMatrix(device);
  else if (collector.platform === 'ios') items = sampleIosSimulatorProcessMatrix(collector.target || device || 'booted');
  else return [];

  const normalizedMain = String(mainProcess || collector.app || '').toLowerCase();
  return items
    .map((item) => ({
      ...item,
      isMainApp: Boolean(normalizedMain && (
        String(item.process || '').toLowerCase() === normalizedMain ||
        String(item.command || '').toLowerCase().includes(normalizedMain)
      ))
    }))
    .sort((a, b) =>
      Number(b.isMainApp) - Number(a.isMainApp) ||
      Number(b.cpuPercent || 0) - Number(a.cpuPercent || 0) ||
      Number(b.memoryBytes || 0) - Number(a.memoryBytes || 0)
    );
}

function runtimeCapabilities(collector) {
  return {
    processMatrix: collector.platform === 'android' || collector.platform === 'ios',
    processMemory: collector.platform === 'android' || collector.platform === 'ios',
    processCpu: collector.platform === 'android' || collector.platform === 'ios',
    nativeRuntimeTelemetry: true,
    fps: 'requires-native-runtime',
    thermalState: 'requires-native-runtime',
    appMemory: 'host-or-native-runtime',
    networkSignals: 'log-derived',
    symbolication: false
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
  const simulatorProcess = collector.platform === 'ios'
    ? getIosSimulatorAppExecutable(collector.target || device || 'booted', appId)
    : null;

  return {
    device: deviceInfo,
    app: {
      name: pkg.displayName || pkg.name || null,
      version: pkg.version || null,
      bundleId: appId || null,
      reactNativeVersion: pkg.dependencies?.['react-native'] || pkg.devDependencies?.['react-native'] || null,
      reactVersion: pkg.dependencies?.react || pkg.devDependencies?.react || null,
      primaryProcess: processName || collector.process || collector.app || simulatorProcess || null,
      debug: true
    },
    metro,
    collector: {
      platform: collector.platform,
      command: collector.command
    },
    capabilities: runtimeCapabilities(collector)
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
  sampleIosSimulatorProcess,
  sampleIosSimulatorProcessMatrix,
  sampleAndroidProcessMatrix,
  sampleProcessMatrix,
  runtimeCapabilities,
  findIosSimulatorProcess,
  parseHostPsSample,
  parseElapsedSeconds,
  parseAndroidCpuInfo,
  getIosSimulatorAppExecutable
};
