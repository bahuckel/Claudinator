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
  scan,
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

test('a forked transcript does not steal the tokens it copied', async () => {
  // Resuming a session copies the history into a new file and rewrites each
  // copied line's cwd and sessionId. Both files then hold the same API call,
  // and whichever the directory walk reaches first used to decide which
  // project got charged for it.
  const root = tmpDir();
  const call = (over) =>
    assistant(
      Object.assign(
        {
          requestId: 'req-shared',
          message: Object.assign(assistant().message, { id: 'msg-shared' }),
        },
        over
      )
    );

  // Walked first (alphabetical), but it is the fork: it starts two days later.
  writeJsonl(path.join(root, 'a-fork.jsonl'), [
    call({
      sessionId: 'sess-fork',
      cwd: 'C:\\work\\Workspace',
      timestamp: '2026-09-06T09:00:00.000Z',
    }),
  ]);
  // Walked second, but this is where the call was actually made.
  writeJsonl(path.join(root, 'z-original.jsonl'), [
    call({
      sessionId: 'sess-real',
      cwd: 'C:\\work\\Workspace\\Alpha',
      timestamp: '2026-09-04T09:00:00.000Z',
    }),
  ]);

  const out = await scan([root], { inferProjectFromPaths: false });
  assert.equal(out.records.length, 1, 'the copy is still deduped away');
  assert.equal(out.records[0].session, 'sess-real');
  assert.equal(out.records[0].cwd, 'C:\\work\\Workspace\\Alpha');
});

test('a conversation resumed into new sessions is one suggestion, not three', async () => {
  // Resuming mints a new sessionId and copies the history across, so one
  // conversation becomes several transcripts. Only the last of them still
  // exists to run /compact in; suggesting it on the other two is noise.
  const root = tmpDir();
  const base = Date.parse('2026-09-04T10:00:00.000Z');
  const call = (session, i, over) => {
    const rec = assistant(
      Object.assign(
        {
          sessionId: session,
          requestId: 'req-' + i,
          timestamp: new Date(base + i * 60000).toISOString(),
        },
        over
      )
    );
    rec.message.id = 'msg-' + i;
    rec.message.usage = {
      input_tokens: 0,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 300000,
    };
    return rec;
  };
  const run = (session, from, to) => {
    const out = [];
    for (let i = from; i <= to; i++) out.push(call(session, i));
    return out;
  };

  // gen1 makes calls 1-6. gen2 copies them and adds 7-12. gen3 copies all of
  // that and adds 13-18. Three transcripts, one conversation.
  writeJsonl(path.join(root, 'gen1.jsonl'), run('s-gen1', 1, 6));
  writeJsonl(path.join(root, 'gen2.jsonl'), run('s-gen2', 1, 12));
  writeJsonl(path.join(root, 'gen3.jsonl'), run('s-gen3', 1, 18));

  const out = await scan([root], { inferProjectFromPaths: false });
  assert.equal(out.records.length, 18, 'the copies are still deduped away');
  const heads = new Set(out.records.map((r) => r.conversation));
  assert.deepEqual([...heads], ['s-gen3'], 'all of it belongs to the live session');

  const pricing = {
    cacheMultipliers: { write5m: 1.25, write1h: 2, read: 0.1 },
    default: { input: 5, output: 25 },
    models: {},
  };
  const agg = aggregate(out.records, 'all', pricing, {}, { compactThresholdTokens: 100000 }, {}, []);
  const list = agg.compact.suggestions;
  assert.equal(list.length, 1, 'one card, not three');
  assert.equal(list[0].session, 's-gen3', 'named for the session you can still act in');
  assert.equal(list[0].folded, 3);
  assert.deepEqual(list[0].sessions.sort(), ['s-gen1', 's-gen2', 's-gen3']);
  assert.equal(list[0].messages, 18, 'the whole conversation, counted once');
});

test('a mark on any session in a chain silences the whole conversation', async () => {
  const root = tmpDir();
  const base = Date.parse('2026-09-04T10:00:00.000Z');
  const call = (session, i) => {
    const rec = assistant({
      sessionId: session,
      requestId: 'req-' + i,
      timestamp: new Date(base + i * 60000).toISOString(),
    });
    rec.message.id = 'msg-' + i;
    rec.message.usage = {
      input_tokens: 0,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 300000,
    };
    return rec;
  };
  const run = (session, to) => {
    const out = [];
    for (let i = 1; i <= to; i++) out.push(call(session, i));
    return out;
  };
  writeJsonl(path.join(root, 'old.jsonl'), run('s-old', 4));
  writeJsonl(path.join(root, 'new.jsonl'), run('s-new', 8));

  const out = await scan([root], { inferProjectFromPaths: false });
  const pricing = {
    cacheMultipliers: { write5m: 1.25, write1h: 2, read: 0.1 },
    default: { input: 5, output: 25 },
    models: {},
  };
  const opts = { compactThresholdTokens: 100000 };
  // Marked under the id that was on screen at the time - the older one.
  const marks = { 's-old': base + 8 * 60000 };
  const agg = aggregate(out.records, 'all', pricing, {}, opts, marks, []);
  assert.equal(agg.compact.suggestions.length, 0, 'the mark reaches the whole chain');
  assert.equal(agg.compact.marks.length, 1);
  assert.equal(agg.compact.marks[0].folded, 2);
});

test('a copy with its usage zeroed never outranks the real record', async () => {
  // A fork can carry a message in as a stub. Being older does not make a stub
  // the record of an API call.
  const root = tmpDir();
  const zeroed = assistant({
    sessionId: 'sess-stub',
    cwd: 'C:\\work\\Workspace',
    timestamp: '2026-09-01T09:00:00.000Z',
    requestId: 'req-shared',
  });
  zeroed.message.id = 'msg-shared';
  zeroed.message.usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const real = assistant({
    sessionId: 'sess-real',
    cwd: 'C:\\work\\Workspace\\Alpha',
    timestamp: '2026-09-05T09:00:00.000Z',
    requestId: 'req-shared',
  });
  real.message.id = 'msg-shared';

  writeJsonl(path.join(root, 'a-stub.jsonl'), [zeroed]);
  writeJsonl(path.join(root, 'z-real.jsonl'), [real]);

  const out = await scan([root], { inferProjectFromPaths: false });
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].session, 'sess-real');
  assert.equal(out.records[0].out, 20, 'the real usage survived');
});

test('a model can override the cache multipliers it is billed at', () => {
  // Fable 5.1 and Mythos 5.1 read cache at 0.025x their input rate, not the
  // usual 0.1x. Cache reads are most of what an agentic session spends, so a
  // flat multiplier overcharges them 4x.
  const pricing = {
    cacheMultipliers: { write5m: 1.25, write1h: 2, read: 0.1 },
    default: { input: 5, output: 25 },
    models: {
      'claude-opus-5': { input: 5, output: 25 },
      'claude-fable-5-1': { input: 10, output: 50, cacheMultipliers: { read: 0.025 } },
    },
  };
  const rec = (model) => ({ model, speed: 'standard', in: 0, out: 0, cw5: 0, cw1: 0, cr: 1e6 });

  assert.equal(costOf(rec('claude-opus-5'), pricing), 0.5, '1M cache reads at 5 x 0.1');
  assert.equal(costOf(rec('claude-fable-5-1'), pricing), 0.25, '1M cache reads at 10 x 0.025');

  // Only the named multiplier is overridden; the writes keep the global ones.
  const write = { model: 'claude-fable-5-1', speed: 'standard', in: 0, out: 0, cw5: 1e6, cw1: 0, cr: 0 };
  assert.equal(costOf(write, pricing), 12.5, 'the 5m write is still 1.25x');
});

test('an unlisted model inherits the global cache multipliers', () => {
  const pricing = {
    cacheMultipliers: { read: 0.2 },
    default: { input: 5, output: 25 },
    models: {},
  };
  const rec = { model: 'claude-unheard-of-9', speed: 'standard', in: 0, out: 0, cw5: 0, cw1: 0, cr: 1e6 };
  assert.equal(costOf(rec, pricing), 1, 'global read multiplier, default rate');
});

test('an unlisted model is priced by date suffix, then by family, then default', () => {
  const pricing = {
    cacheMultipliers: { write5m: 1.25, write1h: 2, read: 0.1 },
    default: { input: 5, output: 25 },
    families: { haiku: { input: 1, output: 5 }, sonnet: { input: 3, output: 15 } },
    models: { 'claude-sonnet-4-5': { input: 3, output: 15 } },
  };
  // 1M input tokens, so the number printed is the input rate.
  const at = (model) =>
    costOf({ model, speed: 'standard', in: 1e6, out: 0, cw5: 0, cw1: 0, cr: 0 }, pricing);

  assert.equal(at('claude-sonnet-4-5'), 3);
  assert.equal(at('claude-sonnet-4-5-20250929'), 3, 'the date suffix is dropped');

  // Not in the table at any spelling: the name still says which tier it is,
  // and an Opus-tier default would price this Haiku 5x over.
  assert.equal(at('claude-haiku-9-9-20990101'), 1, 'priced by family');
  assert.equal(at('claude-sonnet-9-9'), 3);
  assert.equal(at('gpt-something'), 5, 'no family in the name, so the default');
});

test('a model priced by family is still reported as unknown', () => {
  // Guessing the tier makes the number sane; it does not make it right, so the
  // banner must still name the model.
  const now = Date.now();
  const pricing = {
    cacheMultipliers: { write5m: 1.25, write1h: 2, read: 0.1 },
    default: { input: 5, output: 25 },
    families: { haiku: { input: 1, output: 5 } },
    models: { 'claude-opus-5': { input: 5, output: 25 } },
  };
  const rec = (model) => ({
    session: 's1',
    project: 'Alpha',
    model,
    speed: 'standard',
    ts: now - 60000,
    agentId: null,
    sidechain: false,
    in: 1e6,
    out: 0,
    think: 0,
    cw5: 0,
    cw1: 0,
    cr: 0,
  });
  const out = aggregate(
    [rec('claude-opus-5'), rec('claude-haiku-9-9')],
    '30d',
    pricing,
    {},
    {},
    {},
    []
  );
  const names = out.unknownModels.map((u) => u.name);
  assert.deepEqual(names, ['claude-haiku-9-9'], 'the guessed one is flagged, the listed one is not');
  assert.equal(out.unknownModels[0].cost, 1, 'and the banner shows what the guess cost');
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
  assert.equal(p.toolCalls[0].c, 2000); // the content, not the whole line
});

test('tool results are sized from their content, not the transcript line', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sess-1.jsonl');
  const payload = 'y'.repeat(4000);
  writeJsonl(file, [
    assistant({
      uuid: 'a1',
      message: Object.assign(assistant().message, {
        content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }],
      }),
    }),
    {
      // The line stores the payload twice: once for the model, once as metadata.
      type: 'user', uuid: 'r1', sessionId: 'sess-1', timestamp: '2026-09-04T10:00:01.000Z',
      toolUseResult: { file: { content: payload } },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: payload }] },
    },
  ]);
  const p = await parseFile(file);
  assert.equal(p.toolCalls.length, 1);
  // content only, not the ~8k+ line
  assert.equal(p.toolCalls[0].c, 4000);
  assert.equal(p.toolCalls[0].i, 0);
});

test('image blocks in a tool result are counted separately', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sess-1.jsonl');
  writeJsonl(file, [
    assistant({
      uuid: 'a1',
      message: Object.assign(assistant().message, {
        content: [{ type: 'tool_use', id: 'tu1', name: 'Screenshot', input: {} }],
      }),
    }),
    {
      type: 'user', uuid: 'r1', sessionId: 'sess-1', timestamp: '2026-09-04T10:00:01.000Z',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 'tu1',
          content: [
            { type: 'text', text: 'z'.repeat(500) },
            { type: 'image', source: { type: 'base64', data: 'AAAA' } },
          ],
        }],
      },
    },
  ]);
  const p = await parseFile(file);
  assert.equal(p.toolCalls[0].c, 500);
  assert.equal(p.toolCalls[0].i, 1);

  const rec = {
    key: 'k', ts: Date.now(), model: 'claude-opus-5', speed: 'standard', effort: 'high',
    session: 'sess-1', sidechain: false, agentId: null, agent: 'main thread',
    cwd: 'C:\w\p', project: 'p', projectPath: 'C:\w\p',
    in: 10, out: 10, think: 0, cw5: 0, cw1: 0, cr: 0, webSearch: 0, webFetch: 0,
  };
  const calls = p.toolCalls.map((t) => Object.assign({}, t, { t: rec.ts }));
  const a = aggregate([rec], '7d', PRICING, {}, {}, {}, calls);
  // 500 chars / 4 + one image at the documented flat rate
  assert.equal(a.tools[0].tokens, 125 + 1600);
  assert.equal(a.tools[0].images, 1);
});

test('context growth is measured exactly and skips compactions', () => {
  const now = Date.now();
  const mk = (key, ts, ctx, out) => ({
    key, ts, model: 'claude-opus-5', speed: 'standard', effort: 'high',
    session: 's', sidechain: false, agentId: null, agent: 'main thread',
    cwd: 'C:\w\p', project: 'p', projectPath: 'C:\w\p',
    in: 0, out, think: 0, cw5: 0, cw1: 0, cr: ctx, webSearch: 0, webFetch: 0,
  });
  const records = [
    mk('a', now - 4000, 10000, 100),
    mk('b', now - 3000, 15000, 200), // grew 15000 - 10000 - 100 = 4900
    mk('c', now - 2000, 3000, 50), // compaction: shrank, skipped
    mk('d', now - 1000, 9000, 10), // grew 9000 - 3000 - 50 = 5950
  ];
  const toolCalls = [{ s: 's', t: now - 3500, n: 'Bash', c: 1000, i: 0, a: null }];
  const g = aggregate(records, '7d', PRICING, {}, {}, {}, toolCalls).contextGrowth;

  assert.equal(g.turns, 2);
  assert.equal(g.shrinks, 1);
  assert.equal(g.measured, 4900 + 5950);
  assert.equal(g.biggest[0].grew, 5950);
  assert.equal(g.biggest[1].grew, 4900);
  assert.deepEqual(g.biggest[1].tools, ['Bash']);
  assert.deepEqual(g.biggest[0].tools, []);
});

test('the post-compact size is measured from the compactions in the transcripts', async () => {
  const { aggregate } = require('../lib/scan');
  const now = Date.now();
  const PRICING = {
    cacheMultipliers: { write5m: 1.25, write1h: 2, read: 0.1 },
    default: { input: 5, output: 25 },
    models: {},
  };
  // One session's worth of turns: context climbs, collapses, climbs again.
  const turn = (session, project, cr, i) => ({
    session,
    project,
    model: 'claude-opus-5',
    speed: null,
    ts: now - (100 - i) * 60000,
    agentId: null,
    sidechain: false,
    in: 0,
    out: 50,
    cw5: 0,
    cw1: 0,
    cr,
  });
  const run = (session, project, sizes) => sizes.map((c, i) => turn(session, project, c, i));

  // Three drops, landing at 60k, 70k and 80k: median 70k.
  const records = [
    ...run('s1', 'Alpha', [300000, 60000, 400000]),
    ...run('s2', 'Alpha', [500000, 70000, 600000]),
    ...run('s3', 'Beta', [450000, 80000, 500000]),
  ];
  const opts = { compactThresholdTokens: 150000, compactTargetTokens: 20000 };

  const auto = aggregate(records, '30d', PRICING, {}, Object.assign({ compactTargetAuto: true }, opts), {}, []);
  assert.equal(auto.compact.measured.all.n, 3, 'all three drops seen');
  assert.equal(auto.compact.measured.all.median, 70000);
  assert.equal(auto.compact.measured.byProject.Alpha.n, 2);
  assert.equal(auto.compact.measured.byProject.Beta.n, 1);
  assert.equal(auto.compact.targetAuto, true);
  assert.equal(auto.compact.target, 70000, 'the measurement is what gets used');

  // Scoped to one project, and to one with too little evidence.
  const scoped = aggregate(records, '30d', PRICING, {},
    Object.assign({ compactTargetAuto: true, compactTargetScope: 'Beta' }, opts), {}, []);
  assert.equal(scoped.compact.targetAuto, false, 'one compaction is not enough to trust');
  assert.equal(scoped.compact.target, 20000, 'so the hand-set number is used');

  // Switched off, the hand-set number wins even with plenty measured.
  const manual = aggregate(records, '30d', PRICING, {}, Object.assign({ compactTargetAuto: false }, opts), {}, []);
  assert.equal(manual.compact.targetAuto, false);
  assert.equal(manual.compact.target, 20000);
  assert.equal(manual.compact.measured.all.n, 3, 'still reported, just not used');
});

test('a lone outlier cannot drag the measured post-compact size', async () => {
  const { aggregate } = require('../lib/scan');
  const now = Date.now();
  const PRICING = {
    cacheMultipliers: { write5m: 1.25, write1h: 2, read: 0.1 },
    default: { input: 5, output: 25 },
    models: {},
  };
  const turn = (session, cr, i) => ({
    session,
    project: 'Alpha',
    model: 'claude-opus-5',
    speed: null,
    ts: now - (100 - i) * 60000,
    agentId: null,
    sidechain: false,
    in: 0,
    out: 50,
    cw5: 0,
    cw1: 0,
    cr,
  });
  const run = (session, sizes) => sizes.map((c, i) => turn(session, c, i));
  // Two ordinary compactions and one context edit that happened to halve a
  // very large window. A mean would land near 160k; the median must not.
  const records = [
    ...run('s1', [300000, 60000]),
    ...run('s2', [400000, 70000]),
    ...run('s3', [900000, 350000]),
  ];
  const out = aggregate(records, '30d', PRICING, {},
    { compactThresholdTokens: 150000, compactTargetTokens: 20000, compactTargetAuto: true }, {}, []);
  assert.equal(out.compact.measured.all.n, 3);
  assert.equal(out.compact.measured.all.median, 70000);
  assert.equal(out.compact.measured.all.high, 350000, 'the outlier is still reported');
  assert.equal(out.compact.target, 70000);
});

test('every session reports its context size, not only the ones over the threshold', async () => {
  const { aggregate } = require('../lib/scan');
  const now = Date.now();
  const big = { in: 200, out: 50, cw5: 0, cw1: 0, cr: 400000 };
  const small = { in: 200, out: 50, cw5: 0, cw1: 0, cr: 1000 };
  const rec = (session, u) =>
    Object.assign(
      { session, project: 'P', model: 'claude-opus-5', speed: null, ts: now - 60000, agentId: null, sidechain: false },
      u
    );
  const records = [rec('hot', big), rec('cold', small)];
  const data = aggregate(records, '30d', { cacheMultipliers: { write5m: 1.25, write1h: 2, read: 0.1 }, default: { input: 5, output: 25 }, models: {} }, {}, {}, {}, []);

  assert.equal(data.compact.suggestions.length, 1, 'only the big session is suggested');
  assert.equal(data.compact.suggestions[0].session, 'hot');
  // Both are still reported, so the page can preview another threshold without
  // a round trip to the server.
  assert.equal(data.compact.contextSizes.length, 2);
  assert.ok(data.compact.contextSizes[0] > data.compact.contextSizes[1], 'biggest first');
  assert.equal(data.compact.contextSizes[1], 1200);
});

test('tool inputs yield the directories a session touched', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sess-1.jsonl');
  writeJsonl(file, [
    assistant({
      uuid: 'a1',
      message: Object.assign(assistant().message, {
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:\\work\\Alpha\\src\\index.js' } },
          // a Windows path with a space, only findable because it is quoted
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'cd "C:\\work\\My Proj\\lib" && ls' } },
          { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'cat C:\\work\\Alpha\\readme.md' } },
          { type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'echo no paths here' } },
        ],
      }),
    }),
  ]);
  const p = await parseFile(file);
  const hits = p.pathHits['sess-1'];
  assert.ok(hits, 'no path hits recorded');
  assert.equal(hits['C:\\work\\Alpha\\src'], 1);
  assert.equal(hits['C:\\work\\Alpha'], 1); // readme.md collapsed to its folder
  assert.equal(hits['C:\\work\\My Proj\\lib'], 1);
});

test('a file path collapses to its folder on either separator, root included', async () => {
  const root = tmpDir();
  const call = (input) => ({
    type: 'assistant',
    uuid: 'u-paths',
    sessionId: 'sess-paths',
    timestamp: '2026-09-04T10:00:00.000Z',
    cwd: 'C:\\work',
    message: {
      id: 'msg-paths',
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', id: 't1', name: 'Read', input }],
    },
  });
  const B = String.fromCharCode(92);
  writeJsonl(path.join(root, 's.jsonl'), [
    call({ file_path: 'C:' + B + 'work' + B + 'Alpha' + B + 'src' + B + 'a.js' }),
    call({ file_path: '/home/u/proj/b.js' }),
    call({ file_path: 'C:' + B + 'root.js' }),
    call({ file_path: '/root.js' }),
    call({ file_path: '/home/u/proj' }),
  ]);

  const out = await parseFile(path.join(root, 's.jsonl'));
  const hits = out.pathHits['sess-paths'];
  // Separator-agnostic: a Windows path must survive on a POSIX host too.
  assert.equal(hits['C:' + B + 'work' + B + 'Alpha' + B + 'src'], 1);
  assert.equal(hits['/home/u/proj'], 2, 'the file and the bare folder land together');
  // Root-level files keep a separator rather than collapsing to "" or "C:".
  assert.equal(hits['C:' + B], 1);
  assert.equal(hits['/'], 1);
  assert.equal(hits[''], undefined, 'no empty bucket');
  assert.equal(hits['.'], undefined, 'and never a relative one');
});

test('a session run from a workspace folder is attributed by the files it touched', async () => {
  const { scan } = require('../lib/scan');
  const ws = tmpDir();
  const alpha = path.join(ws, 'Alpha');
  const beta = path.join(ws, 'Beta');
  const gamma = path.join(ws, 'Gamma');
  for (const d of [alpha, beta, gamma]) fs.mkdirSync(path.join(d, 'src'), { recursive: true });

  const roots = fs.mkdtempSync(path.join(os.tmpdir(), 'claudinator-scan-'));
  const mk = (session, cwd, content) =>
    assistant({
      uuid: 'u-' + session,
      sessionId: session,
      cwd,
      requestId: 'req-' + session,
      message: Object.assign(assistant().message, { id: 'msg-' + session }, content ? { content } : {}),
    });

  // three sibling projects in use is what makes `ws` a workspace
  writeJsonl(path.join(roots, 'a.jsonl'), [mk('s-alpha', alpha)]);
  writeJsonl(path.join(roots, 'b.jsonl'), [mk('s-beta', beta)]);
  writeJsonl(path.join(roots, 'c.jsonl'), [mk('s-gamma', gamma)]);
  // and one session that ran in the workspace itself while editing Beta
  writeJsonl(path.join(roots, 'd.jsonl'), [
    mk('s-root', ws, [
      { type: 'tool_use', id: 'x1', name: 'Read', input: { file_path: path.join(beta, 'src', 'a.js') } },
      { type: 'tool_use', id: 'x2', name: 'Read', input: { file_path: path.join(beta, 'src', 'b.js') } },
      { type: 'tool_use', id: 'x3', name: 'Edit', input: { file_path: path.join(beta, 'readme.md') } },
    ]),
  ]);

  const on = await scan([roots], { minWorkspaceChildren: 3 });
  const rootRec = on.records.find((r) => r.session === 's-root');
  assert.equal(rootRec.project, 'Beta');
  assert.equal(rootRec.projectInferred, true);
  assert.equal(on.inferredProjects['s-root'].hits, 3);
  assert.equal(on.inferredProjects['s-root'].share, 1);
  // a session that really did run in its own project is untouched
  assert.equal(on.records.find((r) => r.session === 's-alpha').projectInferred, false);

  const off = await scan([roots], { minWorkspaceChildren: 3, inferProjectFromPaths: false });
  const plain = off.records.find((r) => r.session === 's-root');
  assert.equal(plain.project, path.basename(ws) + ' (root)');
  assert.equal(plain.projectInferred, false);
});
