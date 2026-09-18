'use strict';

class DashboardClient {
  constructor(baseUrl, { timeoutMs = 5000 } = {}) {
    this.baseUrl = String(baseUrl || 'http://127.0.0.1:9876').replace(/\/$/, '');
    this.timeoutMs = Math.max(500, Number(timeoutMs) || 5000);
  }

  async get(pathname, params = {}) {
    const url = new URL(pathname, this.baseUrl + '/');
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        if (value.length) url.searchParams.set(key, value.join(','));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal
      });
      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }

      if (!response.ok) {
        const message = body && body.error
          ? body.error
          : `Dashboard request failed with HTTP ${response.status}`;
        const error = new Error(message);
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return body;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error(`Timed out connecting to React Native Native Debugger at ${this.baseUrl}`);
      }
      if (error && /fetch failed/i.test(String(error.message || ''))) {
        throw new Error(
          `Could not connect to React Native Native Debugger at ${this.baseUrl}. Start "rn-native-debugger logs" first.`
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  health() {
    return this.get('/health');
  }

  session() {
    return this.get('/session');
  }

  stats() {
    return this.get('/api/log-stats');
  }

  searchLogs(options = {}) {
    return this.get('/api/logs', {
      scope: options.scope || 'app',
      text: options.text,
      process: options.process,
      package: options.package,
      service: options.service,
      subsystem: options.subsystem,
      tag: options.tag,
      levels: options.levels,
      networkOnly: options.networkOnly,
      errorsOnly: options.errorsOnly,
      lookbackMs: options.lookbackMs,
      limit: options.limit,
      order: options.order
    });
  }

  logContext(id, options = {}) {
    return this.get('/api/log-context', {
      id,
      before: options.before,
      after: options.after
    });
  }

  errorGroups(options = {}) {
    return this.get('/api/errors', {
      scope: options.scope || 'app',
      process: options.process,
      package: options.package,
      service: options.service,
      text: options.text,
      lookbackMs: options.lookbackMs,
      limit: options.limit
    });
  }

  processes() {
    return this.get('/process-metrics');
  }

  processList() {
    return this.get('/processes');
  }

  runtime(processName) {
    return this.get('/api/runtime', { process: processName });
  }

  metrics(processName) {
    return this.get('/metrics', { process: processName });
  }
}

module.exports = { DashboardClient };
