import React, { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { levelName, logStore, serviceName, sourceName } from './store';

const LIMITS = [10, 20, 50, 100, 500, 1000, 5000];
const SPEEDS = [
  [80, 'Realtime'],
  [250, '250 ms'],
  [500, '500 ms'],
  [1000, '1 second'],
  [2000, '2 seconds']
];

function matches(event, filters) {
  if (filters.processes.size && !filters.processes.has(event.process || '')) return false;
  if (filters.level && levelName(event) !== filters.level) return false;
  if (filters.package && sourceName(event) !== filters.package) return false;
  if (filters.service && serviceName(event) !== filters.service) return false;
  if (!filters.search) return true;
  return JSON.stringify(event).toLowerCase().includes(filters.search.toLowerCase());
}

function download(data, format, suffix) {
  const body = format === 'ndjson'
    ? data.map((item) => JSON.stringify(item)).join('\n')
    : JSON.stringify(data, null, 2);
  const blob = new Blob([body], { type: format === 'ndjson' ? 'application/x-ndjson' : 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `rn-native-debugger-${suffix}-${new Date().toISOString().replace(/[:.]/g, '-')}.${format === 'ndjson' ? 'ndjson' : 'json'}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

const FacetSelect = memo(function FacetSelect({ value, onChange, label, values }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{label}</option>
      {values.map((item) => <option key={item} value={item}>{item}</option>)}
    </select>
  );
});

const ProcessPicker = memo(function ProcessPicker({ values, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (name) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange(next);
  };

  return (
    <div className="process-picker" ref={ref}>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        {selected.size ? `${selected.size} process${selected.size === 1 ? '' : 'es'}` : 'All processes'}
      </button>
      {open && (
        <div className="process-menu">
          <div className="process-menu-head">
            <strong>Running / observed processes</strong>
            <button type="button" onClick={() => onChange(new Set())}>All</button>
          </div>
          {!values.length && <div className="process-empty">No process information available yet.</div>}
          {values.map((name) => (
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

const Toolbar = memo(function Toolbar({
  connected,
  paused,
  onPause,
  onClear,
  filters,
  setFilters,
  limit,
  setLimit,
  speed,
  setSpeed,
  visibleCount,
  bufferedCount,
  selectedCount,
  selectedIds,
  filteredRows,
  activeRows
}) {
  useSyncExternalStore(logStore.subscribeFacets, logStore.getFacetRevision, logStore.getFacetRevision);
  const facets = logStore.getFacets();

  return (
    <header>
      <div className="toolbar">
        <span className="brand">RN Native Debugger</span>
        <span className={paused || !connected ? 'status paused' : 'status live'}>● {paused ? 'PAUSED' : connected ? 'LIVE' : 'DISCONNECTED'}</span>
        <span className="badge">{visibleCount} visible</span>
        <span className="badge">{bufferedCount} buffered</span>
        <span className="badge">{selectedCount} selected</span>
        <div className="stats">
          <button onClick={onPause}>{paused ? 'Resume' : 'Pause'}</button>
          <button className="danger" onClick={onClear}>Clear</button>
          <button disabled={!paused} onClick={() => download(filteredRows, 'json', 'filtered')}>Export JSON</button>
          <button disabled={!paused} onClick={() => download(filteredRows, 'ndjson', 'filtered')}>Export NDJSON</button>
          <button disabled={!paused || !selectedCount} onClick={() => download(activeRows.filter((row) => selectedIds.has(row.id)), 'json', 'selected')}>Export Selected</button>
        </div>
      </div>
      <div className="filters">
        <ProcessPicker values={facets.processes} selected={filters.processes} onChange={(processes) => setFilters((current) => ({ ...current, processes }))} />
        <FacetSelect label="All levels" values={facets.levels} value={filters.level} onChange={(level) => setFilters((current) => ({ ...current, level }))} />
        <FacetSelect label="All packages" values={facets.packages} value={filters.package} onChange={(pkg) => setFilters((current) => ({ ...current, package: pkg }))} />
        <FacetSelect label="All services" values={facets.services} value={filters.service} onChange={(service) => setFilters((current) => ({ ...current, service }))} />
        <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
          {LIMITS.map((value) => <option key={value} value={value}>{value} logs</option>)}
        </select>
        <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
          {SPEEDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Search message, class, file, subsystem, package…" />
      </div>
      <div className="hint">Toolbar facets only update when a new facet appears; high-frequency log updates are isolated to the virtualized list.</div>
    </header>
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
      <div>{level}</div>
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
    estimateSize: () => 84,
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

export default function App() {
  const logRevision = useSyncExternalStore(logStore.subscribeLogs, logStore.getLogRevision, logStore.getLogRevision);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filters, setFilters] = useState({ processes: new Set(), level: '', package: '', service: '', search: '' });
  const [limit, setLimit] = useState(100);
  const [speed, setSpeedState] = useState(80);
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  useEffect(() => {
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

  const activeRows = logStore.getActiveData();
  const filteredRows = useMemo(() => activeRows.filter((row) => matches(row, filters)).slice(0, limit), [activeRows, filters, limit, logRevision]);

  const setSpeed = (value) => {
    setSpeedState(value);
    logStore.setRenderInterval(value);
  };

  const togglePause = () => {
    if (paused) logStore.resume();
    else logStore.pause();
    setPaused((value) => !value);
  };

  const clear = () => {
    logStore.clear();
    setSelectedIds(new Set());
  };

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
      <Toolbar connected={connected} paused={paused} onPause={togglePause} onClear={clear} filters={filters} setFilters={setFilters} limit={limit} setLimit={setLimit} speed={speed} setSpeed={setSpeed} visibleCount={filteredRows.length} bufferedCount={activeRows.length} selectedCount={selectedIds.size} selectedIds={selectedIds} filteredRows={filteredRows} activeRows={activeRows} />
      <LogList rows={filteredRows} selectedIds={selectedIds} onSelect={onSelect} />
    </div>
  );
}
