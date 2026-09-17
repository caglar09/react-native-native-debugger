'use strict';

const http = require('http');
const { execFile } = require('child_process');

const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RN Native Debugger</title><style>
:root{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color-scheme:dark;background:#101216;color:#e8eaf0}*{box-sizing:border-box}body{margin:0}header{position:sticky;top:0;background:#151820;border-bottom:1px solid #2a2f3a;padding:12px;z-index:2}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}input,select,button{background:#1d222c;color:#e8eaf0;border:1px solid #343b49;border-radius:6px;padding:7px 9px}input{min-width:260px;flex:1}.live{color:#5ee28a}.paused{color:#ffcc66}#logs{padding:8px 12px}.log{display:grid;grid-template-columns:110px 70px 180px 1fr;gap:8px;border-bottom:1px solid #1c212a;padding:4px 0;white-space:pre-wrap;word-break:break-word}.error,.fatal{color:#ff8080}.warn{color:#ffd479}.debug{color:#9fb6ff}.meta{color:#8892a4}.badge{font-size:12px;padding:3px 6px;border:1px solid #394151;border-radius:999px}@media(max-width:800px){.log{grid-template-columns:1fr}.meta{display:none}}
</style></head><body><header><div class="row"><strong>Native Logs</strong><span id="status" class="live">● LIVE</span><span id="count" class="badge">0</span><select id="level"><option value="">All levels</option><option>debug</option><option>info</option><option>warn</option><option>error</option><option>fatal</option></select><input id="search" placeholder="Filter tag, process, message…"><button id="pause">Pause</button><button id="clear">Clear</button><label><input id="scroll" type="checkbox" checked> auto-scroll</label></div></header><main id="logs"></main><script>
const logs=document.querySelector('#logs'),search=document.querySelector('#search'),level=document.querySelector('#level'),count=document.querySelector('#count'),status=document.querySelector('#status');let paused=false,n=0;const pending=[];
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function matches(e){const q=search.value.toLowerCase();return(!level.value||e.level===level.value)&&(!q||JSON.stringify(e).toLowerCase().includes(q))}function add(e){if(!matches(e))return;const el=document.createElement('div');el.className='log '+esc(e.level);el.dataset.payload=JSON.stringify(e);el.innerHTML='<span class="meta">'+esc(e.timestamp||'')+'</span><span>'+esc(e.level||'')+'</span><span>'+esc(e.tag||e.process||e.subsystem||'')+'</span><span>'+esc(e.message||e.raw||'')+'</span>';logs.append(el);n++;count.textContent=n;if(logs.children.length>5000)logs.firstElementChild.remove();if(document.querySelector('#scroll').checked)window.scrollTo(0,document.body.scrollHeight)}function redraw(){const items=[...logs.children].map(x=>JSON.parse(x.dataset.payload));logs.innerHTML='';n=0;items.forEach(add)}
const es=new EventSource('/events');es.onmessage=x=>{const e=JSON.parse(x.data);if(paused)pending.push(e);else add(e)};es.onerror=()=>{status.textContent='● DISCONNECTED';status.className='paused'};search.oninput=redraw;level.onchange=redraw;document.querySelector('#pause').onclick=()=>{paused=!paused;status.textContent=paused?'● PAUSED':'● LIVE';status.className=paused?'paused':'live';document.querySelector('#pause').textContent=paused?'Resume':'Pause';if(!paused)pending.splice(0).forEach(add)};document.querySelector('#clear').onclick=()=>{logs.innerHTML='';n=0;count.textContent='0'};
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

module.exports = { startDashboard, openBrowser };
