'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8799;
const BASE = 'http://127.0.0.1:' + PORT;

let child;
let emptyRoot;

// Start the real server against an empty transcript root so the tests never
// depend on the developer's own usage.
test.before(async () => {
  emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudinator-roots-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), CLAUDINATOR_ROOTS: emptyRoot }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    child.stdout.on('data', (b) => {
      if (String(b).includes('Claudinator on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
  });
});

test.after(() => {
  if (child) child.kill();
  if (emptyRoot) fs.rmSync(emptyRoot, { recursive: true, force: true });
});

test('serves the dashboard and its assets', async () => {
  const html = await fetch(BASE + '/');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(await html.text(), /Claudinator/);

  const js = await fetch(BASE + '/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('refuses to serve files outside public/', async () => {
  for (const attempt of ['/../server.js', '/..%2Fserver.js', '/%2e%2e/package.json']) {
    const res = await fetch(BASE + attempt);
    assert.ok(res.status === 403 || res.status === 404, attempt + ' -> ' + res.status);
    const body = await res.text();
    assert.ok(!body.includes('createServer'), attempt + ' leaked server.js');
  }
});

test('/api/health reports the configured roots', async () => {
  const res = await fetch(BASE + '/api/health');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.roots, [emptyRoot]);
});

test('/api/usage validates the range and returns a full shape', async () => {
  const bad = await fetch(BASE + '/api/usage?range=nope');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /unknown range/);

  const res = await fetch(BASE + '/api/usage?range=7d');
  assert.equal(res.status, 200);
  const d = await res.json();
  for (const k of ['totals', 'series', 'projects', 'agents', 'models', 'efforts', 'tools', 'compact', 'scan']) {
    assert.ok(k in d, 'missing ' + k);
  }
  assert.equal(d.series.length, 7);
  assert.equal(d.totals.messages, 0); // empty root
  assert.equal(d.compact.suggestions.length, 0);
});

test('/api/usage.csv sets a download header and a header row', async () => {
  const res = await fetch(BASE + '/api/usage.csv?range=7d');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /claudinator-7d\.csv/);
  const text = await res.text();
  assert.equal(text.split('\n')[0], 'date,input,output,thinking,cacheWrite,cacheRead,total,messages,sessions,cost');
});

test('filters are echoed back and applied', async () => {
  const res = await fetch(BASE + '/api/usage?range=7d&project=Nothing');
  const d = await res.json();
  assert.deepEqual(d.filter, { project: 'Nothing' });
  assert.equal(d.totals.messages, 0);
});

test('/api/compact-mark writes, clears, and refuses bad callers', async () => {
  const marksFile = path.join(ROOT, 'compact-marks.json');
  const had = fs.existsSync(marksFile) ? fs.readFileSync(marksFile) : null;
  try {
    const post = (body, headers) =>
      fetch(BASE + '/api/compact-mark', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    const ok = await post({ session: 'test-session', ts: 4242 });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).marks['test-session'], 4242);

    const get = await fetch(BASE + '/api/compact-mark');
    assert.equal(get.status, 405);

    const cross = await post({ session: 'x', ts: 1 }, { Origin: 'https://evil.example' });
    assert.equal(cross.status, 403);

    const noSession = await post({ ts: 1 });
    assert.equal(noSession.status, 400);

    const garbage = await post('{not json');
    assert.equal(garbage.status, 400);

    const cleared = await post({ session: 'test-session', clear: true });
    assert.equal('test-session' in (await cleared.json()).marks, false);
  } finally {
    if (had) fs.writeFileSync(marksFile, had);
    else fs.rmSync(marksFile, { force: true });
  }
});

test('rejects an oversized request body', async () => {
  const res = await fetch(BASE + '/api/compact-mark', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: 'x'.repeat(9000) }),
  }).catch((err) => err);
  // The server destroys the socket, so either a 400 or a transport error is fine.
  assert.ok(res instanceof Error || res.status === 400, 'oversized body was accepted');
});
