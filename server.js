'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  loadConfig,
  loadPricing,
  scan,
  aggregate,
  toCsv,
  loadMarks,
  setMark,
  RANGES,
} = require('./lib/scan');

const PUBLIC_DIR = path.join(__dirname, 'public');
const cfg = loadConfig();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, code, type, body, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, extra));
  res.end(body);
}

function sendJson(res, code, body) {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(body));
}

function serveStatic(res, urlPath) {
  let rel;
  try {
    rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.replace(/^\/+/, ''));
  } catch {
    send(res, 400, 'text/plain', 'bad path');
    return;
  }
  const full = path.resolve(PUBLIC_DIR, rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
    send(res, 403, 'text/plain', 'forbidden');
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      send(res, 404, 'text/plain', 'not found');
      return;
    }
    send(res, 200, MIME[path.extname(full)] || 'application/octet-stream', buf);
  });
}

function usageFor(range) {
  const pricing = loadPricing(); // reloaded each fetch so edits apply live
  const { records, sessionMeta, stats } = scan(cfg.roots, cfg);
  const data = aggregate(records, range, pricing, sessionMeta, cfg, loadMarks());
  data.scan = stats;
  return data;
}

// Only this machine's own page may write; a stray cross-origin POST cannot.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl and friends
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch {
    return false;
  }
}

function readJsonBody(req, cb) {
  let body = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 4096 && !tooBig) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (tooBig) return cb(new Error('body too large'));
    try {
      cb(null, JSON.parse(body || '{}'));
    } catch (err) {
      cb(err);
    }
  });
  req.on('error', (err) => cb(err));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const range = url.searchParams.get('range') || '30d';

  if (url.pathname === '/api/usage' || url.pathname === '/api/usage.csv') {
    if (!(range in RANGES)) {
      sendJson(res, 400, { error: 'unknown range: ' + range, valid: Object.keys(RANGES) });
      return;
    }
    try {
      const data = usageFor(range);
      if (url.pathname.endsWith('.csv')) {
        send(res, 200, 'text/csv; charset=utf-8', toCsv(data), {
          'Content-Disposition': 'attachment; filename="claudinator-' + range + '.csv"',
        });
      } else {
        sendJson(res, 200, data);
      }
    } catch (err) {
      console.error(err);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // Mark a session compacted (or clear the mark): everything before the
  // timestamp stops counting toward its suggestion.
  if (url.pathname === '/api/compact-mark') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'POST only' });
      return;
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: 'cross-origin write refused' });
      return;
    }
    readJsonBody(req, (err, body) => {
      if (err) {
        sendJson(res, 400, { error: 'bad JSON body' });
        return;
      }
      const session = typeof body.session === 'string' ? body.session.slice(0, 200) : '';
      if (!session) {
        sendJson(res, 400, { error: 'session is required' });
        return;
      }
      const ts = body.clear ? null : Number(body.ts) || Date.now();
      try {
        const marks = setMark(session, ts);
        sendJson(res, 200, { ok: true, session, markedAt: ts, marks });
      } catch (e) {
        console.error(e);
        sendJson(res, 500, { error: e.message });
      }
    });
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, roots: cfg.roots, pid: process.pid });
    return;
  }

  serveStatic(res, url.pathname);
});

server.listen(cfg.port, '127.0.0.1', () => {
  console.log('Claudinator on http://localhost:' + cfg.port);
  console.log('Scanning: ' + cfg.roots.join(', '));
});
