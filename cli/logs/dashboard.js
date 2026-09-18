'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const DIST_DIR = path.resolve(__dirname, '../dashboard/dist');
const INDEX_FILE = path.join(DIST_DIR, 'index.html');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function openBrowser(url) {
  if (process.platform === 'darwin') execFile('open', [url], () => {});
  else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
  else execFile('xdg-open', [url], () => {});
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(String(urlPath || '/').split('?')[0]);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = path.resolve(DIST_DIR, relative);
  return resolved.startsWith(DIST_DIR + path.sep) || resolved === INDEX_FILE ? resolved : null;
}

function sendFile(file, res) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' });
  fs.createReadStream(file).pipe(res);
  return true;
}

function sendMissingBuild(res) {
  res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  res.end([
    'RN Native Debugger React dashboard has not been built.',
    '',
    'Run:',
    '  yarn dashboard:build',
    '',
    `Expected: ${INDEX_FILE}`
  ].join('\n'));
}

function startDashboard({ host = '127.0.0.1', port = 9876, open = true } = {}) {
  const clients = new Set();
  let processProvider = () => [];
  let sessionProvider = () => ({});
  let metricsProvider = () => ({ available: false });

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${host}:${port}`);
    if (requestUrl.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*'
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (requestUrl.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, dashboard: fs.existsSync(INDEX_FILE) ? 'react' : 'missing-build' }));
    }

    if (requestUrl.pathname === '/processes') {
      try {
        const result = await Promise.resolve(processProvider());
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
        return res.end(JSON.stringify(Array.isArray(result) ? result : []));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: error && error.message ? error.message : 'Could not list processes' }));
      }
    }


    if (requestUrl.pathname === '/session') {
      try {
        const result = await Promise.resolve(sessionProvider());
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
        return res.end(JSON.stringify(result || {}));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: error && error.message ? error.message : 'Could not read session info' }));
      }
    }

    if (requestUrl.pathname === '/metrics') {
      try {
        const processName = requestUrl.searchParams.get('process') || '';
        const result = await Promise.resolve(metricsProvider(processName));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
        return res.end(JSON.stringify(result || { available: false }));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ available: false, error: error && error.message ? error.message : 'Could not sample metrics' }));
      }
    }

    if (!fs.existsSync(INDEX_FILE)) return sendMissingBuild(res);

    const requested = safeStaticPath(requestUrl.pathname);
    if (requested && sendFile(requested, res)) return;

    // SPA fallback for future client-side routes.
    if (req.method === 'GET' && sendFile(INDEX_FILE, res)) return;

    res.writeHead(404);
    res.end('Not found');
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
      resolve({
        url,
        publish,
        setProcessProvider(provider) { processProvider = typeof provider === 'function' ? provider : () => []; },
        setSessionProvider(provider) { sessionProvider = typeof provider === 'function' ? provider : () => ({}); },
        setMetricsProvider(provider) { metricsProvider = typeof provider === 'function' ? provider : () => ({ available: false }); },
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

module.exports = { startDashboard, openBrowser, DIST_DIR, INDEX_FILE };
