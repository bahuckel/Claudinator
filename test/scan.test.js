'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseFile,
  buildProjectResolver,
  costOf,
  cacheWaste,
  aggregate,
  toCsv,
} = require('../lib/scan');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudinator-'));
}

function writeJsonl(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function assistant(over) {
  return Object.assign(
    {
      type: 'assistant',
      uuid: 'u-' + Math.random().toString(36).slice(2),
      sessionId: 'sess-1',
      timestamp: '2026-09-04T10:00:00.000Z',
      cwd: 'C:\\work\\proj',
      requestId: 'req-1',
      message: {
        id: 'msg-1',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 },
          output_tokens_details: { thinking_tokens: 5 },
        },
      },
    },
    over
  );
}

const PRICING = {
  cacheMultipliers: { write5m: 1.25, write1h: 2, read: 0.1 },
  default: { input: 0, output: 0 },
  models: { 'claude-opus-5': { input: 5, output: 25, fast: { input: 10, output: 50 } } },
};

test('parseFile dedupes streamed blocks of the same message and skips synthetic', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sess-1.jsonl');
  writeJsonl(file, [
    assistant({ message: Object.assign(assistant().message, { content: [{ type: 'thinking' }] }) }),
    assistant({ message: Object.assign(assistant().message, { content: [{ type: 'text', text: 'x' }] }) }),
    assistant({ requestId: 'req-2', message: Object.assign(assistant().message, { id: 'msg-2' }) }),
    assistant({ message: Object.assign(assistant().message, { id: 'msg-3', model: '<synthetic>' }) }),
    { type: 'user', uuid: 'x', sessionId: 'sess-1', message: { role: 'user', content: 'Build me a dashboard please' } },
    { type: 'user', uuid: 'y', sessionId: 'sess-1', customTitle: 'Dashboard work' },
  ]);
  const p = await parseFile(file);
  assert.equal(p.records.length, 2);
  assert.deepEqual(
    p.records.map((r) => r.key).sort(),
    ['msg-1|req-1', 'msg-2|req-2']
  );
  const r = p.records[0];
  assert.equal(r.cw5, 40);
  assert.equal(r.cw1, 60);
  assert.equal(r.think, 5);
  assert.equal(p.sessions['sess-1'].prompt, 'Build me a dashboard please');
  assert.equal(p.sessions['sess-1'].title, 'Dashboard work');
});

test('parseFile falls back to the whole cache_creation total when no 5m/1h split', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 's.jsonl');
  const a = assistant();
  delete a.message.usage.cache_creation;
  writeJsonl(file, [a]);
  const r = (await parseFile(file)).records[0];
  assert.equal(r.cw5, 100);
  assert.equal(r.cw1, 0);
});

test('parseFile links subagent transcripts to their Agent tool call', async () => {
  const dir = tmpDir();
  const main = path.join(dir, 'sess-1.jsonl');
  writeJsonl(main, [
    assistant({
      uuid: 'a1',
      message: Object.assign(assistant().message, {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { subagent_type: 'Explore', description: 'Find the thing' } }],
      }),
    }),
    {
      type: 'user',
      uuid: 'r1',
      sessionId: 'sess-1',
      toolUseResult: { agentId: 'agent-x', description: 'Find the thing' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    },
  ]);
  const p = await parseFile(main);
  assert.equal(p.toolUses.toolu_1.type, 'Explore');
  assert.equal(p.agentLinks['agent-x'].toolUseId, 'toolu_1');
});

test('costOf applies cache multipliers and fast-mode rates', () => {
  const rec = { model: 'claude-opus-5', speed: 'standard', in: 1e6, out: 1e6, cw5: 1e6, cw1: 1e6, cr: 1e6 };
  // 5 + 25 + 6.25 + 10 + 0.5
  assert.equal(Number(costOf(rec, PRICING).toFixed(2)), 46.75);
  assert.equal(Number(costOf(Object.assign({}, rec, { speed: 'fast' }), PRICING).toFixed(2)), 93.5);
  assert.equal(costOf(Object.assign({}, rec, { model: 'unknown-model' }), PRICING), 0);
});

test('project resolver rolls subfolders up to the git root or project folder', () => {
  const ws = tmpDir();
  const repo = path.join(ws, 'RepoA');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  const plain = path.join(ws, 'PlainB');
  fs.mkdirSync(path.join(plain, 'docs'), { recursive: true });
  const c = path.join(ws, 'C');
  fs.mkdirSync(c);

  const cwds = [
    path.join(repo, 'src', 'deep'),
    repo,
    plain,
    path.join(plain, 'docs'),
    c,
    ws, // a session started in the workspace itself
  ];
  const resolve = buildProjectResolver(cwds, { minWorkspaceChildren: 3 });

  assert.equal(resolve(path.join(repo, 'src', 'deep')).label, 'RepoA');
  assert.equal(resolve(path.join(plain, 'docs')).label, 'PlainB');
  assert.equal(resolve(c).label, 'C');
  assert.equal(resolve(ws).workspace, true);
  assert.equal(resolve(ws).label, path.basename(ws) + ' (root)');
});

test('project resolver honours explicit projectRoots', () => {
  const ws = tmpDir();
  const mono = path.join(ws, 'mono');
  const pkgs = ['a', 'b', 'c'].map((n) => path.join(mono, 'packages', n));
  for (const p of pkgs) fs.mkdirSync(p, { recursive: true });
  const resolve = buildProjectResolver(pkgs, { projectRoots: [mono], minWorkspaceChildren: 3 });
  assert.equal(resolve(pkgs[0]).label, 'mono');
});

test('aggregate builds daily series, best days, previous window and csv', () => {
  const now = Date.now();
  const day = 86400000;
  const mk = (ts, project, agent, out) => ({
    key: 'k' + ts + project + agent,
    ts,
    model: 'claude-opus-5',
    speed: 'standard',
    session: 's-' + project,
    sidechain: agent !== 'main thread',
    agentId: agent !== 'main thread' ? 'ag' : null,
    agent,
    agentTask: agent !== 'main thread' ? 'Do a task' : null,
    cwd: 'C:\\w\\' + project,
    project,
    projectPath: 'C:\\w\\' + project,
    in: 1,
    out,
    think: 0,
    cw5: 0,
    cw1: 0,
    cr: 0,
    webSearch: 0,
    webFetch: 0,
  });
  const records = [
    mk(now - 9 * day, 'old', 'main thread', 500), // previous window only
    mk(now - 2 * day, 'alpha', 'main thread', 100),
    mk(now - 1 * day, 'alpha', 'general-purpose', 300),
    mk(now, 'beta', 'main thread', 50),
  ];
  const a = aggregate(records, '7d', PRICING, { 's-alpha': { title: 'Alpha work' } });

  assert.equal(a.series.length, 7);
  assert.equal(a.activeDays, 3);
  assert.equal(a.totals.output, 450);
  assert.equal(a.previous.output, 500);
  assert.equal(a.bestDays[0].output, 300);
  assert.equal(a.projects[0].name, 'alpha');
  assert.equal(a.agents.map((x) => x.name).sort().join(','), 'general-purpose,main thread');
  assert.equal(a.agentRuns[0].name, 'Do a task');
  assert.equal(a.sessions.find((s) => s.name === 's-alpha').title, 'Alpha work');

  const yesterday = a.series[a.series.length - 2];
  assert.equal(yesterday.byProject.alpha.output, 300);
  assert.equal(yesterday.byModel['claude-opus-5'].output, 300);

  const csv = toCsv(a);
  assert.equal(csv.split('\n')[0], 'date,input,output,thinking,cacheWrite,cacheRead,total,messages,sessions,cost');
  assert.equal(csv.trim().split('\n').length, 8);

  const all = aggregate(records, 'all', PRICING);
  assert.equal(all.previous, null);
  assert.equal(all.series.length, 10);
});

test('compact suggestions flag big contexts and detect earlier compactions', () => {
  const now = Date.now();
  const mk = (i, session, cr, extra) =>
    Object.assign(
      {
        key: session + i,
        ts: now - (100 - i) * 60000,
        model: 'claude-opus-5',
        speed: 'standard',
        session,
        sidechain: false,
        agentId: null,
        agent: 'main thread',
        agentTask: null,
        cwd: 'C:\\w\\p',
        project: 'p',
        projectPath: 'C:\\w\\p',
        in: 100,
        out: 50,
        think: 0,
        cw5: 0,
        cw1: 0,
        cr,
        webSearch: 0,
        webFetch: 0,
      },
      extra
    );

  const records = [];
  // "big": context climbs to 400k, gets compacted once (drop to 30k), climbs again to 260k
  const ctxs = [50000, 150000, 400000, 30000, 120000, 260000];
  ctxs.forEach((cr, i) => records.push(mk(i, 'big', cr)));
  // "small": stays under threshold
  [10000, 20000, 30000].forEach((cr, i) => records.push(mk(i, 'small', cr)));
  // subagent turns must not count as the session's context
  records.push(mk(50, 'small', 900000, { sidechain: true, agentId: 'ag', agent: 'Explore' }));

  const opts = { compactThresholdTokens: 150000, compactTargetTokens: 20000 };
  const a = aggregate(records, '7d', PRICING, {}, opts);
  assert.equal(a.compact.sessionsChecked, 2);
  assert.equal(a.compact.suggestions.length, 1);
  const s = a.compact.suggestions[0];
  assert.equal(s.session, 'big');
  assert.equal(s.contextNow, 260100);
  assert.equal(s.contextPeak, 400100);
  assert.equal(s.compactions, 1);
  assert.equal(s.turnsAboveThreshold, 3);
  assert.equal(s.idle, false);
  // (260100 - 20000) cache-read tokens at $5/M * 0.1
  assert.equal(Number(s.savePerMsg.toFixed(4)), Number(((260100 - 20000) * 0.5 / 1e6).toFixed(4)));
  assert.equal(a.sessions.find((x) => x.name === 'small').contextNow, 30100);

  // A mark makes the suggestion count only the turns after it.
  const beforeLastTwo = records.filter((r) => r.session === 'big')[3].ts - 1;
  const marked = aggregate(records, '7d', PRICING, {}, opts, { big: beforeLastTwo });
  const ms = marked.compact.suggestions[0];
  assert.equal(ms.session, 'big');
  assert.equal(ms.messages, 3); // the 30k / 120k / 260k turns
  assert.equal(ms.contextPeak, 260100); // the 400k turn is behind the mark
  assert.equal(ms.compactions, 0); // so is the drop that followed it
  assert.equal(ms.markedAt, beforeLastTwo);
  assert.equal(marked.compact.marks[0].turnsSince, 3);

  // Marking after the last turn retires the suggestion entirely.
  const retired = aggregate(records, '7d', PRICING, {}, opts, { big: now + 1000 });
  assert.equal(retired.compact.suggestions.length, 0);
  assert.equal(retired.compact.marks[0].turnsSince, 0);
});

test('marks round-trip through the marks file', (t) => {
  const { loadMarks, setMark } = require('../lib/scan');
  const file = path.join(__dirname, '..', 'compact-marks.json');
  const had = fs.existsSync(file) ? fs.readFileSync(file) : null;
  t.after(() => {
    if (had) fs.writeFileSync(file, had);
    else fs.rmSync(file, { force: true });
  });

  fs.rmSync(file, { force: true });
  assert.deepEqual(loadMarks(), {});
  setMark('sess-a', 1234);
  setMark('sess-b', 5678);
  assert.deepEqual(loadMarks(), { 'sess-a': 1234, 'sess-b': 5678 });
  setMark('sess-a', null);
  assert.deepEqual(loadMarks(), { 'sess-b': 5678 });

  fs.writeFileSync(file, 'not json');
  assert.deepEqual(loadMarks(), {});
});

test('marks older than the retention window are pruned from the file', (t) => {
  const { loadMarks, setMark } = require('../lib/scan');
  const file = path.join(__dirname, '..', 'compact-marks.json');
  const had = fs.existsSync(file) ? fs.readFileSync(file) : null;
  t.after(() => {
    if (had) fs.writeFileSync(file, had);
    else fs.rmSync(file, { force: true });
  });

  const now = Date.now();
  const day = 86400000;
  fs.rmSync(file, { force: true });
  setMark('fresh', now - 2 * day);
  setMark('stale', now - 9 * day);
  setMark('edge', now - 6.9 * day);

  const kept = loadMarks(7);
  assert.deepEqual(Object.keys(kept).sort(), ['edge', 'fresh']);
  // the expired entry is gone from disk, not merely hidden
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['edge', 'fresh']);

  // no retention configured keeps everything
  setMark('stale', now - 9 * day);
  assert.equal(Object.keys(loadMarks(0)).length, 3);
});

test('mark entries carry an expiry for the UI', () => {
  const now = Date.now();
  const rec = {
    key: 'k', ts: now - 1000, model: 'claude-opus-5', speed: 'standard', effort: 'high',
    session: 's', sidechain: false, agentId: null, agent: 'main thread',
    cwd: 'C:\w\p', project: 'p', projectPath: 'C:\w\p',
    in: 200000, out: 0, think: 0, cw5: 0, cw1: 0, cr: 0, webSearch: 0, webFetch: 0,
  };
  const markedAt = now - 86400000;
  const a = aggregate([rec], '7d', PRICING, {}, { markRetentionDays: 7 }, { s: markedAt }, []);
  const m = a.compact.marks[0];
  assert.equal(m.session, 's');
  assert.equal(m.expiresAt, markedAt + 7 * 86400000);
  assert.equal(a.compact.markRetentionDays, 7);
});

test('effort, server tools, fast mode and unknown models are all tracked', () => {
  const now = Date.now();
  const base = {
    speed: 'standard',
    effort: 'high',
    session: 's',
    sidechain: false,
    agentId: null,
    agent: 'main thread',
    cwd: 'C:\w\p',
    project: 'p',
    projectPath: 'C:\w\p',
    in: 0, out: 0, think: 0, cw5: 0, cw1: 0, cr: 0, webSearch: 0, webFetch: 0,
  };
  const pricing = Object.assign({}, PRICING, {
    serverTools: { webSearchPer1k: 10, webFetchPer1k: 0 },
  });
  const records = [
    Object.assign({}, base, { key: 'a', ts: now - 1000, out: 1e6, effort: 'high' }),
    Object.assign({}, base, { key: 'b', ts: now - 900, out: 1e6, effort: 'max', speed: 'fast' }),
    Object.assign({}, base, { key: 'c', ts: now - 800, webSearch: 100 }),
    Object.assign({}, base, { key: 'd', ts: now - 700, out: 1e6, model: 'claude-mystery-9' }),
  ];
  for (const r of records) if (!r.model) r.model = 'claude-opus-5';

  const a = aggregate(records, '7d', pricing, {}, {}, {}, []);
  assert.deepEqual(a.efforts.map((e) => e.name).sort(), ['high', 'max']);
  assert.equal(a.efforts.find((e) => e.name === 'max').messages, 1);
  assert.equal(a.totals.webSearch, 100);
  assert.equal(a.totals.fastMessages, 1);
  // 100 searches at $10/1k = $1
  assert.ok(a.totals.cost > 1);
  assert.equal(a.unknownModels.length, 1);
  assert.equal(a.unknownModels[0].name, 'claude-mystery-9');
  assert.equal(a.unknownModels[0].messages, 1);
  // fast mode is billed at the fast rate: 1M output at $50 instead of $25
  assert.equal(Number(a.totals.fastCost.toFixed(2)), 50);
  const day = a.series[a.series.length - 1];
  assert.ok(day.byEffort.high && day.byEffort.max);

  // filtering narrows every panel
  const f = aggregate(records, '7d', pricing, {}, {}, {}, [], { effort: 'max' });
  assert.equal(f.totals.messages, 1);
  assert.deepEqual(f.filter, { effort: 'max' });
});

test('cache waste counts writes that no later turn could read', () => {
  const now = Date.now();
  const mk = (key, ts, cw5, cw1) => ({
    key, ts, model: 'claude-opus-5', speed: 'standard', effort: 'high',
    session: 's', sidechain: false, agentId: null, agent: 'main thread',
    cwd: 'C:\w\p', project: 'p', projectPath: 'C:\w\p',
    in: 0, out: 0, think: 0, cw5, cw1, cr: 0, webSearch: 0, webFetch: 0,
  });
  const min = 60000;
  const records = [
    mk('a', now - 40 * min, 1000, 0), // next turn is 30 min later: 5m write wasted
    mk('b', now - 10 * min, 2000, 0), // next turn 1 min later: reused
    mk('c', now - 9 * min, 0, 4000), // last turn: 1h write wasted
  ];
  const w = cacheWaste(records, PRICING);
  assert.equal(w.writes, 3);
  assert.equal(w.tokens, 5000); // 1000 + 4000
  // 1000 * 5/1e6 * 1.25 + 4000 * 5/1e6 * 2
  assert.equal(Number(w.cost.toFixed(6)), Number((1000 * 5e-6 * 1.25 + 4000 * 5e-6 * 2).toFixed(6)));
});

test('tool results are sized and attributed to their tool', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sess-1.jsonl');
  const bigText = 'x'.repeat(2000);
  writeJsonl(file, [
    assistant({
      uuid: 'a1',
      message: Object.assign(assistant().message, {
        content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }],
      }),
    }),
    {
      type: 'user', uuid: 'r1', sessionId: 'sess-1', timestamp: '2026-09-04T10:00:01.000Z',
      toolUseResult: { stdout: bigText },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: bigText }] },
    },
    {
      // below MIN_TOOL_CHARS, ignored
      type: 'user', uuid: 'r2', sessionId: 'sess-1', timestamp: '2026-09-04T10:00:02.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
    },
  ]);
  const p = await parseFile(file);
  assert.equal(p.toolCalls.length, 1);
  assert.equal(p.toolCalls[0].n, 'Bash');
  assert.equal(p.toolCalls[0].s, 'sess-1');
  assert.ok(p.toolCalls[0].c > 2000);
});
