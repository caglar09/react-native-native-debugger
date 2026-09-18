'use strict';

const ANDROID_PREFIX_RE = /^(\d\d-\d\d)\s+(\d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.*)$/;
const IOS_LEGACY_RE = /^(\d{4}-\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+[^ ]*)\s+(\S+)\s+\[(\d+):(\d+)\]\s+\(([^)]+)\)\s+([^:]+):\s?(.*)$/;
const IOS_COMPACT_RE = /^(\d{4}-\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+)\s+([A-Za-z]{1,2})\s+(.+?)\[(\d+):([0-9A-Fa-fx]+)\](?:\s+\(([^)]+)\))?\s+\[([^:\]]*):([^\]]*)\]\s+(.*)$/;

const levels = { V: 'verbose', D: 'debug', I: 'info', W: 'warn', E: 'error', F: 'fatal' };
const iosLevelCodes = {
  V: 'verbose', D: 'debug', I: 'info', W: 'warn', E: 'error', F: 'fatal',
  Db: 'debug', In: 'info', Nt: 'info', Er: 'error', Ft: 'fatal', Df: 'default'
};

const SOURCE_RULES = [
  { test: /rnbackgrounddownloader|com\.eko/i, package: '@kesha-antonov/react-native-background-downloader', service: 'RNBackgroundDownloader', confidence: 'high' },
  { test: /reactnativeblobutil|react-native-blob-util|\brnfb\b/i, package: 'react-native-blob-util', service: 'ReactNativeBlobUtil', confidence: 'high' },
  { test: /drpogodin|@dr\.pogodin/i, package: '@dr.pogodin/react-native-fs', service: 'RNFS', confidence: 'high' },
  { test: /\brnfs\b|react-native-fs/i, package: 'react-native-fs', service: 'RNFS', confidence: 'medium' },
  { test: /visioncamera|mrousavy/i, package: 'react-native-vision-camera', service: 'VisionCamera', confidence: 'high' },
  { test: /firebase|googleservice|googleutilities/i, package: '@react-native-firebase/*', service: 'Firebase', confidence: 'medium' },
  { test: /sentry/i, package: '@sentry/react-native', service: 'Sentry', confidence: 'medium' },
  { test: /okhttp/i, package: 'okhttp', service: 'OkHttp', confidence: 'high' },
  { test: /hermes/i, package: 'hermes', service: 'Hermes', confidence: 'high' },
  { test: /reactnative|react-native|bridgelessreactcontext|reactcontext|com\.facebook\.react|\brct\b/i, package: 'react-native', service: 'React Native', confidence: 'medium' }
];

function extractLocation(text) {
  const value = String(text || '');
  const native = value.match(/(?:^|\s)([A-Za-z0-9_./+\-]+\.(?:m|mm|swift|c|cc|cpp|h|hpp|java|kt)):(\d+)\b/);
  if (native) return { file: native[1], line: Number(native[2]) };
  const java = value.match(/\b([A-Za-z_$][\w.$<>-]+)\.([A-Za-z_$][\w$<>-]+)\(([^:()]+):(\d+)\)/);
  if (java) return { className: java[1], method: java[2], file: java[3], line: Number(java[4]) };
  return {};
}

function extractRuntimeTelemetry(text) {
  const value = String(text || '');
  const marker = 'RNND_TELEMETRY ';
  const index = value.indexOf(marker);
  if (index < 0) return null;
  const json = value.slice(index + marker.length).trim();
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function extractNetworkMetadata(text) {
  const value = String(text || '');
  if (!/(?:CFNetwork|com\.apple\.network|network\.framework|\bnw_|okhttp|\bTLS\b|\bQUIC\b|https?:\/\/|socket|connection)/i.test(value)) {
    return null;
  }

  const url = (value.match(/https?:\/\/[^\s"'<>\])}]+/i) || [])[0] || null;
  const endpoint = (value.match(/(?:\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3}):\d+/i) || [])[0] || null;
  const tls = value.match(/\bTLS(?:v|\s|_version[=: ]*)?(1\.[0-3])\b/i);
  const error = value.match(/\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTCONN|EPIPE)\b/i);
  let protocol = null;
  if (/\bQUIC\b|http\/3|\bh3\b/i.test(value)) protocol = 'QUIC';
  else if (/http\/2|\bh2\b/i.test(value)) protocol = 'HTTP/2';
  else if (/https?:\/\//i.test(value)) protocol = 'HTTP';

  return {
    url,
    endpoint,
    tlsVersion: tls ? `TLS ${tls[1]}` : null,
    protocol,
    errorCode: error ? error[1].toUpperCase() : null
  };
}

function classifySource(event) {
  const haystack = [event.tag, event.function, event.sourceLibrary, event.subsystem, event.category, event.process, event.className, event.method, event.file, event.message].filter(Boolean).join(' ');
  for (const rule of SOURCE_RULES) {
    if (rule.test.test(haystack)) {
      return { package: rule.package, service: rule.service, packageConfidence: rule.confidence, sourceKind: 'library' };
    }
  }
  if (event.subsystem && /^com\.apple\./i.test(event.subsystem)) {
    return { package: 'Apple System', service: event.sourceLibrary || event.subsystem, packageConfidence: 'high', sourceKind: 'system' };
  }
  if (event.process) {
    return { package: event.process, service: event.sourceLibrary || event.subsystem || event.tag || event.process, packageConfidence: 'process', sourceKind: 'app/process' };
  }
  return { package: 'Unknown', service: event.sourceLibrary || event.tag || event.subsystem || 'Unknown', packageConfidence: 'unknown', sourceKind: 'unknown' };
}

function enrich(event) {
  const combined = `${event.message || ''} ${event.raw || ''}`;
  const located = { ...event, ...extractLocation(combined) };
  const telemetry = extractRuntimeTelemetry(event.message) || extractRuntimeTelemetry(event.raw);
  if (telemetry) {
    return {
      ...located,
      kind: 'runtime-telemetry',
      telemetry,
      package: 'react-native-native-debugger',
      service: 'Runtime Telemetry',
      packageConfidence: 'high',
      sourceKind: 'instrumentation'
    };
  }
  const network = extractNetworkMetadata(combined);
  return {
    ...located,
    ...classifySource(located),
    ...(network ? { network } : {})
  };
}

function parseAndroidLine(line) {
  const text = String(line);
  const match = text.match(ANDROID_PREFIX_RE);
  if (!match) return enrich({ platform: 'android', level: 'unknown', tag: '', message: text, raw: text });

  const payload = match[6];
  const separator = payload.indexOf(': ');
  const fallbackSeparator = separator < 0 ? payload.indexOf(':') : separator;
  const tag = fallbackSeparator >= 0 ? payload.slice(0, fallbackSeparator).trim() : payload.trim();
  const message = fallbackSeparator >= 0
    ? payload.slice(fallbackSeparator + (separator >= 0 ? 2 : 1)).replace(/^\s+/, '')
    : '';

  return enrich({
    platform: 'android',
    timestamp: `${match[1]} ${match[2]}`,
    pid: Number(match[3]),
    tid: Number(match[4]),
    level: levels[match[5]] || 'unknown',
    priority: match[5],
    tag,
    message,
    raw: text
  });
}

function parseIosLine(line) {
  const text = String(line);
  const compact = text.match(IOS_COMPACT_RE);
  if (compact) {
    const tail = compact[9];
    const symbolMatch = tail.match(/^([^\s]+)\s+(.*)$/);
    const candidate = symbolMatch && /^[+\-[\]A-Za-z_][\w.$:+\-[\]]*$/.test(symbolMatch[1]) ? symbolMatch[1] : '';
    const message = candidate ? symbolMatch[2] : tail;
    return enrich({
      platform: 'ios',
      timestamp: compact[1],
      level: iosLevelCodes[compact[2]] || inferIosLevel(text),
      priority: compact[2],
      process: compact[3].trim(),
      pid: Number(compact[4]),
      tid: compact[5],
      sourceLibrary: compact[6] || '',
      subsystem: compact[7] || '',
      category: compact[8] || '',
      function: candidate,
      tag: candidate || compact[8] || compact[7] || compact[6] || '',
      message,
      raw: text
    });
  }

  const legacy = text.match(IOS_LEGACY_RE);
  if (legacy) {
    return enrich({
      platform: 'ios',
      timestamp: legacy[1],
      process: legacy[2],
      pid: Number(legacy[3]),
      tid: legacy[4],
      subsystem: legacy[5],
      tag: legacy[6].trim(),
      level: inferIosLevel(text),
      message: legacy[7],
      raw: text
    });
  }

  return enrich({ platform: 'ios', level: inferIosLevel(text), tag: '', message: text, raw: text });
}

function inferIosLevel(line) {
  const text = String(line);
  const code = text.match(/^\d{4}-\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+\s+([A-Za-z]{1,2})\s+/);
  if (code && iosLevelCodes[code[1]]) return iosLevelCodes[code[1]];
  const value = text.toLowerCase();
  if (/\bfault\b/.test(value)) return 'fatal';
  if (/\berror\b/.test(value)) return 'error';
  if (/\bwarn(?:ing)?\b/.test(value)) return 'warn';
  if (/\bdebug\b/.test(value)) return 'debug';
  if (/\binfo\b/.test(value)) return 'info';
  return 'default';
}

module.exports = { parseAndroidLine, parseIosLine, inferIosLevel, classifySource, extractLocation, extractRuntimeTelemetry, extractNetworkMetadata, enrich };
