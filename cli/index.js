#!/usr/bin/env node
'use strict';

const path = require('path');
const { integrationOptions, isIntegrationEnabled, loadConfig, readPackageVersion, resolvePackageRoot } = require('./helpers');
const { runLogs } = require('./logs');

const integrations = [
  require('./integrations/rnfs'),
  require('./integrations/dr-pogodin-rnfs'),
  require('./integrations/blob-util'),
  require('./integrations/background-downloader')
];

function parseArgs(argv) {
  const args = { command: 'doctor', root: process.cwd(), strict: false, json: false, platform: 'android', host: '127.0.0.1', port: 9876, noOpen: false, iosDevice: false };
  const rest = argv.slice(2);
  if (rest[0] && !rest[0].startsWith('-')) args.command = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (value === '--root' && rest[i + 1]) args.root = path.resolve(rest[++i]);
    else if (value === '--strict') args.strict = true;
    else if (value === '--json') args.json = true;
    else if (value === '--platform' && rest[i + 1]) args.platform = String(rest[++i]).toLowerCase();
    else if (value === '--app' && rest[i + 1]) args.app = rest[++i];
    else if (value === '--device' && rest[i + 1]) args.device = rest[++i];
    else if (value === '--process' && rest[i + 1]) args.process = rest[++i];
    else if (value === '--host' && rest[i + 1]) args.host = rest[++i];
    else if (value === '--port' && rest[i + 1]) args.port = Number(rest[++i]);
    else if (value === '--no-open') args.noOpen = true;
    else if (value === '--ios-device') { args.platform = 'ios'; args.iosDevice = true; }
    else if (value === '--ios-simulator') { args.platform = 'ios'; args.iosDevice = false; }
    else if (value === '--help' || value === '-h') args.command = 'help';
  }
  if (!['android', 'ios'].includes(args.platform)) throw new Error(`Unsupported platform: ${args.platform}. Use android or ios.`);
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error(`Invalid port: ${args.port}`);
  return args;
}

function versionAllowed(definition, version, config) {
  if (config.allowUntestedVersions === true) return true;
  const options = integrationOptions(config, definition.key);
  if (options.allowUntestedVersions === true) return true;
  return definition.tested.includes(version);
}

function inspect(projectRoot, config) {
  return integrations.map((definition) => {
    const packageRoot = resolvePackageRoot(projectRoot, definition.packageName);
    if (!packageRoot) return { key: definition.key, package: definition.packageName, installed: false, enabled: isIntegrationEnabled(config, definition.key), testedVersions: definition.tested };
    const version = readPackageVersion(packageRoot);
    return { key: definition.key, package: definition.packageName, installed: true, enabled: isIntegrationEnabled(config, definition.key), packageRoot, version, testedVersions: definition.tested, versionAllowed: versionAllowed(definition, version, config), status: definition.status(packageRoot) };
  });
}

function hasPatch(status) {
  if (!status) return false;
  return Object.values(status).some((value) => value === true || (value && typeof value === 'object' && Number(value.markers || 0) > 0));
}

function printDoctor(rows, asJson) {
  if (asJson) return console.log(JSON.stringify(rows, null, 2));
  console.log('React Native Native Debugger\n');
  for (const row of rows) {
    if (!row.installed) { console.log(`○ ${row.package} — not installed${row.enabled ? '' : ' (disabled)'}`); continue; }
    console.log(`${row.versionAllowed ? '✓' : '!'} ${row.package}@${row.version} — ${hasPatch(row.status) ? 'patched' : 'not patched'}${row.enabled ? '' : ' (disabled)'}`);
    if (!row.versionAllowed) console.log(`  tested: ${row.testedVersions.join(', ')}; skipped unless allowUntestedVersions=true`);
    for (const [name, state] of Object.entries(row.status || {})) {
      if (state && typeof state === 'object') console.log(`  ${name}: ${state.exists ? `${state.markers} marker(s)` : 'source missing'}`);
      else console.log(`  ${name}: ${state ? 'present' : 'absent'}`);
    }
  }
}

function patch(args, config) {
  let failures = 0;
  const results = [];
  for (const definition of integrations) {
    if (!isIntegrationEnabled(config, definition.key)) { results.push({ package: definition.packageName, state: 'disabled' }); continue; }
    const packageRoot = resolvePackageRoot(args.root, definition.packageName);
    if (!packageRoot) { results.push({ package: definition.packageName, state: 'not-installed' }); continue; }
    const version = readPackageVersion(packageRoot);
    if (!versionAllowed(definition, version, config)) { results.push({ package: definition.packageName, version, state: 'untested-version', tested: definition.tested }); continue; }
    try {
      const integrationConfig = integrationOptions(config, definition.key);
      const detail = definition.patch(packageRoot, { progressThrottleMs: Number(integrationConfig.progressThrottleMs ?? config.progressThrottleMs ?? 500) });
      results.push({ package: definition.packageName, version, state: 'patched', detail });
    } catch (error) {
      failures++;
      results.push({ package: definition.packageName, version, state: 'failed', error: error.message });
    }
  }
  if (args.json) console.log(JSON.stringify(results, null, 2));
  else {
    console.log('React Native Native Debugger — patch\n');
    for (const result of results) {
      console.log(`${result.state === 'patched' ? '✓' : result.state === 'failed' ? '✗' : '○'} ${result.package}${result.version ? `@${result.version}` : ''}: ${result.state}`);
      if (result.state === 'untested-version') console.log(`  tested: ${result.tested.join(', ')}`);
      if (result.error) console.log(`  ${result.error}`);
    }
  }
  if (failures && (args.strict || config.strict === true)) process.exitCode = 2;
}

function unpatch(args, config) {
  const results = [];
  for (const definition of integrations) {
    const packageRoot = resolvePackageRoot(args.root, definition.packageName);
    if (!packageRoot) { results.push({ package: definition.packageName, state: 'not-installed' }); continue; }
    try { results.push({ package: definition.packageName, state: 'unpatched', detail: definition.unpatch(packageRoot) }); }
    catch (error) { results.push({ package: definition.packageName, state: 'failed', error: error.message }); if (args.strict || config.strict === true) process.exitCode = 2; }
  }
  if (args.json) console.log(JSON.stringify(results, null, 2));
  else {
    console.log('React Native Native Debugger — unpatch\n');
    for (const result of results) {
      console.log(`${result.state === 'unpatched' ? '✓' : '○'} ${result.package}: ${result.state}`);
      if (result.error) console.log(`  ${result.error}`);
    }
  }
}

function help() {
  console.log(`rn-native-debugger <command> [options]\n\nCommands:\n  logs        Stream device/simulator native logs into a local dashboard\n  patch       Instrument supported native dependencies\n  unpatch     Remove only blocks generated by this package\n  doctor      Show dependency/version/patch status\n  status      Alias for doctor\n\nLog options:\n  --platform android|ios   Collector platform (default: android)\n  --app ID                 Android applicationId; auto-detected when omitted\n  --device ID              adb serial / Simulator UDID / iOS device UDID\n  --process NAME           iOS Simulator process filter\n  --ios-simulator          Use Apple Simulator unified log stream\n  --ios-device             Use physical iOS device via idevicesyslog\n  --host HOST              Dashboard host (default: 127.0.0.1)\n  --port PORT              Dashboard port (default: 9876)\n  --no-open                Do not open the browser automatically\n\nGeneral options:\n  --root DIR               React Native project root (default: cwd)\n  --strict                 Exit non-zero when an installed integration cannot be patched\n  --json                   Machine-readable doctor/patch output\n\nConfig: rn-native-debugger.config.js`);
}

(async function main() {
  try {
    const args = parseArgs(process.argv);
    const config = loadConfig(args.root);
    switch (args.command) {
      case 'logs': await runLogs(args); break;
      case 'patch': patch(args, config); break;
      case 'unpatch': unpatch(args, config); break;
      case 'doctor':
      case 'status': printDoctor(inspect(args.root, config), args.json); break;
      case 'help': help(); break;
      default: console.error(`Unknown command: ${args.command}`); help(); process.exitCode = 1;
    }
  } catch (error) {
    console.error(`rn-native-debugger: ${error.message}`);
    process.exitCode = 1;
  }
})();
