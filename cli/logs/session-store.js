'use strict';

const CRASH_RE = /FATAL EXCEPTION|SIG(?:ABRT|SEGV|BUS|ILL|TRAP)|uncaught exception|terminating app|out of memory|\bOOM\b|\bANR\b|fatal error/i;
const NETWORK_RE = /CFNetwork|com\.apple\.network|network\.framework|\bnw_|okhttp|\bTLS\b|\bQUIC\b|https?:\/\/|socket|connection/i;

function normalizeText(value) {
  return String(value == null ? '' : value).toLowerCase();
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function eventSearchText(event) {
  return JSON.stringify(event || {}).toLowerCase();
}

function isNetworkEvent(event) {
  if (event && event.network) return true;
  return NETWORK_RE.test([
    event && event.message,
    event && event.raw,
    event && event.subsystem,
    event && event.service,
    event && event.tag
  ].filter(Boolean).join(' '));
}

function isCrashEvent(event) {
  if (!event) return false;
  if (String(event.level || '').toLowerCase() === 'fatal') return true;
  return CRASH_RE.test([event.message, event.raw].filter(Boolean).join(' '));
}

function normalizeErrorSignature(event) {
  const level = String(event && event.level || 'unknown').toLowerCase();
  const process = String(event && event.process || 'Unknown');
  const source = String(
    event && (event.package || event.service || event.subsystem || event.tag) || 'Unknown'
  );
  const message = String(event && (event.message || event.raw) || 'Unknown error')
    .replace(/0x[0-9a-f]+/gi, '0x…')
    .replace(/\b\d{4,}\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
  return `${level}|${process}|${source}|${message}`;
}

function appIdentity(app) {
  const names = new Set();
  const primary = app && app.primaryProcess;
  const bundleId = app && app.bundleId;
  const appName = app && app.name;
  for (const value of [primary, bundleId, appName]) {
    if (!value) continue;
    names.add(normalizeText(value));
  }
  return [...names];
}

function eventBelongsToApp(event, app) {
  const identities = appIdentity(app);
  if (!identities.length) return true;

  const candidates = [
    event && event.process,
    event && event.app,
    event && event.package,
    event && event.service
  ].filter(Boolean).map(normalizeText);

  return candidates.some((candidate) =>
    identities.some((identity) =>
      candidate === identity ||
      candidate.includes(identity) ||
      identity.includes(candidate)
    )
  );
}

function matchesLog(event, options, app) {
  if (!event) return false;

  if (options.scope === 'app' && !eventBelongsToApp(event, app)) return false;

  const levels = options.levels || [];
  if (levels.length && !levels.includes(String(event.level || 'default').toLowerCase())) return false;

  if (options.process && !normalizeText(event.process).includes(normalizeText(options.process))) return false;
  if (options.package && !normalizeText(event.package).includes(normalizeText(options.package))) return false;
  if (options.service && !normalizeText(event.service).includes(normalizeText(options.service))) return false;
  if (options.subsystem && !normalizeText(event.subsystem).includes(normalizeText(options.subsystem))) return false;
  if (options.tag && !normalizeText(event.tag).includes(normalizeText(options.tag))) return false;
  if (options.text && !eventSearchText(event).includes(normalizeText(options.text))) return false;

  if (options.networkOnly && !isNetworkEvent(event)) return false;

  if (options.errorsOnly) {
    const level = String(event.level || '').toLowerCase();
    if (!['error', 'fatal'].includes(level) && !isCrashEvent(event)) return false;
  }

  if (options.lookbackMs) {
    const receivedAt = Number(event.receivedAt || event.timestamp || 0);
    if (receivedAt && receivedAt < Date.now() - options.lookbackMs) return false;
  }

  return true;
}

class NativeLogSession {
  constructor({ maxLogs = 0 } = {}) {
    this.maxLogs = Math.max(0, Number(maxLogs) || 0);
    this.logs = [];
    this.runtimeByProcess = new Map();
    this.startedAt = Date.now();
    this.lastReceivedAt = null;
    this.totalSeen = 0;
    this.dropped = 0;
  }

  push(event) {
    if (!event || typeof event !== 'object') return;

    this.totalSeen += 1;
    this.lastReceivedAt = Number(event.receivedAt || Date.now());

    if (event.kind === 'runtime-telemetry' && event.telemetry) {
      const telemetry = {
        ...event.telemetry,
        process: event.telemetry.process || event.process || null,
        pid: event.telemetry.pid || event.pid || null,
        receivedAt: this.lastReceivedAt
      };
      const key = telemetry.process || String(telemetry.pid || 'main');
      this.runtimeByProcess.set(key, telemetry);
      return;
    }

    this.logs.unshift(event);

    if (this.maxLogs > 0 && this.logs.length > this.maxLogs) {
      const removeCount = this.logs.length - this.maxLogs;
      this.logs.splice(this.maxLogs, removeCount);
      this.dropped += removeCount;
    }
  }

  clear() {
    this.logs = [];
    this.runtimeByProcess.clear();
    this.startedAt = Date.now();
    this.lastReceivedAt = null;
    this.totalSeen = 0;
    this.dropped = 0;
  }

  search(rawOptions = {}, app = {}) {
    const options = {
      scope: rawOptions.scope === 'all' ? 'all' : 'app',
      text: rawOptions.text || '',
      process: rawOptions.process || '',
      package: rawOptions.package || '',
      service: rawOptions.service || '',
      subsystem: rawOptions.subsystem || '',
      tag: rawOptions.tag || '',
      levels: Array.isArray(rawOptions.levels)
        ? rawOptions.levels.map((value) => String(value).toLowerCase())
        : String(rawOptions.levels || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
      networkOnly: Boolean(rawOptions.networkOnly),
      errorsOnly: Boolean(rawOptions.errorsOnly),
      lookbackMs: Math.max(0, Number(rawOptions.lookbackMs) || 0),
      limit: clampInteger(rawOptions.limit, 1, 500, 100),
      order: rawOptions.order === 'asc' ? 'asc' : 'desc'
    };

    const scopeApplied = options.scope !== 'app' || appIdentity(app).length > 0;
    const rows = [];
    let totalMatches = 0;

    for (const event of this.logs) {
      if (!matchesLog(event, options, app)) continue;
      totalMatches += 1;
      if (rows.length < options.limit) rows.push(event);
    }

    if (options.order === 'asc') rows.reverse();

    return {
      logs: rows,
      totalMatches,
      totalCaptured: this.logs.length,
      totalSeen: this.totalSeen,
      dropped: this.dropped,
      scope: options.scope,
      scopeApplied,
      app: {
        name: app && app.name || null,
        bundleId: app && app.bundleId || null,
        primaryProcess: app && app.primaryProcess || null
      }
    };
  }

  context(id, { before = 20, after = 20 } = {}) {
    const index = this.logs.findIndex((event) => event && event.id === id);
    if (index < 0) return null;

    const beforeCount = clampInteger(before, 0, 100, 20);
    const afterCount = clampInteger(after, 0, 100, 20);
    const older = this.logs.slice(index + 1, index + 1 + beforeCount).reverse();
    const newer = this.logs.slice(Math.max(0, index - afterCount), index).reverse();

    return {
      target: this.logs[index],
      context: [...older, this.logs[index], ...newer],
      olderCount: older.length,
      newerCount: newer.length
    };
  }

  errorGroups(rawOptions = {}, app = {}) {
    const limit = clampInteger(rawOptions.limit, 1, 100, 20);
    const result = this.search({
      ...rawOptions,
      errorsOnly: true,
      limit: 500,
      order: 'desc'
    }, app);

    const groups = new Map();
    for (const event of result.logs) {
      const signature = normalizeErrorSignature(event);
      const current = groups.get(signature) || {
        signature,
        level: String(event.level || 'unknown').toLowerCase(),
        process: event.process || 'Unknown',
        package: event.package || null,
        service: event.service || null,
        count: 0,
        crashSignal: false,
        latest: event,
        sampleIds: []
      };
      current.count += 1;
      current.crashSignal = current.crashSignal || isCrashEvent(event);
      if (current.sampleIds.length < 5 && event.id) current.sampleIds.push(event.id);
      const currentTime = Number(current.latest.receivedAt || current.latest.timestamp || 0);
      const eventTime = Number(event.receivedAt || event.timestamp || 0);
      if (eventTime > currentTime) current.latest = event;
      groups.set(signature, current);
    }

    const sorted = [...groups.values()]
      .sort((a, b) =>
        Number(b.crashSignal) - Number(a.crashSignal) ||
        b.count - a.count ||
        Number(b.latest.receivedAt || b.latest.timestamp || 0) - Number(a.latest.receivedAt || a.latest.timestamp || 0)
      )
      .slice(0, limit);

    return {
      groups: sorted,
      totalGroups: groups.size,
      totalErrorMatches: result.totalMatches,
      scope: result.scope,
      scopeApplied: result.scopeApplied,
      app: result.app
    };
  }

  runtime(processName) {
    if (processName && this.runtimeByProcess.has(processName)) {
      return this.runtimeByProcess.get(processName);
    }

    if (processName) {
      const needle = normalizeText(processName);
      for (const [name, telemetry] of this.runtimeByProcess) {
        if (normalizeText(name).includes(needle) || needle.includes(normalizeText(name))) return telemetry;
      }
    }

    let latest = null;
    for (const telemetry of this.runtimeByProcess.values()) {
      if (!latest || Number(telemetry.receivedAt || 0) > Number(latest.receivedAt || 0)) latest = telemetry;
    }
    return latest;
  }

  stats() {
    const levels = {};
    const processes = {};
    let errors = 0;
    let warnings = 0;
    let network = 0;

    for (const event of this.logs) {
      const level = String(event.level || 'default').toLowerCase();
      levels[level] = (levels[level] || 0) + 1;
      const process = event.process || 'Unknown';
      processes[process] = (processes[process] || 0) + 1;
      if (level === 'error' || level === 'fatal' || isCrashEvent(event)) errors += 1;
      if (level === 'warn' || level === 'warning') warnings += 1;
      if (isNetworkEvent(event)) network += 1;
    }

    return {
      startedAt: this.startedAt,
      lastReceivedAt: this.lastReceivedAt,
      totalCaptured: this.logs.length,
      totalSeen: this.totalSeen,
      dropped: this.dropped,
      levels,
      processes,
      errors,
      warnings,
      network,
      runtimeProcesses: [...this.runtimeByProcess.keys()]
    };
  }
}

module.exports = {
  NativeLogSession,
  matchesLog,
  eventBelongsToApp,
  isCrashEvent,
  isNetworkEvent,
  normalizeErrorSignature
};
