'use strict';

const { NativeEventEmitter, NativeModules } = require('react-native');

const EVENT_NAME = 'RNNativeDebuggerEvent';
const nativeModule = NativeModules.RNNativeDebugger || null;
const nativeEmitter = nativeModule ? new NativeEventEmitter(nativeModule) : null;

const DEFAULT_REDACT_KEYS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'token',
  'access_token',
  'refresh_token',
  'password',
  'secret'
];

function keyShouldBeRedacted(key, extraKeys) {
  const normalized = String(key || '').toLowerCase();
  return DEFAULT_REDACT_KEYS.concat(extraKeys || []).some((candidate) => {
    const target = String(candidate).toLowerCase();
    return normalized === target || normalized.includes(target);
  });
}

function redact(value, extraKeys, depth = 0) {
  if (depth > 8) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.map((item) => redact(item, extraKeys, depth + 1));
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = keyShouldBeRedacted(key, extraKeys)
      ? '[REDACTED]'
      : redact(child, extraKeys, depth + 1);
  }
  return out;
}

function matchesFilter(event, options) {
  if (!event) return false;
  if (options.integrations && options.integrations.length > 0 && !options.integrations.includes(event.integration)) {
    return false;
  }
  if (options.categories && options.categories.length > 0 && !options.categories.includes(event.category)) {
    return false;
  }
  if (options.events && options.events.length > 0 && !options.events.includes(event.event)) {
    return false;
  }
  if (options.levels && options.levels.length > 0 && !options.levels.includes(String(event.level || '').toLowerCase())) {
    return false;
  }
  return true;
}

function selectConsoleMethod(event) {
  const name = String(event && event.event || '').toLowerCase();
  const level = String(event && event.level || '').toLowerCase();
  if (level === 'error' || name.includes('fail') || name.includes('error')) return 'error';
  if (level === 'warn' || level === 'warning' || name.includes('warn') || name.includes('cancel')) return 'warn';
  if (level === 'info' || name.includes('complete') || name.includes('finish') || name.includes('response')) return 'info';
  return 'debug';
}

function formatPrefix(event) {
  const platform = String(event.platform || 'native').toUpperCase();
  const integration = String(event.integration || 'unknown').toUpperCase();
  const category = String(event.category || 'native').toUpperCase();
  if (category === 'NATIVE-LOG' || category === 'NATIVE-ERROR') {
    const tag = String(event.data && event.data.tag || category).toUpperCase();
    const level = String(event.level || (category === 'NATIVE-ERROR' ? 'error' : 'debug')).toUpperCase();
    return `[NATIVE][${platform}][${integration}][${tag}][${level}]`;
  }
  const name = String(event.event || 'event').toUpperCase();
  return `[NATIVE][${platform}][${integration}][${category}][${name}]`;
}

function subscribe(handler) {
  if (!nativeEmitter) {
    return { remove() {} };
  }
  return nativeEmitter.addListener(EVENT_NAME, handler);
}

async function getBufferedEvents() {
  if (!nativeModule || typeof nativeModule.getBufferedEvents !== 'function') return [];
  const result = await nativeModule.getBufferedEvents();
  return Array.isArray(result) ? result : [];
}

async function clearBufferedEvents() {
  if (!nativeModule || typeof nativeModule.clearBufferedEvents !== 'function') return;
  return nativeModule.clearBufferedEvents();
}

function setEnabled(enabled) {
  if (!nativeModule || typeof nativeModule.setEnabled !== 'function') return;
  nativeModule.setEnabled(Boolean(enabled));
}

function startRuntimeTelemetry(options = {}) {
  if (!nativeModule || typeof nativeModule.startRuntimeTelemetry !== 'function') return;
  const intervalMs = Math.max(250, Math.min(5000, Number(options.intervalMs) || 1000));
  nativeModule.startRuntimeTelemetry(intervalMs);
}

function stopRuntimeTelemetry() {
  if (!nativeModule || typeof nativeModule.stopRuntimeTelemetry !== 'function') return;
  nativeModule.stopRuntimeTelemetry();
}

async function getRuntimeMetrics() {
  if (!nativeModule || typeof nativeModule.getRuntimeMetrics !== 'function') {
    return { available: false, reason: 'native-module-unavailable' };
  }
  const value = await nativeModule.getRuntimeMetrics();
  return value && typeof value === 'object' ? value : { available: false, reason: 'invalid-native-response' };
}

async function installConsoleTransport(options = {}) {
  if (!nativeModule || !nativeEmitter) {
    if (options.silent !== true) {
      console.warn('[react-native-native-debugger] Native module is not linked; console transport was not installed.');
    }
    return { remove() {} };
  }

  if (options.runtimeTelemetry !== false) {
    startRuntimeTelemetry({ intervalMs: options.telemetryIntervalMs });
  }

  const settings = {
    integrations: options.integrations || null,
    categories: options.categories || null,
    events: options.events || null,
    levels: options.levels ? options.levels.map((level) => String(level).toLowerCase()) : null,
    redactKeys: options.redactKeys || [],
    includeData: options.includeData !== false,
    replayBuffered: options.replayBuffered !== false,
    prefix: options.prefix || '',
    onEvent: typeof options.onEvent === 'function' ? options.onEvent : null
  };

  const seenIds = new Set();
  const maxSeen = 4000;

  const print = (event) => {
    if (!event || !matchesFilter(event, settings)) return;
    if (event.id && seenIds.has(event.id)) return;
    if (event.id) {
      seenIds.add(event.id);
      if (seenIds.size > maxSeen) {
        const first = seenIds.values().next().value;
        seenIds.delete(first);
      }
    }

    const safeEvent = redact(event, settings.redactKeys);
    if (settings.onEvent) settings.onEvent(safeEvent);

    const method = selectConsoleMethod(safeEvent);
    const prefix = `${settings.prefix}${formatPrefix(safeEvent)}`;
    const isNativeLog = safeEvent.category === 'native-log' || safeEvent.category === 'native-error';
    if (isNativeLog) {
      const data = safeEvent.data || {};
      const message = data.message || data.error || '';
      if (settings.includeData) {
        const details = { ...data };
        delete details.message;
        delete details.tag;
        if (Object.keys(details).length > 0) console[method](prefix, message, details);
        else console[method](prefix, message);
      } else {
        console[method](prefix, message);
      }
    } else if (settings.includeData) {
      console[method](prefix, safeEvent.data || {});
    } else {
      console[method](prefix);
    }
  };

  // Subscribe first, then replay. Event IDs make the small overlap race harmless.
  const subscription = nativeEmitter.addListener(EVENT_NAME, print);
  if (settings.replayBuffered) {
    try {
      const buffered = await getBufferedEvents();
      buffered.forEach(print);
    } catch (error) {
      console.warn('[react-native-native-debugger] Could not replay native log buffer:', error);
    }
  }

  return subscription;
}

module.exports = {
  EVENT_NAME,
  isAvailable: Boolean(nativeModule),
  subscribe,
  installConsoleTransport,
  getBufferedEvents,
  clearBufferedEvents,
  setEnabled,
  startRuntimeTelemetry,
  stopRuntimeTelemetry,
  getRuntimeMetrics,
  redact
};
