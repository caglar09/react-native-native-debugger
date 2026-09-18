import React, { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { levelName, logStore, serviceName, sourceName } from './store';

const LIMITS = [50, 100, 250, 500, 1000, 5000];
const SPEEDS = [[80, 'Realtime'], [250, '250ms'], [500, '500ms'], [1000, '1s'], [2000, '2s']];
const NETWORK_RE = /CFNetwork|com\.apple\.network|network\.framework|\bnw_|okhttp|\bTLS\b|\bQUIC\b|https?:\/\/|socket|connection/i;
const CRASH_RE = /FATAL EXCEPTION|SIG(?:ABRT|SEGV|BUS|ILL|TRAP)|uncaught exception|terminating app|out of memory|\bOOM\b|\bANR\b|fatal error/i;

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function shortTime(row) {
  const timestamp = String(row.timestamp || '');
  const match = timestamp.match(/(\d\d:\d\d:\d\d\.\d+)/);
  if (match) return match[1];
  return new Date(row.receivedAt || Date.now()).toLocaleTimeString([], { hour12: false });
}

function download(data, format, suffix) {
  const body = format === 'ndjson'
    ? data.map((item) => JSON.stringify(item)).join('\n')
    : JSON.stringify(data, null, 2);
  const blob = new Blob([body], { type: format === 'ndjson' ? 'application/x-ndjson' : 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `rn-native-debugger-${suffix}-${new Date().toISOString().replace(/[:.]/g, '-') }.${format === 'ndjson' ? 'ndjson' : 'json'}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function eventHaystack(row) {
  return [
    row.message, row.raw, row.process, row.pid, row.package, row.service, row.subsystem,
    row.category, row.tag, row.className, row.method, row.file,
    row.network?.url, row.network?.endpoint, row.network?.protocol, row.network?.errorCode
  ].filter(Boolean).join(' ').toLowerCase();
}

function tokenizeQuery(query) {
  const tokens = [];
  String(query || '').replace(/([A-Za-z]+):"([^"]+)"|([A-Za-z]+):'([^']+)'|"([^"]+)"|'([^']+)'|(\S+)/g, (_, keyDouble, valueDouble, keySingle, valueSingle, doubleQuoted, singleQuoted, bare) => {
    if (keyDouble) tokens.push(`${keyDouble}:${valueDouble}`);
    else if (keySingle) tokens.push(`${keySingle}:${valueSingle}`);
    else tokens.push(doubleQuoted || singleQuoted || bare);
    return '';
  });
  return tokens;
}

function queryMatches(row, query) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return true;
  const haystack = eventHaystack(row);

  for (const token of tokens) {
    const separator = token.indexOf(':');
    if (separator <= 0) {
      if (!haystack.includes(token.toLowerCase())) return false;
      continue;
    }

    const key = token.slice(0, separator).toLowerCase();
    const value = token.slice(separator + 1).toLowerCase();
    if (!value) continue;

    if ((key === 'is' || key === 'level') && levelName(row).toLowerCase() !== value) return false;
    else if (key === 'process' && !String(row.process || '').toLowerCase().includes(value)) return false;
    else if (key === 'pid' && String(row.pid || '') !== value) return false;
    else if ((key === 'package' || key === 'source') && !sourceName(row).toLowerCase().includes(value)) return false;
    else if (key === 'service' && !serviceName(row).toLowerCase().includes(value)) return false;
    else if (key === 'subsystem' && !String(row.subsystem || '').toLowerCase().includes(value)) return false;
    else if (key === 'tag' && !String(row.tag || '').toLowerCase().includes(value)) return false;
    else if (key === 'category' && !String(row.category || '').toLowerCase().includes(value)) return false;
    else if (key === 'network' && value !== 'false' && !isNetworkEvent(row)) return false;
    else if (!['is', 'level', 'process', 'pid', 'package', 'source', 'service', 'subsystem', 'tag', 'category', 'network'].includes(key) && !haystack.includes(token.toLowerCase())) return false;
  }
  return true;
}

function facetMatches(row, filters) {
  if (filters.processes.size && !filters.processes.has(row.process || '')) return false;
  if (filters.level && levelName(row) !== filters.level) return false;
  if (filters.package && sourceName(row) !== filters.package) return false;
  if (filters.service && serviceName(row) !== filters.service) return false;
  return true;
}

function isNetworkEvent(row) {
  if (row.network) return true;
  return NETWORK_RE.test(eventHaystack(row));
}

function isCrashEvent(row) {
  return levelName(row) === 'fatal' || CRASH_RE.test(eventHaystack(row));
}

function anomalySignature(row) {
  const message = String(row.message || row.raw || 'Unknown error')
    .replace(/0x[0-9a-f]+/gi, '0x…')
    .replace(/\b\d{4,}\b/g, '#')
    .slice(0, 180);
  return `${levelName(row)}|${row.process || 'Unknown'}|${sourceName(row)}|${message}`;
}

function runtimeForProcess(nativeRuntime, metric) {
  if (!nativeRuntime?.available) return metric || null;
  const runtimeName = String(nativeRuntime.process || '').toLowerCase();
  const metricName = String(metric?.process || '').toLowerCase();
  if (metric && runtimeName && metricName && runtimeName !== metricName) return metric;
  return {
    ...(metric || {}),
    ...nativeRuntime,
    memoryBytes: nativeRuntime.residentMemoryBytes ?? metric?.memoryBytes,
    memoryKind: nativeRuntime.memoryKind ?? metric?.memoryKind
  };
}

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
  const filtered = normalized ? values.filter((item) => String(item).toLowerCase().includes(normalized)) : values;

  return (
    <div className="facet-picker" ref={ref}>
      <button type="button" className={value ? 'facet-trigger active' : 'facet-trigger'} onClick={() => setOpen((current) => !current)} title={value || label}>
        {value || label}<span>⌄</span>
      </button>
      {open && (
        <div className="facet-menu">
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${label.toLowerCase()}…`} />
          <button type="button" className="facet-option all" onClick={() => { onChange(''); setOpen(false); }}>All {label.toLowerCase()}</button>
          <div className="facet-options">
            {filtered.map((item) => (
              <button type="button" className={value === item ? 'facet-option selected' : 'facet-option'} key={item} onClick={() => { onChange(item); setOpen(false); }}>
                {item}
              </button>
            ))}
            {!filtered.length && <div className="empty-mini">No matches</div>}
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

  const normalized = query.trim().toLowerCase();
  const filtered = normalized ? values.filter((name) => String(name).toLowerCase().includes(normalized)) : values;
  const toggle = (name) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name); else next.add(name);
    onChange(next);
  };

  return (
    <div className="facet-picker" ref={ref}>
      <button type="button" className={selected.size ? 'facet-trigger active' : 'facet-trigger'} onClick={() => setOpen((current) => !current)}>
        {selected.size ? `${selected.size} process` : 'Processes'}<span>⌄</span>
      </button>
      {open && (
        <div className="facet-menu process-popover">
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search processes…" />
          <button type="button" className="facet-option all" onClick={() => onChange(new Set())}>All processes</button>
          <div className="facet-options">
            {filtered.map((name) => (
              <label key={name} className="process-check">
                <input type="checkbox" checked={selected.has(name)} onChange={() => toggle(name)} />
                <span>{name}</span>
              </label>
            ))}
            {!filtered.length && <div className="empty-mini">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
});

const ProcessCard = memo(function ProcessCard({ item, onIsolate }) {
  const hasErrors = item.errors > 0;
  return (
    <button className={`process-card ${item.isMainApp ? 'main-app' : ''} ${hasErrors ? 'has-errors' : ''}`} onClick={() => onIsolate(item.process)}>
      <div className="process-card-top">
        <div className="process-name"><i className={item.isMainApp ? 'dot cyan' : hasErrors ? 'dot rose' : 'dot green'} />{item.process || 'Unknown'}</div>
        <span className="process-pid">{item.pid ? `PID ${item.pid}` : 'PID —'}</span>
      </div>
      <div className="process-card-metrics">
        <strong>{formatBytes(item.memoryBytes)}</strong>
        <span>{Number.isFinite(item.cpuPercent) ? `${item.cpuPercent.toFixed(1)}% CPU` : 'CPU —'}</span>
        {Number.isFinite(item.fps) && <span className="metric-accent">{item.fps.toFixed(0)} FPS</span>}
      </div>
      <div className="process-card-bottom">
        <span>{(item.total || 0).toLocaleString()} logs{item.errors ? ` · ${item.errors} errors` : ''}</span>
        <span className="isolate">Isolate →</span>
      </div>
    </button>
  );
});

function mergeProcessData(processMetrics, processStats, session, nativeRuntime) {
  const byName = new Map();

  for (const metric of processMetrics || []) {
    if (!metric?.process) continue;
    byName.set(metric.process, { ...metric, total: 0, errors: 0, warnings: 0, fatal: 0 });
  }
  for (const stat of processStats || []) {
    const current = byName.get(stat.process) || { process: stat.process };
    byName.set(stat.process, { ...current, ...stat });
  }

  const mainName = session?.app?.primaryProcess || '';
  if (mainName && !byName.has(mainName)) byName.set(mainName, { process: mainName, isMainApp: true, total: 0, errors: 0 });
  if (nativeRuntime?.process && !byName.has(nativeRuntime.process)) byName.set(nativeRuntime.process, { process: nativeRuntime.process, total: 0, errors: 0 });

  return [...byName.values()].map((item) => {
    const runtime = runtimeForProcess(nativeRuntime, item);
    return {
      ...item,
      ...(runtime || {}),
      memoryBytes: runtime?.residentMemoryBytes ?? runtime?.memoryBytes ?? item.memoryBytes,
      isMainApp: item.isMainApp || Boolean(mainName && item.process === mainName)
    };
  }).sort((a, b) =>
    Number(b.isMainApp) - Number(a.isMainApp) ||
    Number(b.errors || 0) - Number(a.errors || 0) ||
    Number(b.total || 0) - Number(a.total || 0) ||
    Number(b.cpuPercent || 0) - Number(a.cpuPercent || 0)
  );
}

const Header = memo(function Header({ connected, paused, onPause, onClear, onExport, session, mainProcess, logStats, query, setQuery, searchRef }) {
  const memory = mainProcess?.memoryBytes;
  return (
    <header className="workbench-header">
      <div className="brand-zone">
        <div className="brand-mark">RN</div>
        <div className="brand-name">native-debugger</div>
        <div className="version-pill">workbench</div>
        {mainProcess && (
          <div className="target-pill">
            <i className="dot green" />
            <strong>{mainProcess.process}</strong>
            <span>{mainProcess.pid ? `PID ${mainProcess.pid}` : ''}</span>
            {Number.isFinite(mainProcess.fps) && <b>{mainProcess.fps.toFixed(0)} FPS</b>}
          </div>
        )}
      </div>

      <div className="command-bar">
        <span className="command-icon">⌘</span>
        <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter logs…  is:error process:app subsystem:network pid:1234" />
        <kbd>⌘K</kbd>
      </div>

      <div className="header-actions">
        <a className="mcp-nav-link" href="/mcp">MCP</a>
        <div className="stream-pill">
          <span className={connected && !paused ? 'live-label' : 'paused-label'}>● {paused ? 'PAUSED' : connected ? 'LIVE' : 'OFFLINE'}</span>
          <span>·</span><strong>{logStats.logsPerSecond.toFixed(1)}/s</strong>
          {Number.isFinite(memory) && <><span>·</span><b>{formatBytes(memory)}</b></>}
        </div>
        <button className="icon-btn" onClick={onPause} title={paused ? 'Resume stream (Space)' : 'Pause stream (Space)'}>{paused ? '▶' : 'Ⅱ'}</button>
        <button className="icon-btn" onClick={onClear} title="Clear captured logs">⌫</button>
        <button className="export-btn" onClick={onExport}>⇧ Export</button>
      </div>
    </header>
  );
});

const ViewTabs = memo(function ViewTabs({ active, setActive, counts }) {
  const tabs = [
    ['stream', '[]', 'Unified Stream', counts.stream],
    ['processes', '▦', 'Process Matrix', counts.processes],
    ['anomalies', '!', 'Errors & Crashes', counts.anomalies],
    ['network', '◎', 'Network Inspector', counts.network]
  ];
  return (
    <nav className="view-tabs">
      <div className="tab-group">
        {tabs.map(([id, icon, label, count]) => (
          <button key={id} className={active === id ? 'view-tab active' : 'view-tab'} onClick={() => setActive(id)}>
            <span className="tab-icon">{icon}</span>{label}<b>{count.toLocaleString()}</b>
          </button>
        ))}
      </div>
      <div className="view-meta"><span>NATIVE + HOST TELEMETRY</span><i className="dot green" /></div>
    </nav>
  );
});

const FilterBar = memo(function FilterBar({ filters, setFilters, limit, setLimit, speed, setSpeed, matched, captured }) {
  useSyncExternalStore(logStore.subscribeFacets, logStore.getFacetRevision, logStore.getFacetRevision);
  const facets = logStore.getFacets();
  return (
    <div className="filter-bar">
      <ProcessPicker values={facets.processes} selected={filters.processes} onChange={(processes) => setFilters((current) => ({ ...current, processes }))} />
      <select value={filters.level} onChange={(event) => setFilters((current) => ({ ...current, level: event.target.value }))}>
        <option value="">All levels</option>
        {facets.levels.map((item) => <option key={item}>{item}</option>)}
      </select>
      <SearchableFacet label="Packages" values={facets.packages} value={filters.package} onChange={(value) => setFilters((current) => ({ ...current, package: value }))} />
      <SearchableFacet label="Services" values={facets.services} value={filters.service} onChange={(value) => setFilters((current) => ({ ...current, service: value }))} />
      <span className="filter-divider" />
      <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>{LIMITS.map((value) => <option key={value} value={value}>{value} rows</option>)}</select>
      <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>{SPEEDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <div className="filter-count"><strong>{matched.toLocaleString()}</strong> matched <span>/</span> {captured.toLocaleString()} captured</div>
    </div>
  );
});

const SeverityBadge = memo(function SeverityBadge({ level }) {
  return <span className={`severity ${level}`}>{String(level).toUpperCase()}</span>;
});

const StreamRow = memo(function StreamRow({ row, selected, onSelect }) {
  const level = levelName(row);
  return (
    <button className={`stream-row ${selected ? 'selected' : ''} ${level === 'error' || level === 'fatal' ? 'error-row' : ''}`} onClick={() => onSelect(row)}>
      <span className="cell time">{shortTime(row)}</span>
      <span className="cell severity-cell"><SeverityBadge level={level} /></span>
      <span className="cell process-cell"><b>{row.process || 'Unknown'}</b>{row.pid && <small>#{row.pid}</small>}</span>
      <span className="cell source-cell">{row.subsystem || sourceName(row)}</span>
      <span className="cell message-cell">{row.message || row.raw || ''}</span>
      <span className="cell evidence-cell">{row.network?.protocol || row.network?.errorCode || row.category || ''}</span>
    </button>
  );
});

function LogStream({ rows, selectedRow, onSelect, emptyText = 'No logs match the current filters.' }) {
  const parentRef = useRef(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 18,
    getItemKey: (index) => rows[index]?.id || index
  });

  return (
    <section className="stream-panel">
      <div className="stream-head">
        <span>Time</span><span>Level</span><span>Process / PID</span><span>Subsystem / Source</span><span>Message body / payload</span><span>Evidence</span>
      </div>
      {!rows.length ? <div className="empty-state">{emptyText}</div> : (
        <div ref={parentRef} className="stream-scroll">
          <div className="virtual-space" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <div className="virtual-row" key={item.key} data-index={item.index} ref={virtualizer.measureElement} style={{ transform: `translateY(${item.start}px)` }}>
                  <StreamRow row={row} selected={selectedRow?.id === row.id} onSelect={onSelect} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function ProcessMatrix({ rows, onIsolate }) {
  return (
    <section className="matrix-panel">
      <div className="matrix-head">
        <span>Process</span><span>PID</span><span>Memory</span><span>CPU</span><span>FPS</span><span>Threads</span><span>Logs</span><span>Errors</span><span>State</span><span />
      </div>
      <div className="matrix-scroll">
        {rows.map((row) => (
          <div className={`matrix-row ${row.isMainApp ? 'main' : ''}`} key={`${row.pid || 'none'}-${row.process}`}>
            <span className="matrix-process"><i className={row.isMainApp ? 'dot cyan' : row.errors ? 'dot rose' : 'dot muted'} /><strong>{row.process}</strong>{row.isMainApp && <em>MAIN APP</em>}</span>
            <span>{row.pid || '—'}</span>
            <span>{formatBytes(row.memoryBytes)}</span>
            <span>{Number.isFinite(row.cpuPercent) ? `${row.cpuPercent.toFixed(1)}%` : '—'}</span>
            <span>{Number.isFinite(row.fps) ? row.fps.toFixed(0) : '—'}</span>
            <span>{Number.isFinite(row.threads) ? row.threads : '—'}</span>
            <span>{(row.total || 0).toLocaleString()}</span>
            <span className={row.errors ? 'danger-text' : ''}>{row.errors || 0}</span>
            <span>{row.state || (row.thermalState ? `thermal:${row.thermalState}` : '—')}</span>
            <span><button className="row-action" onClick={() => onIsolate(row.process)}>Isolate</button></span>
          </div>
        ))}
        {!rows.length && <div className="empty-state">No process telemetry is available yet.</div>}
      </div>
    </section>
  );
}

function AnomaliesView({ groups, onSelect }) {
  return (
    <section className="anomaly-panel">
      <div className="section-title"><span>ERROR GROUPS & CRASH SIGNALS</span><small>Derived only from captured log evidence</small></div>
      <div className="anomaly-grid">
        {groups.map((group) => (
          <button className={`anomaly-card ${group.crash ? 'crash' : ''}`} key={group.signature} onClick={() => onSelect(group.latest)}>
            <div className="anomaly-top"><SeverityBadge level={group.level} /><span>{group.count}×</span>{group.crash && <b>CRASH SIGNAL</b>}</div>
            <strong>{group.process}</strong>
            <p>{group.latest.message || group.latest.raw}</p>
            <div><span>{sourceName(group.latest)}</span><span>{shortTime(group.latest)}</span></div>
          </button>
        ))}
        {!groups.length && <div className="empty-state">No error or crash evidence in the captured session.</div>}
      </div>
    </section>
  );
}

function NetworkView({ rows, selectedRow, onSelect }) {
  return (
    <section className="network-panel">
      <div className="network-summary">
        <div><span>NETWORK LOGS</span><strong>{rows.length.toLocaleString()}</strong></div>
        <div><span>ENDPOINTS SEEN</span><strong>{new Set(rows.map((row) => row.network?.endpoint).filter(Boolean)).size}</strong></div>
        <div><span>URLS SEEN</span><strong>{new Set(rows.map((row) => row.network?.url).filter(Boolean)).size}</strong></div>
        <div><span>NETWORK ERRORS</span><strong>{rows.filter((row) => levelName(row) === 'error' || row.network?.errorCode).length}</strong></div>
      </div>
      <LogStream rows={rows} selectedRow={selectedRow} onSelect={onSelect} emptyText="No network evidence is present in captured native logs." />
    </section>
  );
}

function MiniSparkline({ values }) {
  const data = (values || []).filter((value) => Number.isFinite(value));
  if (data.length < 2) return <div className="mini-spark empty" />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = Math.max(1, max - min);
  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * 100;
    const y = 22 - ((value - min) / range) * 18;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg className="mini-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function RuntimeMeter({ label, value, detail, ratio, tone = 'cyan', history = [] }) {
  const width = Number.isFinite(ratio) ? Math.max(0, Math.min(100, ratio * 100)) : 0;
  return (
    <div className="runtime-meter">
      <div><span>{label}</span><strong>{value}</strong></div>
      {detail && <small>{detail}</small>}
      <MiniSparkline values={history} />
      <div className="meter-track"><i className={tone} style={{ width: `${width}%` }} /></div>
    </div>
  );
}

function Inspector({ session, runtime, selectedRow, processRows, onQuickFilter, metricHistory }) {
  const device = session?.device || {};
  const app = session?.app || {};
  const totalMemory = runtime?.physicalMemoryBytes || device.totalMemoryBytes;
  const resident = runtime?.residentMemoryBytes || runtime?.memoryBytes;
  const memoryRatio = resident && totalMemory ? resident / totalMemory : null;
  const main = processRows.find((row) => row.isMainApp);
  const observedHermes = Boolean(main?.hermesObserved);
  const history = (metricHistory || []).filter((item) => !runtime?.process || item.process === runtime.process);
  const memoryHistory = history.map((item) => item.residentMemoryBytes ?? item.memoryBytes).filter(Number.isFinite);
  const cpuHistory = history.map((item) => item.cpuPercent).filter(Number.isFinite);
  const fpsHistory = history.map((item) => item.fps).filter(Number.isFinite);

  return (
    <aside className="inspector">
      <div className="inspector-title">ACTIVE INSPECTOR <span>▥</span></div>
      <div className="inspector-scroll">
        <section className="inspector-card target-info">
          <div><span>DEVICE</span><strong>{device.deviceName || '—'}</strong></div>
          <div><span>OS</span><strong>{[device.osVersion, device.architecture].filter(Boolean).join(' · ') || '—'}</strong></div>
          <div><span>APP</span><strong>{app.name || '—'}</strong></div>
          <div><span>BUNDLE</span><strong>{app.bundleId || '—'}</strong></div>
          <div><span>ENGINE</span><strong className={observedHermes ? 'purple-text' : ''}>{observedHermes ? 'Hermes observed' : 'Not inferred'}</strong></div>
          <div><span>LINK</span><strong className={session?.metro?.connected ? 'good-text' : ''}>{session?.metro?.connected ? `Metro ${session.metro.port}` : 'Metro not detected'}</strong></div>
        </section>

        <section>
          <div className="inspector-section-title">QUICK FILTER PRESETS</div>
          <div className="quick-filters">
            <button onClick={() => onQuickFilter('is:error')}><i className="dot rose" />Errors</button>
            <button onClick={() => onQuickFilter('network:true')}><i className="dot amber" />Network evidence</button>
            {app.primaryProcess && <button onClick={() => onQuickFilter(`process:${app.primaryProcess}`)}><i className="dot cyan" />Main app only</button>}
          </div>
        </section>

        <section>
          <div className="inspector-section-title">RESOURCE ALLOCATION</div>
          <div className="inspector-card">
            <RuntimeMeter label="RAM" value={formatBytes(resident)} detail={runtime?.memoryKind ? runtime.memoryKind.toUpperCase() : null} ratio={memoryRatio} history={memoryHistory} />
            <RuntimeMeter label="CPU" value={Number.isFinite(runtime?.cpuPercent) ? `${runtime.cpuPercent.toFixed(1)}%` : '—'} detail={runtime?.source || null} ratio={Number.isFinite(runtime?.cpuPercent) ? runtime.cpuPercent / 100 : null} tone="green" history={cpuHistory} />
            <RuntimeMeter label="FPS" value={Number.isFinite(runtime?.fps) ? runtime.fps.toFixed(0) : '—'} detail="native display callback" ratio={Number.isFinite(runtime?.fps) ? runtime.fps / 60 : null} tone="purple" history={fpsHistory} />
            <div className="runtime-grid">
              <span>Threads<strong>{runtime?.threads ?? '—'}</strong></span>
              <span>Thermal<strong>{runtime?.thermalState || '—'}</strong></span>
              <span>Battery<strong>{Number.isFinite(runtime?.batteryPercent) ? `${runtime.batteryPercent.toFixed(0)}%` : '—'}</strong></span>
              <span>Heap<strong>{formatBytes(runtime?.javaHeapUsedBytes || runtime?.nativeHeapAllocatedBytes)}</strong></span>
            </div>
            {(Number.isFinite(runtime?.rxBytes) || Number.isFinite(runtime?.txBytes)) && (
              <div className="network-bytes"><span>RX {formatBytes(runtime?.rxBytes)}</span><span>TX {formatBytes(runtime?.txBytes)}</span></div>
            )}
          </div>
        </section>

        {selectedRow && (
          <>
            {selectedRow.network && (
              <section>
                <div className="inspector-section-title">NETWORK EVIDENCE</div>
                <div className="inspector-card evidence-list">
                  {selectedRow.network.protocol && <div><span>Protocol</span><strong>{selectedRow.network.protocol}</strong></div>}
                  {selectedRow.network.tlsVersion && <div><span>TLS</span><strong>{selectedRow.network.tlsVersion}</strong></div>}
                  {selectedRow.network.endpoint && <div><span>Endpoint</span><strong>{selectedRow.network.endpoint}</strong></div>}
                  {selectedRow.network.errorCode && <div><span>Error</span><strong className="danger-text">{selectedRow.network.errorCode}</strong></div>}
                  {selectedRow.network.url && <div className="wide"><span>URL</span><strong>{selectedRow.network.url}</strong></div>}
                </div>
              </section>
            )}
            <section>
              <div className="inspector-section-title raw-title"><span>SELECTED RAW PAYLOAD</span><button onClick={() => navigator.clipboard.writeText(JSON.stringify(selectedRow, null, 2))}>COPY JSON</button></div>
              <pre className="raw-payload">{JSON.stringify(selectedRow, null, 2)}</pre>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}


function CopyBlock({ label, children }) {
  const [copied, setCopied] = useState(false);
  const textValue = typeof children === 'string' ? children : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(textValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  return (
    <div className="mcp-code-block">
      <div className="mcp-code-head"><span>{label}</span><button type="button" onClick={copy}>{copied ? 'COPIED' : 'COPY'}</button></div>
      <pre>{children}</pre>
    </div>
  );
}

function MCPPage() {
  const dashboardUrl = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:9876';
  const openCodeCommand = `opencode mcp add rn-native-debugger -- \\\n  npx rn-native-debugger mcp \\\n  --connect ${dashboardUrl}`;
  const openCodeGlobalCommand = `opencode mcp add rn-native-debugger --global -- \\\n  npx rn-native-debugger mcp \\\n  --connect ${dashboardUrl}`;
  const codexCommand = `codex mcp add rn-native-debugger -- \\\n  npx rn-native-debugger mcp \\\n  --connect ${dashboardUrl}`;
  const androidCommand = 'npx rn-native-debugger logs --platform android';
  const iosCommand = 'npx rn-native-debugger logs --ios-simulator';

  const tools = [
    ['native_debugger_status', 'App/device/session health, captured-log statistics and runtime telemetry.'],
    ['search_native_logs', 'Search the full captured session by severity, process, package, service, subsystem, tag and text.'],
    ['get_native_log_context', 'Reconstruct the chronological native log sequence around a stable log id.'],
    ['get_recent_native_errors', 'Group repeated native error/fatal/crash signals and return sample log ids.'],
    ['list_native_processes', 'Read observed processes with CPU/RAM metrics and captured-log activity.'],
    ['get_runtime_telemetry', 'Read measured memory, CPU, FPS, threads, thermal, battery and heap data when available.'],
    ['get_network_evidence', 'Read real CFNetwork / Network.framework / OkHttp / TLS / QUIC / socket evidence from native logs.']
  ];

  return (
    <div className="mcp-docs-page">
      <header className="mcp-docs-header">
        <a className="mcp-brand" href="/"><span className="brand-mark">RN</span><strong>native-debugger</strong></a>
        <nav><a href="/">Dashboard</a><a className="active" href="/mcp">MCP</a></nav>
        <div className="mcp-header-badge"><i className="dot green" /> LOCAL · STDIO · READ ONLY</div>
      </header>

      <main className="mcp-docs-shell">
        <section className="mcp-hero">
          <div className="mcp-eyebrow">MODEL CONTEXT PROTOCOL</div>
          <h1>Let your coding agent inspect the same native evidence you see.</h1>
          <p>
            Connect OpenCode, Codex, or another MCP client to the active React Native Native Debugger session.
            The model can search captured native logs, inspect exact failure context, correlate process telemetry,
            and reason from real Android/iOS evidence without starting another collector.
          </p>
          <div className="mcp-hero-actions">
            <a href="#quick-start">Quick start</a>
            <a className="secondary" href="#tools">Explore tools</a>
          </div>
        </section>

        <section className="mcp-flow">
          <div><b>01</b><strong>Native runtime</strong><span>adb logcat / Unified Logging</span></div>
          <i>→</i>
          <div><b>02</b><strong>Debugger session</strong><span>Dashboard + server-side history</span></div>
          <i>→</i>
          <div><b>03</b><strong>MCP adapter</strong><span>Local stdio process</span></div>
          <i>→</i>
          <div><b>04</b><strong>Coding agent</strong><span>Evidence-first diagnosis</span></div>
        </section>

        <section className="mcp-section" id="quick-start">
          <div className="mcp-section-heading">
            <span>01</span>
            <div><h2>Start the debugger session</h2><p>The MCP adapter connects to an already-running native log session.</p></div>
          </div>
          <div className="mcp-grid two">
            <CopyBlock label="ANDROID">{androidCommand}</CopyBlock>
            <CopyBlock label="IOS SIMULATOR">{iosCommand}</CopyBlock>
          </div>
          <div className="mcp-callout">
            <i className="dot cyan" />
            <div>
              <strong>Keep this process running.</strong>
              <span>Default local session endpoint: <code>{dashboardUrl}</code></span>
            </div>
          </div>
        </section>

        <section className="mcp-section">
          <div className="mcp-section-heading">
            <span>02</span>
            <div><h2>Connect OpenCode</h2><p>Add the local stdio server from your React Native project.</p></div>
          </div>
          <CopyBlock label="OPENCODE · PROJECT">{openCodeCommand}</CopyBlock>
          <div className="mcp-grid two compact">
            <CopyBlock label="VERIFY">{'opencode mcp list'}</CopyBlock>
            <CopyBlock label="GLOBAL">{openCodeGlobalCommand}</CopyBlock>
          </div>
          <div className="mcp-example-prompt">
            <span>EXAMPLE PROMPT</span>
            <p>Use rn-native-debugger to inspect my current React Native app. Find the most important native errors, inspect their surrounding log context, and correlate them with CPU/RAM/FPS and network evidence.</p>
          </div>
        </section>

        <section className="mcp-section">
          <div className="mcp-section-heading">
            <span>03</span>
            <div><h2>Connect Codex CLI</h2><p>Codex launches the same local MCP adapter as a stdio child process.</p></div>
          </div>
          <CopyBlock label="CODEX CLI">{codexCommand}</CopyBlock>
          <div className="mcp-grid two compact">
            <CopyBlock label="VERIFY">{'codex mcp list'}</CopyBlock>
            <CopyBlock label="CODEX TUI">{'/mcp'}</CopyBlock>
          </div>
          <div className="mcp-example-prompt">
            <span>EXAMPLE PROMPT</span>
            <p>Use the rn-native-debugger MCP tools to diagnose why the latest upload failed. Start with app-scoped errors, inspect surrounding native log context, then expand to system/network processes only when the evidence points there.</p>
          </div>
        </section>

        <section className="mcp-section" id="tools">
          <div className="mcp-section-heading">
            <span>04</span>
            <div><h2>Available MCP tools</h2><p>All tools are read-only and operate on captured evidence or measured telemetry.</p></div>
          </div>
          <div className="mcp-tool-grid">
            {tools.map(([name, description]) => (
              <article key={name} className="mcp-tool-card">
                <code>{name}</code>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mcp-section">
          <div className="mcp-section-heading">
            <span>05</span>
            <div><h2>How diagnosis should work</h2><p>The MCP server is deliberately evidence-first.</p></div>
          </div>
          <div className="mcp-diagnosis-flow">
            {['status', 'error groups', 'exact log context', 'source/process search', 'network evidence', 'runtime telemetry', 'facts vs inference', 'fix actions'].map((item, index) => (
              <React.Fragment key={item}>
                <span>{item}</span>{index < 7 && <i>→</i>}
              </React.Fragment>
            ))}
          </div>
          <div className="mcp-safety-grid">
            <article><strong>APP SCOPE FIRST</strong><p>Log/error searches start with the detected React Native app. Expand to all processes only for daemon, permission, OS, or network correlation.</p></article>
            <article><strong>STABLE LOG IDS</strong><p>Search results can be reopened with chronological context so the model can inspect what happened before and after a failure.</p></article>
            <article><strong>NO SYNTHETIC EVIDENCE</strong><p>Missing stack frames, package attribution, HTTP details, telemetry, or root causes are never fabricated by the server.</p></article>
            <article><strong>LOCAL BY DEFAULT</strong><p>The dashboard stays on loopback and MCP uses local stdio. No remote AI service is embedded in the release app.</p></article>
          </div>
        </section>

        <section className="mcp-section">
          <div className="mcp-section-heading">
            <span>06</span>
            <div><h2>MCP resources</h2><p>Clients that consume resources can attach live debugger context directly.</p></div>
          </div>
          <div className="mcp-resource-list">
            <code>rnnd://session</code>
            <code>rnnd://errors/recent</code>
            <code>rnnd://runtime/main</code>
          </div>
        </section>
      </main>
    </div>
  );
}

function DashboardApp() {
  const logRevision = useSyncExternalStore(logStore.subscribeLogs, logStore.getLogRevision, logStore.getLogRevision);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [activeView, setActiveView] = useState('stream');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({ processes: new Set(), level: '', package: '', service: '' });
  const [limit, setLimit] = useState(250);
  const [speed, setSpeedState] = useState(250);
  const [session, setSession] = useState(null);
  const [processMetrics, setProcessMetrics] = useState([]);
  const [selectedMetric, setSelectedMetric] = useState(null);
  const [nativeRuntime, setNativeRuntime] = useState(null);
  const [metricHistory, setMetricHistory] = useState([]);
  const [selectedRow, setSelectedRow] = useState(null);
  const searchRef = useRef(null);

  useEffect(() => {
    logStore.setRenderInterval(250);
    const source = new EventSource('/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => {
      const value = JSON.parse(event.data);
      if (value.kind === 'runtime-telemetry' && value.telemetry) {
        const sample = {
          ...value.telemetry,
          process: value.telemetry.process || value.process,
          pid: value.telemetry.pid || value.pid
        };
        setNativeRuntime(sample);
        setMetricHistory((current) => [...current, sample].slice(-180));
        return;
      }
      logStore.push(value);
    };
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
    const timer = setInterval(refresh, 4000);
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
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch('/process-metrics', { cache: 'no-store' });
        if (!response.ok || cancelled) return;
        const value = await response.json();
        if (!cancelled && Array.isArray(value)) setProcessMetrics(value);
      } catch {}
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const selectedProcesses = useMemo(() => [...filters.processes], [filters.processes]);
  const focusProcess = selectedProcesses.length === 1
    ? selectedProcesses[0]
    : session?.app?.primaryProcess || '';

  useEffect(() => {
    if (!focusProcess) {
      setSelectedMetric(null);
      return undefined;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(`/metrics?process=${encodeURIComponent(focusProcess)}`, { cache: 'no-store' });
        if (!response.ok || cancelled) return;
        const value = await response.json();
        if (!cancelled) {
          setSelectedMetric(value);
          if (value?.available) setMetricHistory((current) => [...current, value].slice(-180));
        }
      } catch {}
    };
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [focusProcess]);

  useEffect(() => {
    const onKey = (event) => {
      const editable = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (editable) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (paused) logStore.resume(); else logStore.pause();
        setPaused((current) => !current);
      } else if (event.key.toLowerCase() === 'c') {
        logStore.clear();
        setSelectedRow(null);
        fetch('/api/clear', { method: 'POST' }).catch(() => {});
      } else if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paused]);

  const activeRows = logStore.getActiveData();
  const processStats = logStore.getProcessStats();
  const logStats = logStore.getStats();

  const filtered = useMemo(() => {
    const rows = [];
    let matched = 0;
    for (const row of activeRows) {
      if (!facetMatches(row, filters) || !queryMatches(row, query)) continue;
      matched += 1;
      if (rows.length < limit) rows.push(row);
    }
    return { rows, matched };
  }, [activeRows, filters, query, limit, logRevision]);

  const networkRows = useMemo(
    () => activeRows.filter((row) => isNetworkEvent(row) && facetMatches(row, filters) && queryMatches(row, query)),
    [activeRows, filters, query, logRevision]
  );
  const errorRows = useMemo(
    () => activeRows.filter((row) => (['error', 'fatal'].includes(levelName(row)) || isCrashEvent(row)) && facetMatches(row, filters) && queryMatches(row, query)),
    [activeRows, filters, query, logRevision]
  );

  const anomalyGroups = useMemo(() => {
    const groups = new Map();
    for (const row of errorRows) {
      const signature = anomalySignature(row);
      const current = groups.get(signature) || {
        signature,
        level: levelName(row),
        process: row.process || 'Unknown',
        count: 0,
        crash: false,
        latest: row
      };
      current.count += 1;
      current.crash = current.crash || isCrashEvent(row);
      if (Number(row.receivedAt || 0) > Number(current.latest.receivedAt || 0)) current.latest = row;
      groups.set(signature, current);
    }
    return [...groups.values()].sort((a, b) => Number(b.crash) - Number(a.crash) || b.count - a.count).slice(0, 100);
  }, [errorRows]);

  const processRows = useMemo(() => {
    const merged = mergeProcessData(processMetrics, processStats, session, nativeRuntime);
    const hermesProcesses = new Set(activeRows.filter((row) => /hermes/i.test(eventHaystack(row))).map((row) => row.process).filter(Boolean));
    return merged.map((row) => ({ ...row, hermesObserved: hermesProcesses.has(row.process) }));
  }, [processMetrics, processStats, session, nativeRuntime, activeRows, logRevision]);

  const mainProcess = processRows.find((row) => row.isMainApp) || processRows[0] || null;
  const fallbackMetric = selectedMetric?.available ? selectedMetric : mainProcess;
  const activeRuntime = runtimeForProcess(nativeRuntime, fallbackMetric) || fallbackMetric || {};

  const isolateProcess = (process) => {
    if (!process) return;
    setFilters((current) => ({ ...current, processes: new Set([process]) }));
    setQuery('');
    setActiveView('stream');
  };

  const togglePause = () => {
    if (paused) logStore.resume(); else logStore.pause();
    setPaused((current) => !current);
  };

  const clear = () => {
    logStore.clear();
    setSelectedRow(null);
    fetch('/api/clear', { method: 'POST' }).catch(() => {});
  };

  const exportRows = () => {
    const rows = activeView === 'network' ? networkRows : activeView === 'anomalies' ? errorRows : filtered.rows;
    download(rows, 'ndjson', activeView);
  };

  const setSpeed = (value) => {
    setSpeedState(value);
    logStore.setRenderInterval(value);
  };

  const quickFilter = (value) => {
    setQuery(value);
    setActiveView(value === 'network:true' ? 'network' : 'stream');
  };

  return (
    <div className="workbench">
      <Header connected={connected} paused={paused} onPause={togglePause} onClear={clear} onExport={exportRows} session={session} mainProcess={mainProcess} logStats={logStats} query={query} setQuery={setQuery} searchRef={searchRef} />
      <ViewTabs active={activeView} setActive={setActiveView} counts={{ stream: activeRows.length, processes: processRows.length, anomalies: anomalyGroups.length, network: networkRows.length }} />

      <section className="process-deck">
        <div className="process-cards">
          {processRows.slice(0, 4).map((item) => <ProcessCard key={`${item.pid || 'none'}-${item.process}`} item={item} onIsolate={isolateProcess} />)}
          {!processRows.length && <div className="deck-empty">Waiting for process telemetry…</div>}
        </div>
      </section>

      <FilterBar filters={filters} setFilters={setFilters} limit={limit} setLimit={setLimit} speed={speed} setSpeed={setSpeed} matched={filtered.matched} captured={activeRows.length} />

      <main className="main-workspace">
        <div className="content-pane">
          {activeView === 'stream' && <LogStream rows={filtered.rows} selectedRow={selectedRow} onSelect={setSelectedRow} />}
          {activeView === 'processes' && <ProcessMatrix rows={processRows} onIsolate={isolateProcess} />}
          {activeView === 'anomalies' && <AnomaliesView groups={anomalyGroups} onSelect={setSelectedRow} />}
          {activeView === 'network' && <NetworkView rows={networkRows.slice(0, 5000)} selectedRow={selectedRow} onSelect={setSelectedRow} />}
        </div>
        <Inspector session={session} runtime={activeRuntime} selectedRow={selectedRow} processRows={processRows} onQuickFilter={quickFilter} metricHistory={metricHistory} />
      </main>

      <footer className="status-bar">
        <div><kbd>Space</kbd> Pause <kbd>⌘K</kbd> Command filter <kbd>C</kbd> Clear <kbd>/</kbd> Focus search</div>
        <div><span>Ingest</span><strong>{logStats.logsPerSecond.toFixed(1)}/s</strong><span>Render</span><strong>{speed === 80 ? 'Realtime' : `${speed}ms`}</strong><span>Auto retention</span><strong>OFF</strong></div>
      </footer>
    </div>
  );
}


export default function App() {
  const path = typeof window !== 'undefined' ? window.location.pathname.replace(/\/+$/, '') || '/' : '/';
  if (path === '/mcp') return <MCPPage />;
  return <DashboardApp />;
}
