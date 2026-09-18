function isKnown(value) {
  return Boolean(value && String(value).toLowerCase() !== 'unknown');
}

function sourceName(event) {
  return (isKnown(event.package) && event.package) ||
    event.integration ||
    event.process ||
    event.subsystem ||
    (isKnown(event.tag) && event.tag) ||
    'Unknown';
}

function serviceName(event) {
  return (isKnown(event.service) && event.service) ||
    event.subsystem ||
    event.category ||
    (isKnown(event.tag) && event.tag) ||
    event.process ||
    'Unknown';
}

function levelName(event) {
  return event.level || 'default';
}

export class NativeLogStore {
  constructor() {
    this.buffer = [];
    this.pausedSnapshot = null;
    this.paused = false;
    this.renderInterval = 80;
    this.logRevision = 0;
    this.facetRevision = 0;
    this.logListeners = new Set();
    this.facetListeners = new Set();
    this.renderTimer = null;
    this.levels = new Set();
    this.packages = new Set();
    this.services = new Set();
    this.processes = new Set();
    this.facetSnapshot = { levels: [], packages: [], services: [], processes: [] };
    this.levelCounts = new Map();
    this.rateBuckets = new Map();
    this.processByPid = new Map();
  }

  subscribeLogs = (listener) => {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  };

  subscribeFacets = (listener) => {
    this.facetListeners.add(listener);
    return () => this.facetListeners.delete(listener);
  };

  getLogRevision = () => this.logRevision;
  getFacetRevision = () => this.facetRevision;

  emitLogs() {
    this.logRevision += 1;
    for (const listener of this.logListeners) listener();
  }

  rebuildFacetSnapshot() {
    this.facetSnapshot = {
      levels: [...this.levels].sort(),
      packages: [...this.packages].sort(),
      services: [...this.services].sort(),
      processes: [...this.processes].sort()
    };
  }

  emitFacets() {
    this.rebuildFacetSnapshot();
    this.facetRevision += 1;
    for (const listener of this.facetListeners) listener();
  }

  scheduleLogs(immediate = false) {
    if (this.paused) return;
    if (this.renderTimer) {
      if (!immediate) return;
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    if (immediate) {
      this.emitLogs();
      return;
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.emitLogs();
    }, this.renderInterval);
  }

  updateFacets(event) {
    const values = [
      [this.levels, levelName(event)],
      [this.packages, sourceName(event)],
      [this.services, serviceName(event)],
      [this.processes, event.process]
    ];
    let changed = false;
    for (const [set, value] of values) {
      if (!value || set.has(value)) continue;
      set.add(value);
      changed = true;
    }
    if (changed) this.emitFacets();
  }

  push(event) {
    if (!event.process && event.pid && this.processByPid.has(Number(event.pid))) {
      event.process = this.processByPid.get(Number(event.pid));
    }
    this.buffer.unshift(event);
    const level = levelName(event);
    this.levelCounts.set(level, (this.levelCounts.get(level) || 0) + 1);
    const second = Math.floor(Number(event.receivedAt || Date.now()) / 1000);
    this.rateBuckets.set(second, (this.rateBuckets.get(second) || 0) + 1);
    for (const key of this.rateBuckets.keys()) {
      if (key < second - 60) this.rateBuckets.delete(key);
    }
    this.updateFacets(event);
    this.scheduleLogs();
  }

  setRunningProcesses(processes) {
    let changed = false;
    let enriched = false;
    for (const process of processes || []) {
      if (!process?.name) continue;
      if (process.pid) this.processByPid.set(Number(process.pid), process.name);
      if (!this.processes.has(process.name)) {
        this.processes.add(process.name);
        changed = true;
      }
    }

    for (const event of this.buffer) {
      if (!event.process && event.pid && this.processByPid.has(Number(event.pid))) {
        event.process = this.processByPid.get(Number(event.pid));
        enriched = true;
      }
    }

    if (enriched) {
      this.packages = new Set(this.buffer.map(sourceName).filter(Boolean));
      this.services = new Set(this.buffer.map(serviceName).filter(Boolean));
    }
    if (changed || enriched) {
      this.emitFacets();
      if (enriched) this.scheduleLogs(true);
    }
  }

  setRenderInterval(ms) {
    this.renderInterval = Number(ms) || 80;
    this.scheduleLogs(true);
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.pausedSnapshot = this.buffer.slice();
    this.emitLogs();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.pausedSnapshot = null;
    this.scheduleLogs(true);
  }

  clear() {
    this.buffer = [];
    this.pausedSnapshot = this.paused ? [] : null;
    this.levels = new Set();
    this.packages = new Set();
    this.services = new Set();
    this.processes = new Set();
    this.levelCounts = new Map();
    this.rateBuckets = new Map();
    this.processByPid = new Map();
    this.emitFacets();
    this.emitLogs();
  }

  getActiveData() {
    return this.paused && this.pausedSnapshot ? this.pausedSnapshot : this.buffer;
  }

  getFacets() {
    return this.facetSnapshot;
  }

  getStats(now = Date.now()) {
    const currentSecond = Math.floor(now / 1000);
    let recentTenSeconds = 0;
    for (let second = currentSecond - 9; second <= currentSecond; second += 1) {
      recentTenSeconds += this.rateBuckets.get(second) || 0;
    }
    return {
      total: this.buffer.length,
      logsPerSecond: recentTenSeconds / 10,
      levels: Object.fromEntries(this.levelCounts)
    };
  }
}

export const logStore = new NativeLogStore();
export { sourceName, serviceName, levelName };
