'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  loadConfig,
  saveConfig,
  tunableValues,
  TUNABLES,
  loadPricing,
  scan,
  aggregate,
  toCsv,
  loadMarks,
  setMark,
  RANGES,
  FILTERABLE,
} = require('./lib/scan');

const PUBLIC_DIR = path.join(__dirname, 'public');
// Read once for the things that are fixed for the life of the process (the
// port it binds, the roots it announces). Every request re-reads the file, so
// settings changed from the page apply to the next fetch without a restart.
const bootCfg = loadConfig();
const pkg = require('./package.json');
const startedAt = Date.now();
const codeMtime = Math.max(
  ...[path.join(__dirname, 'server.js'), path.join(__dirname, 'lib', 'scan.js')].map((f) => {
    try {
      return Math.round(fs.statSync(f).mtimeMs);
    } catch {
      return 0;
    }
  })
);

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

/** What "Reset" on the page puts back. */
function defaultValues() {
  const out = {};
  for (const t of TUNABLES) out[t.key] = t.def;
  return out;
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

async function usageFor(range, filter) {
  const cfg = loadConfig(); // reloaded each fetch so edits apply live
  const pricing = loadPricing();
  const { records, sessionMeta, toolCalls, stats } = await scan(cfg.roots, cfg);
  const data = aggregate(
    records,
    range,
    pricing,
    sessionMeta,
    cfg,
    loadMarks(cfg.markRetentionDays),
    toolCalls,
    filter
  );
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

/** POST + same-origin + a JSON body, or the response is already sent. */
function acceptPost(req, res, cb) {
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
    cb(body);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const range = url.searchParams.get('range') || '30d';

  if (url.pathname === '/api/usage' || url.pathname === '/api/usage.csv') {
    if (!(range in RANGES)) {
      sendJson(res, 400, { error: 'unknown range: ' + range, valid: Object.keys(RANGES) });
      return;
    }
    const filter = {};
    for (const k of FILTERABLE) {
      const v = url.searchParams.get(k);
      if (v) filter[k] = v.slice(0, 300);
    }
    usageFor(range, filter)
      .then((data) => {
        if (url.pathname.endsWith('.csv')) {
          send(res, 200, 'text/csv; charset=utf-8', toCsv(data), {
            'Content-Disposition': 'attachment; filename="claudinator-' + range + '.csv"',
          });
        } else {
          sendJson(res, 200, data);
        }
      })
      .catch((err) => {
        console.error(err);
        sendJson(res, 500, { error: err.message });
      });
    return;
  }

  // Mark a session compacted (or clear the mark): everything before the
  // timestamp stops counting toward its suggestion.
  if (url.pathname === '/api/compact-mark') {
    acceptPost(req, res, (body) => {
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

  // The knobs behind the /compact suggestions. GET ships the spec too, so the
  // page builds its sliders from the same bounds the write path enforces.
  if (url.pathname === '/api/settings') {
    if (req.method === 'GET') {
      let values;
      try {
        values = tunableValues();
      } catch (err) {
        sendJson(res, 500, { error: 'config.json is not valid JSON: ' + err.message });
        return;
      }
      sendJson(res, 200, { values, defaults: defaultValues(), tunables: TUNABLES });
      return;
    }
    acceptPost(req, res, (body) => {
      try {
        const values = saveConfig(body && body.values ? body.values : body);
        sendJson(res, 200, { ok: true, values });
      } catch (e) {
        // A bad key or a broken file is the caller's problem to fix, not a
        // server fault, so say which and keep the 4xx.
        const bad = e.code === 'EBADKEY' || e.code === 'EBADVALUE' || e.code === 'EBADCONFIG';
        if (!bad) console.error(e);
        sendJson(res, bad ? 400 : 500, { error: e.message });
      }
    });
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      version: pkg.version,
      // Code is loaded once at boot; this says which build is actually serving.
      startedAt,
      codeMtime,
      roots: bootCfg.roots,
      pid: process.pid,
    });
    return;
  }

  serveStatic(res, url.pathname);
});

server.listen(bootCfg.port, '127.0.0.1', () => {
  console.log('Claudinator on http://localhost:' + bootCfg.port);
  console.log('Scanning: ' + bootCfg.roots.join(', '));
});

module.exports = server;
