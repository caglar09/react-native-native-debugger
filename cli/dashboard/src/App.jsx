import React, { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { levelName, logStore, serviceName, sourceName } from './store';

const LIMITS = [10, 20, 50, 100, 500, 1000, 5000];
const SPEEDS = [[80, 'Realtime'], [250, '250 ms'], [500, '500 ms'], [1000, '1 s'], [2000, '2 s']];
const METRIC_HISTORY = 180;

function matches(event, filters) {
  if (filters.processes.size && !filters.processes.has(event.process || '')) return false;
  if (filters.level && levelName(event) !== filters.level) return false;
  if (filters.package && sourceName(event) !== filters.package) return false;
  if (filters.service && serviceName(event) !== filters.service) return false;
  if (!filters.search) return true;
  return JSON.stringify(event).toLowerCase().includes(filters.search.toLowerCase());
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function download(data, format, suffix) {
  const body = format === 'ndjson' ? data.map((item) => JSON.stringify(item)).join('\n') : JSON.stringify(data, null, 2);
  const blob = new Blob([body], { type: format === 'ndjson' ? 'application/x-ndjson' : 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `rn-native-debugger-${suffix}-${new Date().toISOString().replace(/[:.]/g, '-') }.${format === 'ndjson' ? 'ndjson' : 'json'}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

const Sparkline = memo(function Sparkline({ values, suffix = '', precision = 0 }) {
  const data = values.filter((value) => Number.isFinite(value));
  const latest = data.length ? data[data.length - 1] : null;
  const max = Math.max(1, ...data);
  const min = Math.min(0, ...data);
  const range = Math.max(1, max - min);
  const points = data.map((value, index) => {
    const x = data.length <= 1 ? 100 : (index / (data.length - 1)) * 100;
    const y = 34 - ((value - min) / range) * 30;
    return `${x},${y}`;
  }).join(' ');
  return (
    <div className="sparkline-wrap">
      <svg viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="sparkline-value">{latest == null ? '—' : `${latest.toFixed(precision)}${suffix}`}</div>
    </div>
  );
});

const InfoRow = memo(function InfoRow({ label, value, mono = false }) {
  return <div className="info-row"><span>{label}</span><strong className={mono ? 'mono' : ''}>{value || '—'}</strong></div>;
});

const PanelCard = memo(function PanelCard({ title, children, className = '' }) {
  return <section className={`panel-card ${className}`}><div className="panel-title">{title}</div>{children}</section>;
});

const SearchableFacet = memo(function SearchableFacet({ value, onChange, label, values }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const handler = (event) => { if (!ref.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? values.filter((item) => String(item).toLowerCase().includes(normalized))
    : values;

  return (
    <div className="facet-picker" ref={ref}>
      <button type="button" onClick={() => setOpen((current) => !current)} title={value || label}>
        {value || label}
      </button>
      {open && (
        <div className="facet-menu">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${label.replace(/^All /, '').toLowerCase()}…`}
          />
          <button className="facet-all" type="button" onClick={() => { onChange(''); setOpen(false); }}>All</button>
          <div className="facet-options">
            {filtered.map((item) => (
              <button
                type="button"
                className={value === item ? 'facet-option selected' : 'facet-option'}
                key={item}
                onClick={() => { onChange(item); setOpen(false); }}
              >
                {item}
              </button>
            ))}
            {!filtered.length && <div className="process-empty">No matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
});

const ProcessPicker = memo(function ProcessPicker({ values, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    const handler = (event) => { if (!ref.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (name) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name); else next.add(name);
    onChange(next);
  };
  const normalizedQuery = query.trim().toLowerCase();
  const filteredValues = normalizedQuery
    ? values.filter((name) => String(name).toLowerCase().includes(normalizedQuery))
    : values;

  return (
    <div className="process-picker" ref={ref}>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        {selected.size ? `${selected.size} process${selected.size === 1 ? '' : 'es'}` : 'All processes'}
      </button>
      {open && (
        <div className="process-menu">
          <div className="process-menu-head"><strong>Processes</strong><button type="button" onClick={() => onChange(new Set())}>All</button></div>
          <input className="facet-search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search processes…" />
          {!filteredValues.length && <div className="process-empty">{values.length ? 'No matches.' : 'No process information yet.'}</div>}
          {filteredValues.map((name) => (
            <label key={name} className="process-option">
              <input type="checkbox" checked={selected.has(name)} onChange={() => toggle(name)} />
              <span>{name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
});

const Header = memo(function Header({ connected, paused, onPause, onClear, visibleCount, bufferedCount, selectedCount, selectedIds, filteredRows, activeRows, session }) {
  const platform = session?.device?.platform === 'android' ? 'Android' : session?.device?.platform === 'ios' ? 'iOS' : 'Unknown platform';
  return (
    <header className="topbar">
      <div className="brand-cluster">
        <div className="brand-mark">RN</div>
        <div><div className="brand">Native Debugger</div><div className="brand-sub">{session?.app?.name || 'Runtime session'} · {platform}</div></div>
      </div>
      <div className="topbar-state">
        <span className={paused || !connected ? 'status paused' : 'status live'}>● {paused ? 'PAUSED' : connected ? 'LIVE' : 'DISCONNECTED'}</span>
        <span className="badge">{visibleCount} visible</span>
        <span className="badge">{bufferedCount} captured</span>
        <span className="badge">{selectedCount} selected</span>
      </div>
      <div className="topbar-actions">
        <button onClick={onPause}>{paused ? 'Resume' : 'Pause'}</button>
        <button className="danger" onClick={onClear}>Clear</button>
        <button disabled={!paused} onClick={() => download(filteredRows, 'json', 'filtered')}>JSON</button>
        <button disabled={!paused} onClick={() => download(filteredRows, 'ndjson', 'filtered')}>NDJSON</button>
        <button disabled={!paused || !selectedCount} onClick={() => download(activeRows.filter((row) => selectedIds.has(row.id)), 'json', 'selected')}>Selected</button>
      </div>
    </header>
  );
});

const Filters = memo(function Filters({ filters, setFilters, limit, setLimit, speed, setSpeed }) {
  useSyncExternalStore(logStore.subscribeFacets, logStore.getFacetRevision, logStore.getFacetRevision);
  const facets = logStore.getFacets();
  return (
    <div className="filters-shell">
      <div className="filters">
        <ProcessPicker values={facets.processes} selected={filters.processes} onChange={(processes) => setFilters((current) => ({ ...current, processes }))} />
        <select value={filters.level} onChange={(event) => setFilters((current) => ({ ...current, level: event.target.value }))}>
          <option value="">All levels</option>
          {facets.levels.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <SearchableFacet label="All packages" values={facets.packages} value={filters.package} onChange={(pkg) => setFilters((current) => ({ ...current, package: pkg }))} />
        <SearchableFacet label="All services" values={facets.services} value={filters.service} onChange={(service) => setFilters((current) => ({ ...current, service }))} />
        <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>{LIMITS.map((value) => <option key={value} value={value}>{value} logs</option>)}</select>
        <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>{SPEEDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <input value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Search message, class, file, subsystem, package…" />
      </div>
    </div>
  );
});

const LogRow = memo(function LogRow({ row, selected, onSelect }) {
  const [expanded, setExpanded] = useState(false);
  const level = levelName(row);
  const location = [row.className, row.method, row.file && row.line ? `${row.file}:${row.line}` : row.file].filter(Boolean).join(' · ');
  return (
    <article className={`log ${level}`}>
      <label className="pick"><input type="checkbox" checked={selected} onChange={(event) => onSelect(row.id, event.target.checked)} /></label>
      <div className="time">{row.timestamp || new Date(row.receivedAt || Date.now()).toLocaleTimeString()}</div>
      <div className="level-pill">{level}</div>
      <div><div className="source">{sourceName(row)}</div><div className="service">{row.process || 'Unknown process'} · {serviceName(row)}</div></div>
      <div><div className="message">{row.message || row.raw || ''}</div><div className="meta">{[row.pid && `pid=${row.pid}`, row.tid && `tid=${row.tid}`, row.subsystem && `subsystem=${row.subsystem}`, row.category && `category=${row.category}`, location].filter(Boolean).join(' · ')}</div></div>
      <div className="actions"><button onClick={() => navigator.clipboard.writeText(JSON.stringify(row, null, 2))}>Copy</button><button onClick={() => setExpanded((value) => !value)}>Details</button></div>
      {expanded && <pre className="details">{JSON.stringify(row, null, 2)}</pre>}
    </article>
  );
});

function LogList({ rows, selectedIds, onSelect }) {
  const parentRef = useRef(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 86,
    overscan: 12,
    getItemKey: (index) => rows[index]?.id || index
  });
  if (!rows.length) return <div className="empty">No logs match the current filters.</div>;
  return (
    <main ref={parentRef} className="log-viewport">
      <div className="virtual-space" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} className="virtual-row" style={{ transform: `translateY(${item.start}px)` }}>
              <LogRow row={row} selected={selectedIds.has(row.id)} onSelect={onSelect} />
            </div>
          );
        })}
      </div>
    </main>
  );
}

const DeviceSidebar = memo(function DeviceSidebar({ session, focusProcess, metrics }) {
  const device = session?.device || {};
  const app = session?.app || {};
  const metro = session?.metro || {};
  return (
    <aside className="sidebar left-sidebar">
      <PanelCard title="Device">
        <div className="device-hero"><div className="device-icon">{device.platform === 'android' ? 'A' : 'iOS'}</div><div><strong>{device.deviceName || 'Connected device'}</strong><span>{device.model || device.platform || 'Unknown model'}</span></div></div>
        <InfoRow label="OS" value={device.osVersion} />
        <InfoRow label="Architecture" value={device.architecture} mono />
        <InfoRow label="Device ID" value={device.deviceId} mono />
        <InfoRow label="Memory" value={formatBytes(device.totalMemoryBytes)} />
      </PanelCard>
      <PanelCard title="Application">
        <InfoRow label="Name" value={app.name} />
        <InfoRow label="Version" value={app.version} />
        <InfoRow label="Bundle ID" value={app.bundleId} mono />
        <InfoRow label="React Native" value={app.reactNativeVersion} mono />
        <InfoRow label="React" value={app.reactVersion} mono />
        <InfoRow label="Process" value={focusProcess || app.primaryProcess} mono />
        <InfoRow label="PID" value={metrics?.pid ? String(metrics.pid) : null} mono />
      </PanelCard>
      <PanelCard title="Session">
        <div className="health-row"><span className={metro.connected ? 'health-dot good' : 'health-dot'} />Metro <strong>{metro.connected ? 'Connected' : 'Not detected'}</strong></div>
        <div className="health-row"><span className="health-dot good" />Native log stream <strong>Active</strong></div>
        <InfoRow label="Metro port" value={metro.port ? String(metro.port) : null} mono />
        <InfoRow label="Collector" value={session?.collector?.platform} mono />
      </PanelCard>
    </aside>
  );
});

const MetricCard = memo(function MetricCard({ title, value, subtitle, values, suffix = '', precision = 0 }) {
  return (
    <PanelCard title={title} className="metric-card">
      <div className="metric-headline">{value}</div>
      <div className="metric-subtitle">{subtitle}</div>
      <Sparkline values={values} suffix={suffix} precision={precision} />
    </PanelCard>
  );
});

const LevelDistribution = memo(function LevelDistribution({ levels }) {
  const entries = Object.entries(levels || {}).sort((a, b) => b[1] - a[1]);
  const total = Math.max(1, entries.reduce((sum, [, count]) => sum + count, 0));
  return (
    <PanelCard title="Log distribution">
      <div className="distribution">
        {entries.slice(0, 6).map(([level, count]) => (
          <div key={level} className="distribution-row">
            <div className="distribution-label"><span>{level}</span><strong>{count}</strong></div>
            <div className="distribution-track"><i style={{ width: `${Math.max(2, (count / total) * 100)}%` }} /></div>
          </div>
        ))}
        {!entries.length && <div className="muted">Waiting for logs…</div>}
      </div>
    </PanelCard>
  );
});

const MetricsSidebar = memo(function MetricsSidebar({ metrics, history, logStats, logRateHistory, focusProcess }) {
  const memoryValues = history.map((item) => item.memoryBytes ? item.memoryBytes / 1024 / 1024 : 0);
  const cpuValues = history.map((item) => Number(item.cpuPercent || 0));
  return (
    <aside className="sidebar right-sidebar">
      <div className="sidebar-heading"><div><strong>Performance</strong><span>{focusProcess || 'Select one process'}</span></div><span className={metrics?.available ? 'pulse-dot' : 'pulse-dot off'} /></div>
      <MetricCard title="Memory" value={metrics?.available ? formatBytes(metrics.memoryBytes) : 'Unavailable'} subtitle="Resident / PSS memory" values={memoryValues} suffix=" MB" precision={0} />
      <MetricCard title="CPU" value={metrics?.available && Number.isFinite(metrics.cpuPercent) ? `${metrics.cpuPercent.toFixed(1)}%` : 'Unavailable'} subtitle="Current process CPU" values={cpuValues} suffix="%" precision={1} />
      <MetricCard title="Log rate" value={`${logStats.logsPerSecond.toFixed(1)}/s`} subtitle={`${logStats.total.toLocaleString()} logs captured`} values={logRateHistory} suffix="/s" precision={1} />
      <LevelDistribution levels={logStats.levels} />
    </aside>
  );
});

export default function App() {
  const logRevision = useSyncExternalStore(logStore.subscribeLogs, logStore.getLogRevision, logStore.getLogRevision);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filters, setFilters] = useState({ processes: new Set(), level: '', package: '', service: '', search: '' });
  const [limit, setLimit] = useState(100);
  const [speed, setSpeedState] = useState(500);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [session, setSession] = useState(null);
  const [metrics, setMetrics] = useState({ available: false });
  const [metricHistory, setMetricHistory] = useState([]);
  const [logStats, setLogStats] = useState(() => logStore.getStats());
  const [logRateHistory, setLogRateHistory] = useState([]);

  const activeRows = logStore.getActiveData();
  const selectedProcesses = useMemo(() => [...filters.processes], [filters.processes]);
  const observedRuntimeProcess = useMemo(() => {
    const signal = activeRows.find((row) => {
      if (!row.process) return false;
      const haystack = [row.package, row.integration, row.subsystem, row.tag, row.sourceLibrary, row.message].filter(Boolean).join(' ');
      return row.sourceKind === 'app/process' || /com\.facebook\.react|react[- ]?native|hermes/i.test(haystack);
    });
    return signal?.process || '';
  }, [activeRows, logRevision]);
  const focusProcess = selectedProcesses.length === 1
    ? selectedProcesses[0]
    : selectedProcesses.length === 0 ? (session?.app?.primaryProcess || observedRuntimeProcess || '') : '';

  useEffect(() => {
    logStore.setRenderInterval(500);
    const source = new EventSource('/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => logStore.push(JSON.parse(event.data));
    return () => source.close();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch('/processes', { cache: 'no-store' });
        if (!response.ok || cancelled) return;
        const processes = await response.json();
        if (!cancelled) logStore.setRunningProcesses(processes);
      } catch {}
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch('/session', { cache: 'no-store' });
        if (!response.ok || cancelled) return;
        const value = await response.json();
        if (!cancelled) setSession(value);
      } catch {}
    };
    refresh();
    const timer = setInterval(refresh, 8000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    setMetricHistory([]);
    if (!focusProcess) {
      setMetrics({ available: false });
      return undefined;
    }
    let cancelled = false;
    const sample = async () => {
      try {
        const response = await fetch(`/metrics?process=${encodeURIComponent(focusProcess)}`, { cache: 'no-store' });
        if (!response.ok || cancelled) return;
        const value = await response.json();
        if (cancelled) return;
        setMetrics(value);
        if (value.available) setMetricHistory((current) => [...current, value].slice(-METRIC_HISTORY));
      } catch {}
    };
    sample();
    const timer = setInterval(sample, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [focusProcess]);

  useEffect(() => {
    const sample = () => {
      const stats = logStore.getStats();
      setLogStats(stats);
      setLogRateHistory((current) => [...current, stats.logsPerSecond].slice(-METRIC_HISTORY));
    };
    sample();
    const timer = setInterval(sample, 1000);
    return () => clearInterval(timer);
  }, []);

  const filteredRows = useMemo(() => activeRows.filter((row) => matches(row, filters)).slice(0, limit), [activeRows, filters, limit, logRevision]);

  const setSpeed = (value) => { setSpeedState(value); logStore.setRenderInterval(value); };
  const togglePause = () => { if (paused) logStore.resume(); else logStore.pause(); setPaused((value) => !value); };
  const clear = () => { logStore.clear(); setSelectedIds(new Set()); setMetricHistory([]); setLogRateHistory([]); };
  const onSelect = (id, checked) => {
    if (!id) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };

  return (
    <div className="app-shell">
      <Header connected={connected} paused={paused} onPause={togglePause} onClear={clear} visibleCount={filteredRows.length} bufferedCount={activeRows.length} selectedCount={selectedIds.size} selectedIds={selectedIds} filteredRows={filteredRows} activeRows={activeRows} session={session} />
      <div className="workspace">
        <DeviceSidebar session={session} focusProcess={focusProcess} metrics={metrics} />
        <section className="main-panel">
          <Filters filters={filters} setFilters={setFilters} limit={limit} setLimit={setLimit} speed={speed} setSpeed={setSpeed} />
          <LogList rows={filteredRows} selectedIds={selectedIds} onSelect={onSelect} />
        </section>
        <MetricsSidebar metrics={metrics} history={metricHistory} logStats={logStats} logRateHistory={logRateHistory} focusProcess={focusProcess} />
      </div>
    </div>
  );
}
