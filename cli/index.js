#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  integrationOptions,
  isIntegrationEnabled,
  loadConfig,
  readPackageVersion,
  resolvePackageRoot
} = require('./helpers');

const integrations = [
  require('./integrations/rnfs'),
  require('./integrations/dr-pogodin-rnfs'),
  require('./integrations/blob-util'),
  require('./integrations/background-downloader')
];

function parseArgs(argv) {
  const args = { command: 'doctor', root: process.cwd(), strict: false, json: false };
  const rest = argv.slice(2);
  if (rest[0] && !rest[0].startsWith('-')) args.command = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--root' && rest[i + 1]) args.root = path.resolve(rest[++i]);
    else if (rest[i] === '--strict') args.strict = true;
    else if (rest[i] === '--json') args.json = true;
    else if (rest[i] === '--help' || rest[i] === '-h') args.command = 'help';
  }
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
    if (!packageRoot) {
      return {
        key: definition.key,
        package: definition.packageName,
        installed: false,
        enabled: isIntegrationEnabled(config, definition.key),
        testedVersions: definition.tested
      };
    }
    const version = readPackageVersion(packageRoot);
    return {
      key: definition.key,
      package: definition.packageName,
      installed: true,
      enabled: isIntegrationEnabled(config, definition.key),
      packageRoot,
      version,
      testedVersions: definition.tested,
      versionAllowed: versionAllowed(definition, version, config),
      status: definition.status(packageRoot)
    };
  });
}

function hasPatch(status) {
  if (!status) return false;
  return Object.values(status).some((value) => {
    if (value === true) return true;
    return value && typeof value === 'object' && Number(value.markers || 0) > 0;
  });
}

function printDoctor(rows, asJson) {
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log('React Native Native Debugger\n');
  for (const row of rows) {
    if (!row.installed) {
      console.log(`○ ${row.package} — not installed${row.enabled ? '' : ' (disabled)'}`);
      continue;
    }
    const versionMark = row.versionAllowed ? '✓' : '!';
    const patchMark = hasPatch(row.status) ? 'patched' : 'not patched';
    console.log(`${versionMark} ${row.package}@${row.version} — ${patchMark}${row.enabled ? '' : ' (disabled)'}`);
    if (!row.versionAllowed) {
      console.log(`  tested: ${row.testedVersions.join(', ')}; skipped unless allowUntestedVersions=true`);
    }
    for (const [name, state] of Object.entries(row.status || {})) {
      if (state && typeof state === 'object') {
        console.log(`  ${name}: ${state.exists ? `${state.markers} marker(s)` : 'source missing'}`);
      } else {
        console.log(`  ${name}: ${state ? 'present' : 'absent'}`);
      }
    }
  }
}

function patch(args, config) {
  let failures = 0;
  const results = [];
  for (const definition of integrations) {
    if (!isIntegrationEnabled(config, definition.key)) {
      results.push({ package: definition.packageName, state: 'disabled' });
      continue;
    }
    const packageRoot = resolvePackageRoot(args.root, definition.packageName);
    if (!packageRoot) {
      results.push({ package: definition.packageName, state: 'not-installed' });
      continue;
    }
    const version = readPackageVersion(packageRoot);
    if (!versionAllowed(definition, version, config)) {
      results.push({ package: definition.packageName, version, state: 'untested-version', tested: definition.tested });
      continue;
    }

    try {
      const integrationConfig = integrationOptions(config, definition.key);
      const configuredThrottle = integrationConfig.progressThrottleMs ?? config.progressThrottleMs ?? 500;
      const options = {
        progressThrottleMs: Number(configuredThrottle)
      };
      const detail = definition.patch(packageRoot, options);
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
      const mark = result.state === 'patched' ? '✓' : result.state === 'failed' ? '✗' : '○';
      console.log(`${mark} ${result.package}${result.version ? `@${result.version}` : ''}: ${result.state}`);
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
    if (!packageRoot) {
      results.push({ package: definition.packageName, state: 'not-installed' });
      continue;
    }
    try {
      const detail = definition.unpatch(packageRoot);
      results.push({ package: definition.packageName, state: 'unpatched', detail });
    } catch (error) {
      results.push({ package: definition.packageName, state: 'failed', error: error.message });
      if (args.strict || config.strict === true) process.exitCode = 2;
    }
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
  console.log(`rn-native-debugger <command> [options]\n\nCommands:\n  patch       Instrument supported native dependencies\n  unpatch     Remove only blocks generated by this package\n  doctor      Show dependency/version/patch status\n  status      Alias for doctor\n\nOptions:\n  --root DIR  React Native project root (default: cwd)\n  --strict    Exit non-zero when an installed integration cannot be patched\n  --json      Machine-readable output\n\nConfig: rn-native-debugger.config.js`);
}

(function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args.root);
  switch (args.command) {
    case 'patch': return patch(args, config);
    case 'unpatch': return unpatch(args, config);
    case 'doctor':
    case 'status': return printDoctor(inspect(args.root, config), args.json);
    case 'help': return help();
    default:
      console.error(`Unknown command: ${args.command}`);
      help();
      process.exitCode = 1;
  }
})();
