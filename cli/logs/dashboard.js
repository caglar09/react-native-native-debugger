'use strict';

const http = require('http');
const { execFile } = require('child_process');

const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RN Native Debugger</title><style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:dark;background:#0b0f14;color:#e8eef7}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#0b0f14,#0f141c 30%,#0b0f14)}header{position:sticky;top:0;z-index:5;background:rgba(10,14,20,.95);backdrop-filter:blur(14px);border-bottom:1px solid #202936;padding:14px 16px}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.brand{font-weight:700;margin-right:6px}.live{color:#61e294}.paused{color:#ffcc66}.badge{font-size:12px;padding:4px 8px;border:1px solid #334155;border-radius:999px;color:#aeb9c9;background:#111827}.filters{display:grid;grid-template-columns:140px 180px 220px 120px 150px minmax(220px,1fr);gap:8px;margin-top:10px}input,select,button{background:#111827;color:#e8eef7;border:1px solid #2b3646;border-radius:8px;padding:8px 10px;font:inherit}button{cursor:pointer}button:hover:not(:disabled){background:#172033}button:disabled{opacity:.42;cursor:not-allowed}.danger{color:#ff8f8f}.logs{padding:10px 14px 28px}.log{display:grid;grid-template-columns:28px 106px 78px 220px minmax(0,1fr) auto;gap:10px;align-items:start;border:1px solid #1c2633;background:#0f1620;border-radius:10px;padding:8px 10px;margin:7px 0;box-shadow:0 1px 2px rgba(0,0,0,.18)}.log:hover{border-color:#314156}.pick{display:flex;align-items:center;justify-content:center;padding-top:2px}.pick input{width:16px;height:16px;min-width:0;margin:0}.time,.meta{color:#7f8ca0;font-size:12px}.source{font-weight:600}.service{font-size:11px;color:#91a0b5;margin-top:2px}.message{white-space:pre-wrap;word-break:break-word;line-height:1.38}.debug{border-left:3px solid #6c8cff}.info,.default{border-left:3px solid #4fb7ff}.warn{border-left:3px solid #f2c14e}.error,.fatal{border-left:3px solid #ff6b6b}.actions{display:flex;gap:6px}.actions button{padding:5px 8px;font-size:12px}.details{grid-column:1/-1;margin-top:4px;padding:8px 10px;border-radius:8px;background:#0b1119;border:1px solid #1b2634;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#9fb0c4;display:none}.log.expanded .details{display:block}.empty{padding:40px 16px;text-align:center;color:#7f8ca0}.stats{display:flex;gap:8px;align-items:center;margin-left:auto}.export-menu{display:flex;gap:6px}.hint{font-size:11px;color:#7f8ca0;margin-top:8px}@media(max-width:1100px){.filters{grid-template-columns:1fr 1fr 1fr}.log{grid-template-columns:28px 1fr}.actions{justify-content:flex-start}.time{display:none}.stats{margin-left:0;width:100%}}
</style></head><body><header><div class="toolbar"><span class="brand">RN Native Debugger</span><span id="status" class="live">● LIVE</span><span id="count" class="badge">0 visible</span><span id="bufferCount" class="badge">0 buffered</span><span id="selectedCount" class="badge">0 selected</span><div class="stats"><button id="pause">Pause</button><button id="clear" class="danger">Clear</button><div class="export-menu"><button id="exportJson" disabled>Export JSON</button><button id="exportNdjson" disabled>Export NDJSON</button><button id="exportSelected" disabled>Export Selected</button></div></div></div><div class="filters"><select id="level"><option value="">All levels</option></select><select id="source"><option value="">All packages</option></select><select id="service"><option value="">All services</option></select><select id="limit"><option>10</option><option>20</option><option>50</option><option selected>100</option><option>500</option><option>1000</option><option>5000</option></select><select id="speed"><option value="80">Realtime</option><option value="250">250 ms</option><option value="500">500 ms</option><option value="1000">1 second</option><option value="2000">2 seconds</option></select><input id="search" placeholder="Search message, class, file, subsystem, package…"></div><div class="hint">Logs are always captured at full speed. Render speed only controls how often the UI refreshes. Pause freezes a snapshot for export; Resume jumps directly to the newest buffered logs.</div></header><main id="logs" class="logs"></main><script>
const logsEl=document.querySelector('#logs'),searchEl=document.querySelector('#search'),levelEl=document.querySelector('#level'),sourceEl=document.querySelector('#source'),serviceEl=document.querySelector('#service'),limitEl=document.querySelector('#limit'),speedEl=document.querySelector('#speed'),countEl=document.querySelector('#count'),bufferCountEl=document.querySelector('#bufferCount'),selectedCountEl=document.querySelector('#selectedCount'),statusEl=document.querySelector('#status'),pauseBtn=document.querySelector('#pause'),exportJsonBtn=document.querySelector('#exportJson'),exportNdjsonBtn=document.querySelector('#exportNdjson'),exportSelectedBtn=document.querySelector('#exportSelected');
const MAX_BUFFER=5000;let paused=false,buffer=[],pausedSnapshot=null,renderTimer=null,facetsDirty=true;const selectedIds=new Set();
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]))}
function sourceName(e){return e.package||e.integration||e.process||e.subsystem||e.tag||'Unknown'}function serviceName(e){return e.service||e.subsystem||e.category||e.tag||'Unknown'}function levelName(e){return e.level||'default'}
function activeData(){return paused&&pausedSnapshot?pausedSnapshot:buffer}
function matches(e){const q=searchEl.value.trim().toLowerCase();if(levelEl.value&&levelName(e)!==levelEl.value)return false;if(sourceEl.value&&sourceName(e)!==sourceEl.value)return false;if(serviceEl.value&&serviceName(e)!==serviceEl.value)return false;if(!q)return true;return JSON.stringify(e).toLowerCase().includes(q)}
function filteredAll(){return activeData().filter(matches)}function filtered(){return filteredAll().slice(0,Number(limitEl.value||100))}
function setOptions(el,values,label){const selected=el.value;const list=[...values].filter(Boolean).sort((a,b)=>String(a).localeCompare(String(b)));el.innerHTML='<option value="">'+label+'</option>'+list.map(v=>'<option>'+esc(v)+'</option>').join('');if(list.includes(selected))el.value=selected}
function refreshFacets(){const data=activeData();setOptions(levelEl,new Set(data.map(levelName)),'All levels');setOptions(sourceEl,new Set(data.map(sourceName)),'All packages');setOptions(serviceEl,new Set(data.map(serviceName)),'All services');facetsDirty=false}
function detailObject(e){const out={...e};delete out.id;return out}
function pruneSelection(){const ids=new Set(activeData().map(e=>e.id));for(const id of selectedIds)if(!ids.has(id))selectedIds.delete(id)}
function updateControls(){selectedCountEl.textContent=selectedIds.size+' selected';exportJsonBtn.disabled=!paused;exportNdjsonBtn.disabled=!paused;exportSelectedBtn.disabled=!paused||selectedIds.size===0}
function render(){if(facetsDirty)refreshFacets();pruneSelection();const items=filtered();countEl.textContent=items.length+' visible';bufferCountEl.textContent=(paused&&pausedSnapshot?pausedSnapshot.length:buffer.length)+' buffered';updateControls();if(!items.length){logsEl.innerHTML='<div class="empty">No logs match the current filters.</div>';return}const frag=document.createDocumentFragment();for(const e of items){const row=document.createElement('article');row.className='log '+esc(levelName(e));row.dataset.id=e.id||'';const location=[e.className,e.method,e.file&&e.line?e.file+':'+e.line:e.file].filter(Boolean).join(' · ');const checked=e.id&&selectedIds.has(e.id)?' checked':'';row.innerHTML='<label class="pick"><input type="checkbox" data-select'+checked+'></label><div class="time">'+esc(e.timestamp||new Date(e.receivedAt||Date.now()).toLocaleTimeString())+'</div><div>'+esc(levelName(e))+'</div><div><div class="source">'+esc(sourceName(e))+'</div><div class="service">'+esc(serviceName(e))+(e.packageConfidence?' · '+esc(e.packageConfidence):'')+'</div></div><div><div class="message">'+esc(e.message||e.raw||'')+'</div><div class="meta">'+esc([e.process&&'process='+e.process,e.pid&&'pid='+e.pid,e.tid&&'tid='+e.tid,e.subsystem&&'subsystem='+e.subsystem,e.category&&'category='+e.category,location].filter(Boolean).join(' · '))+'</div></div><div class="actions"><button data-copy>Copy</button><button data-toggle>Details</button></div><pre class="details">'+esc(JSON.stringify(detailObject(e),null,2))+'</pre>';const select=row.querySelector('[data-select]');select.onchange=()=>{if(!e.id)return;if(select.checked)selectedIds.add(e.id);else selectedIds.delete(e.id);updateControls()};row.querySelector('[data-copy]').onclick=async()=>{await navigator.clipboard.writeText(JSON.stringify(e,null,2));row.querySelector('[data-copy]').textContent='Copied';setTimeout(()=>row.querySelector('[data-copy]').textContent='Copy',900)};row.querySelector('[data-toggle]').onclick=()=>row.classList.toggle('expanded');frag.appendChild(row)}logsEl.replaceChildren(frag)}
function scheduleRender(immediate=false){if(paused)return;if(renderTimer){if(!immediate)return;clearTimeout(renderTimer);renderTimer=null}if(immediate){render();return}renderTimer=setTimeout(()=>{renderTimer=null;render()},Number(speedEl.value||80))}
function receive(e){buffer.unshift(e);if(buffer.length>MAX_BUFFER)buffer.length=MAX_BUFFER;facetsDirty=true;scheduleRender()}
function download(data,format,suffix){const body=format==='ndjson'?data.map(x=>JSON.stringify(x)).join(String.fromCharCode(10)):JSON.stringify(data,null,2);const blob=new Blob([body],{type:format==='ndjson'?'application/x-ndjson':'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='rn-native-debugger-'+suffix+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'.'+(format==='ndjson'?'ndjson':'json');a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500)}
function exportFiltered(format){if(!paused)return;download(filtered(),format,'filtered')}
function exportSelected(){if(!paused)return;const data=activeData().filter(e=>e.id&&selectedIds.has(e.id));download(data,'json','selected')}
const es=new EventSource('/events');es.onopen=()=>{if(!paused){statusEl.textContent='● LIVE';statusEl.className='live'}};es.onmessage=x=>receive(JSON.parse(x.data));es.onerror=()=>{statusEl.textContent='● DISCONNECTED';statusEl.className='paused'};
for(const el of [searchEl,levelEl,sourceEl,serviceEl,limitEl])el.addEventListener(el===searchEl?'input':'change',render);speedEl.onchange=()=>scheduleRender(true);
pauseBtn.onclick=()=>{paused=!paused;if(paused){if(renderTimer){clearTimeout(renderTimer);renderTimer=null}pausedSnapshot=buffer.slice();facetsDirty=true;statusEl.textContent='● PAUSED';statusEl.className='paused';pauseBtn.textContent='Resume';render()}else{pausedSnapshot=null;facetsDirty=true;statusEl.textContent='● LIVE';statusEl.className='live';pauseBtn.textContent='Pause';scheduleRender(true)}updateControls()};
document.querySelector('#clear').onclick=()=>{buffer=[];pausedSnapshot=paused?[]:null;selectedIds.clear();facetsDirty=true;if(renderTimer){clearTimeout(renderTimer);renderTimer=null}render()};exportJsonBtn.onclick=()=>exportFiltered('json');exportNdjsonBtn.onclick=()=>exportFiltered('ndjson');exportSelectedBtn.onclick=exportSelected;
refreshFacets();render();
</script></body></html>`;

function openBrowser(url) {
  if (process.platform === 'darwin') execFile('open', [url], () => {});
  else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
  else execFile('xdg-open', [url], () => {});
}

function startDashboard({ host = '127.0.0.1', port = 9876, open = true } = {}) {
  const clients = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(HTML); }
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    res.writeHead(404); res.end('Not found');
  });
  function publish(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(payload);
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : port;
      const url = `http://${host}:${actualPort}`;
      if (open) openBrowser(url);
      resolve({ url, publish, close: () => new Promise(r => server.close(r)) });
    });
  });
}

module.exports = { startDashboard, openBrowser, HTML };
