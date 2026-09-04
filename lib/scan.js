'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'records.json');
const CACHE_VERSION = 5;
const DAY = 86400000;

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

function expandHome(p) {
  return String(p).replace(/^~(?=[\\/]|$)/, os.homedir());
}

function defaultRoots() {
  return [path.join(os.homedir(), '.claude', 'projects')];
}

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.warn('[claudinator] config.json is not valid JSON, ignoring:', err.message);
    }
  }
  let roots = Array.isArray(cfg.roots) && cfg.roots.length ? cfg.roots : defaultRoots();
  if (process.env.CLAUDINATOR_ROOTS) {
    roots = process.env.CLAUDINATOR_ROOTS.split(path.delimiter).filter(Boolean);
  }
  return {
    roots: roots.map(expandHome),
    port: Number(process.env.PORT || cfg.port || 8752),
    // Folders that hold many projects (auto-detected when omitted).
    workspaces: (cfg.workspaces || []).map(expandHome),
    // Folders that are always a project of their own, git or not.
    projectRoots: (cfg.projectRoots || []).map(expandHome),
    minWorkspaceChildren: Number(cfg.minWorkspaceChildren || 3),
    // A session whose latest prompt is at least this big gets a /compact suggestion.
    compactThresholdTokens: Number(cfg.compactThresholdTokens || 150000),
    // Rough context size right after /compact, used for the savings estimate.
    compactTargetTokens: Number(cfg.compactTargetTokens || 20000),
    // Sessions idle longer than this are still listed, but marked idle.
    compactIdleHours: Number(cfg.compactIdleHours || 48),
  };
}

function loadPricing() {
  const file = path.join(ROOT, 'pricing.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn('[claudinator] pricing.json unreadable, costs will be 0:', err.message);
    return {
      cacheMultipliers: { write5m: 1.25, write1h: 2, read: 0.1 },
      default: { input: 0, output: 0 },
      models: {},
    };
  }
}

/* ------------------------------------------------------------------ *
 * File discovery
 * ------------------------------------------------------------------ */

function walkJsonl(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkJsonl(full, out);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      out.push({ file: full, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    }
  }
  return out;
}

function discover(roots) {
  const out = [];
  for (const root of roots) walkJsonl(root, out);
  return out;
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

function decodeProjectDir(name) {
  // Claude Code encodes a cwd like C:\Users\me\Proj as C--Users-me-Proj.
  const sep = path.sep;
  return name.replace(/^([A-Za-z])--/, '$1:' + sep).replace(/-/g, sep);
}

// The folder Claude Code filed this transcript under, used when a record has no cwd.
function fallbackCwd(file) {
  let dir = path.dirname(file);
  // subagents/<x>.jsonl and <session>/subagents/... sit below the project folder
  for (let i = 0; i < 4; i++) {
    const base = path.basename(dir);
    if (/^[A-Za-z]--/.test(base) || /^-/.test(base)) return decodeProjectDir(base);
    dir = path.dirname(dir);
  }
  return path.basename(path.dirname(file));
}

const PROMPT_NOISE = /^\s*(<[a-z-]+[^>]*>|\[Request interrupted|\/[a-z-]+\s*$)/i;

function cleanPrompt(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || PROMPT_NOISE.test(t)) return null;
  return t.length > 140 ? t.slice(0, 137) + '…' : t;
}

// One pass over a file: usage records plus the links needed to name agents
// and title sessions.
//
// Subagent transcripts live in `<session>/subagents/agent-<agentId>.jsonl` and
// every line carries `agentId`. The spawning session holds the other half of
// the link: an `Agent`/`Task` tool_use (which knows the subagent_type) and the
// matching tool_result whose `toolUseResult.agentId` names the subagent.
function parseFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { records: [], toolUses: {}, agentLinks: {}, sessions: {}, error: err.message };
  }

  const toolUses = {}; // tool_use id -> { type, desc }
  const agentLinks = {}; // agentId -> { toolUseId, desc }
  const sessions = {}; // sessionId -> { title, prompt }
  const seen = new Map();

  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    const msg = o.message;
    const sid = o.sessionId;

    if (sid && !o.isSidechain) {
      const s = sessions[sid] || (sessions[sid] = { title: null, prompt: null });
      if (o.customTitle && !s.title) s.title = String(o.customTitle).slice(0, 140);
      if (
        !s.prompt &&
        o.type === 'user' &&
        !o.attachment &&
        !o.isMeta &&
        msg &&
        typeof msg.content === 'string'
      ) {
        s.prompt = cleanPrompt(msg.content);
      }
    }

    if (msg && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (!c) continue;
        if (c.type === 'tool_use' && (c.name === 'Agent' || c.name === 'Task') && c.id) {
          toolUses[c.id] = {
            type: (c.input && c.input.subagent_type) || null,
            desc: (c.input && c.input.description) || null,
          };
        }
        if (o.toolUseResult && o.toolUseResult.agentId && c.tool_use_id) {
          agentLinks[o.toolUseResult.agentId] = {
            toolUseId: c.tool_use_id,
            desc: o.toolUseResult.description || null,
          };
        }
      }
    }

    if (!msg) continue;
    const u = msg.usage;
    if (!u || !o.timestamp) continue;
    // Synthetic messages (local errors, interrupts) are not API calls.
    if (msg.model === '<synthetic>') continue;

    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) continue;

    const creation = u.cache_creation || {};
    const rec = {
      key: (msg.id || o.uuid) + '|' + (o.requestId || ''),
      ts,
      model: msg.model || 'unknown',
      speed: u.speed || 'standard',
      session: sid || path.basename(file, '.jsonl'),
      sidechain: !!o.isSidechain,
      agentId: o.agentId || null,
      cwd: o.cwd ? String(o.cwd).replace(/[\\/]+$/, '') : fallbackCwd(file),
      in: u.input_tokens || 0,
      out: u.output_tokens || 0,
      think: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
      cw5: creation.ephemeral_5m_input_tokens || 0,
      cw1: creation.ephemeral_1h_input_tokens || 0,
      cr: u.cache_read_input_tokens || 0,
      webSearch: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0,
      webFetch: (u.server_tool_use && u.server_tool_use.web_fetch_requests) || 0,
    };
    // Older transcripts have no 5m/1h breakdown; treat the lot as a 5m write.
    const cc = u.cache_creation_input_tokens || 0;
    if (!rec.cw5 && !rec.cw1 && cc) rec.cw5 = cc;
    // The same message id is written once per streamed content block: last wins.
    seen.set(rec.key, rec);
  }

  return { records: [...seen.values()], toolUses, agentLinks, sessions, error: null };
}

/* ------------------------------------------------------------------ *
 * Project resolution
 *
 * A record's cwd is wherever the session happened to be, often a subfolder.
 * Roll it up to something a human calls "the project":
 *   1. the enclosing git repository, when there is one;
 *   2. else the shallowest observed ancestor that is not a workspace, where a
 *      workspace is a folder with several distinct project subfolders in use
 *      (e.g. ~/Desktop/Cursor Projects);
 *   3. else the cwd itself.
 * ------------------------------------------------------------------ */

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function ancestorsOf(p) {
  const out = [];
  let cur = p;
  for (;;) {
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    out.push(parent);
    cur = parent;
  }
  return out; // nearest first
}

function normKey(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isInside(child, parent) {
  const c = normKey(child);
  const p = normKey(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function firstSegmentBelow(child, parent) {
  const rel = child.slice(parent.length).replace(/^[\\/]+/, '');
  return rel.split(/[\\/]/)[0] || '';
}

function buildProjectResolver(cwds, cfg) {
  const opts = Object.assign({ workspaces: [], projectRoots: [], minWorkspaceChildren: 3 }, cfg);
  const distinct = [...new Set(cwds)];

  // 1. git roots (deepest .git wins, so nested repos stay separate)
  const gitRoot = new Map(); // cwd -> root | null
  const gitCheck = new Map(); // dir -> bool
  const hasGit = (dir) => {
    const k = normKey(dir);
    if (!gitCheck.has(k)) gitCheck.set(k, fs.existsSync(path.join(dir, '.git')));
    return gitCheck.get(k);
  };
  for (const cwd of distinct) {
    let root = null;
    for (const dir of [cwd, ...ancestorsOf(cwd)]) {
      if (hasGit(dir)) {
        root = dir;
        break;
      }
    }
    gitRoot.set(cwd, root);
  }

  // 2. workspaces: explicit, plus any observed folder (or ancestor) with
  //    >= N distinct first-level children in use.
  const observed = new Set(distinct.map(normKey));
  const pinnedRoots = new Set(opts.projectRoots.map(normKey));
  const childSets = new Map(); // ancestor key -> { path, children:Set }
  for (const cwd of distinct) {
    for (const anc of ancestorsOf(cwd)) {
      const k = normKey(anc);
      let e = childSets.get(k);
      if (!e) {
        e = { path: anc, children: new Set() };
        childSets.set(k, e);
      }
      e.children.add(normKey(firstSegmentBelow(cwd, anc)));
    }
  }
  const workspaces = new Set(opts.workspaces.map(normKey));
  for (const [k, e] of childSets) {
    if (pinnedRoots.has(k) || hasGit(e.path)) continue; // a repo is never a workspace
    if (e.children.size >= opts.minWorkspaceChildren) workspaces.add(k);
  }

  const cache = new Map();
  return function resolve(cwd) {
    if (cache.has(cwd)) return cache.get(cwd);
    let root = null;

    for (const dir of [cwd, ...ancestorsOf(cwd)]) {
      if (pinnedRoots.has(normKey(dir))) {
        root = dir;
        break;
      }
    }
    if (!root) root = gitRoot.get(cwd) || null;
    if (!root) {
      // shallowest observed ancestor-or-self that is not a workspace
      const chain = [cwd, ...ancestorsOf(cwd)].reverse(); // shallowest first
      for (const dir of chain) {
        const k = normKey(dir);
        if (observed.has(k) && !workspaces.has(k)) {
          root = dir;
          break;
        }
      }
    }
    if (!root) root = cwd;

    const workspace = workspaces.has(normKey(root));
    const base = path.basename(root) || root;
    // Sessions started in a workspace folder itself belong to no single project.
    const res = { label: workspace ? base + ' (root)' : base, path: root, workspace };
    cache.set(cwd, res);
    return res;
  };
}

/* ------------------------------------------------------------------ *
 * Cache, keyed on each file's size + mtime
 * ------------------------------------------------------------------ */

function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c.version === CACHE_VERSION) return c.files || {};
  } catch {
    /* no usable cache yet */
  }
  return {};
}

function writeCache(files) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: CACHE_VERSION, files }));
  } catch (err) {
    console.warn('[claudinator] could not write cache:', err.message);
  }
}

let memCache = null;

/**
 * Scan every transcript, reusing cached results for files that have not
 * changed. Returns deduped usage records with agent + project attribution.
 */
function scan(roots, cfg) {
  const started = Date.now();
  if (!memCache) memCache = readCache();

  const found = discover(roots);
  const nextCache = {};
  let parsed = 0;
  let cached = 0;

  const toolUses = {};
  const agentLinks = {};
  const sessionMeta = {};
  const records = [];

  for (const f of found) {
    const stamp = f.size + ':' + f.mtimeMs;
    const hit = memCache[f.file];
    let entry;
    if (hit && hit.stamp === stamp) {
      entry = hit;
      cached++;
    } else {
      const p = parseFile(f.file);
      entry = {
        stamp,
        records: p.records,
        toolUses: p.toolUses,
        agentLinks: p.agentLinks,
        sessions: p.sessions,
      };
      parsed++;
    }
    nextCache[f.file] = entry;
    Object.assign(toolUses, entry.toolUses);
    Object.assign(agentLinks, entry.agentLinks);
    for (const sid in entry.sessions) {
      const s = entry.sessions[sid];
      const m = sessionMeta[sid] || (sessionMeta[sid] = { title: null, prompt: null });
      if (!m.title && s.title) m.title = s.title;
      if (!m.prompt && s.prompt) m.prompt = s.prompt;
    }
    for (const r of entry.records) records.push(r);
  }

  const removed = Object.keys(memCache).length !== Object.keys(nextCache).length;
  memCache = nextCache;
  if (parsed || removed) writeCache(nextCache);

  // Dedupe across files too: a transcript may also sit in an archive folder.
  const byKey = new Map();
  for (const r of records) if (!byKey.has(r.key)) byKey.set(r.key, r);
  const unique = [...byKey.values()].sort((a, b) => a.ts - b.ts);

  // Name each subagent run from the Agent/Task call that launched it.
  for (const r of unique) {
    if (!r.agentId && !r.sidechain) {
      r.agent = 'main thread';
      r.agentTask = null;
      continue;
    }
    const link = r.agentId ? agentLinks[r.agentId] : null;
    const call = link && toolUses[link.toolUseId];
    r.agent = (call && call.type) || 'subagent';
    r.agentTask = (link && link.desc) || (call && call.desc) || null;
  }

  // Roll every cwd up to its project.
  const resolve = buildProjectResolver(
    unique.map((r) => r.cwd),
    cfg || {}
  );
  for (const r of unique) {
    const p = resolve(r.cwd);
    r.project = p.label;
    r.projectPath = p.path;
  }

  return {
    records: unique,
    sessionMeta,
    stats: {
      roots,
      files: found.length,
      filesParsed: parsed,
      filesCached: cached,
      bytes: found.reduce((s, f) => s + f.size, 0),
      records: unique.length,
      scanMs: Date.now() - started,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

const RANGES = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
  '180d': 180,
  '365d': 365,
  all: null,
};

function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function costOf(rec, pricing) {
  const m = pricing.models[rec.model] || pricing.default || { input: 0, output: 0 };
  const rates = rec.speed === 'fast' && m.fast ? m.fast : m;
  const mult = pricing.cacheMultipliers || { write5m: 1.25, write1h: 2, read: 0.1 };
  const inR = (rates.input || 0) / 1e6;
  const outR = (rates.output || 0) / 1e6;
  return (
    rec.in * inR +
    rec.out * outR +
    rec.cw5 * inR * mult.write5m +
    rec.cw1 * inR * mult.write1h +
    rec.cr * inR * mult.read
  );
}

function tokensOf(rec) {
  return rec.in + rec.out + rec.cw5 + rec.cw1 + rec.cr;
}

function blankBucket(extra) {
  return Object.assign(
    {
      input: 0,
      output: 0,
      thinking: 0,
      cacheWrite: 0,
      cacheRead: 0,
      total: 0,
      cost: 0,
      messages: 0,
    },
    extra
  );
}

function addTo(bucket, rec, cost) {
  bucket.input += rec.in;
  bucket.output += rec.out;
  bucket.thinking += rec.think;
  bucket.cacheWrite += rec.cw5 + rec.cw1;
  bucket.cacheRead += rec.cr;
  bucket.total += tokensOf(rec);
  bucket.cost += cost;
  bucket.messages += 1;
}

// Small per-key slice used for stacking the daily chart by project / agent.
function addSlice(obj, key, rec, cost) {
  const s = obj[key] || (obj[key] = { total: 0, cost: 0, output: 0 });
  s.total += tokensOf(rec);
  s.cost += cost;
  s.output += rec.out;
}

function groupList(map) {
  const list = [...map.entries()].map(([name, v]) => {
    const o = Object.assign({ name }, v);
    for (const k in o) if (o[k] instanceof Set) o[k] = o[k].size;
    return o;
  });
  list.sort((a, b) => b.total - a.total);
  return list;
}

function windowFor(range, now) {
  const days = RANGES[range] === undefined ? 30 : RANGES[range];
  if (days === null) return { days, from: -Infinity, prevFrom: null };
  const from = startOfDay(now) - (days - 1) * DAY;
  return { days, from, prevFrom: from - days * DAY };
}

function aggregate(records, range, pricing, sessionMeta, opts) {
  const meta = sessionMeta || {};
  const now = Date.now();
  const { days, from, prevFrom } = windowFor(range, now);

  const sel = [];
  const previous = prevFrom === null ? null : blankBucket();
  for (const r of records) {
    if (r.ts >= from) sel.push(r);
    else if (previous && r.ts >= prevFrom) addTo(previous, r, costOf(r, pricing));
  }

  const totals = blankBucket({ webSearch: 0, webFetch: 0 });
  const daily = new Map();
  const projects = new Map();
  const agents = new Map();
  const agentRuns = new Map();
  const models = new Map();
  const sessions = new Map();
  const hours = Array.from({ length: 24 }, () => blankBucket());
  const weekdays = Array.from({ length: 7 }, () => blankBucket());

  const bump = (map, name, rec, cost, seed) => {
    let b = map.get(name);
    if (!b) {
      b = blankBucket(seed ? seed() : undefined);
      map.set(name, b);
    }
    addTo(b, rec, cost);
    return b;
  };

  for (const r of sel) {
    const cost = costOf(r, pricing);
    addTo(totals, r, cost);
    totals.webSearch += r.webSearch;
    totals.webFetch += r.webFetch;

    const d = dayKey(r.ts);
    let day = daily.get(d);
    if (!day) {
      day = blankBucket({ date: d, sessions: new Set(), byProject: {}, byModel: {} });
      daily.set(d, day);
    }
    addTo(day, r, cost);
    day.sessions.add(r.session);
    addSlice(day.byProject, r.project, r, cost);
    addSlice(day.byModel, r.model, r, cost);

    const pb = bump(projects, r.project, r, cost, () => ({
      path: r.projectPath,
      sessions: new Set(),
      cwds: new Set(),
    }));
    pb.sessions.add(r.session);
    pb.cwds.add(r.cwd);

    const ab = bump(agents, r.agent || 'main thread', r, cost, () => ({ sessions: new Set() }));
    ab.sessions.add(r.session);

    if (r.agentId || r.sidechain) {
      const runKey = r.agentTask || (r.agent || 'subagent') + ' run';
      const rb = bump(agentRuns, runKey, r, cost, () => ({
        agent: r.agent || 'subagent',
        project: r.project,
        first: r.ts,
        last: r.ts,
      }));
      rb.first = Math.min(rb.first, r.ts);
      rb.last = Math.max(rb.last, r.ts);
    }

    bump(models, r.model, r, cost);

    const sb = bump(sessions, r.session, r, cost, () => ({
      project: r.project,
      projectTokens: {},
      first: r.ts,
      last: r.ts,
      contextNow: 0,
    }));
    sb.first = Math.min(sb.first, r.ts);
    sb.last = Math.max(sb.last, r.ts);
    if (!r.sidechain && !r.agentId) sb.contextNow = contextOf(r);
    sb.projectTokens[r.project] = (sb.projectTokens[r.project] || 0) + tokensOf(r);

    addTo(hours[new Date(r.ts).getHours()], r, cost);
    addTo(weekdays[new Date(r.ts).getDay()], r, cost);
  }

  let series = [...daily.values()].map((d) => {
    d.sessions = d.sessions.size;
    return d;
  });
  series.sort((a, b) => (a.date < b.date ? -1 : 1));

  // Fill gaps so the chart shows one column per day in the window.
  if (series.length) {
    const firstTs = sel.length ? startOfDay(sel[0].ts) : startOfDay(now);
    const startTs = days === null ? firstTs : from;
    const have = new Map(series.map((d) => [d.date, d]));
    const filled = [];
    for (let t = startTs; t <= now; t += DAY) {
      const k = dayKey(t);
      filled.push(have.get(k) || blankBucket({ date: k, sessions: 0, byProject: {}, byModel: {} }));
    }
    series = filled;
  }

  const bestDays = series
    .filter((d) => d.total > 0)
    .slice()
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const activeDays = series.filter((d) => d.total > 0).length;

  // Label each session with the project it spent the most tokens in, and a title.
  const sessionList = groupList(sessions).slice(0, 25);
  for (const s of sessionList) {
    const pt = s.projectTokens || {};
    let best = s.project;
    let bestVal = -1;
    for (const k in pt) {
      if (pt[k] > bestVal) {
        bestVal = pt[k];
        best = k;
      }
    }
    s.project = best;
    delete s.projectTokens;
    const m = meta[s.name] || {};
    s.title = m.title || m.prompt || null;
  }

  const projectList = groupList(projects).map((p) => {
    const cwds = projects.get(p.name).cwds;
    p.cwdList = [...cwds].slice(0, 8);
    return p;
  });

  const cacheable = totals.input + totals.cacheWrite + totals.cacheRead;

  return {
    range,
    days,
    from: days === null ? (sel.length ? sel[0].ts : now) : from,
    to: now,
    generatedAt: now,
    totals,
    previous,
    cacheHitRate: cacheable ? totals.cacheRead / cacheable : 0,
    sessionCount: sessions.size,
    activeDays,
    avgPerActiveDay: activeDays ? totals.total / activeDays : 0,
    costPerActiveDay: activeDays ? totals.cost / activeDays : 0,
    series,
    bestDays,
    projects: projectList,
    agents: groupList(agents),
    agentRuns: groupList(agentRuns).slice(0, 25),
    models: groupList(models),
    sessions: sessionList,
    compact: compactSuggestions(sel, pricing, meta, opts, now),
    hours: hours.map((h, i) => Object.assign({ hour: i }, h)),
    weekdays: weekdays.map((w, i) => Object.assign({ day: i }, w)),
  };
}

/* ------------------------------------------------------------------ *
 * /compact suggestions
 *
 * Every main-thread turn re-reads the whole discussion, so a session's cost
 * per message tracks its context size. The context a turn was answered with
 * is that record's input + cache write + cache read. Flag sessions whose
 * latest context is above the threshold; detect earlier compactions as a
 * sharp drop between consecutive turns.
 * ------------------------------------------------------------------ */

function contextOf(rec) {
  return rec.in + rec.cw5 + rec.cw1 + rec.cr;
}

function compactSuggestions(sel, pricing, sessionMeta, opts, now) {
  const o = Object.assign(
    { compactThresholdTokens: 150000, compactTargetTokens: 20000, compactIdleHours: 48 },
    opts || {}
  );
  const meta = sessionMeta || {};
  const bySession = new Map();

  for (const r of sel) {
    if (r.sidechain || r.agentId) continue; // subagents have their own context
    let s = bySession.get(r.session);
    if (!s) {
      s = {
        session: r.session,
        project: r.project,
        model: r.model,
        speed: r.speed,
        messages: 0,
        firstTs: r.ts,
        lastTs: r.ts,
        lastCtx: 0,
        peakCtx: 0,
        compactions: 0,
        lastCompactionTs: null,
        recent: [], // last 10 turns' cost
        early: [], // first 10 turns' cost
        aboveThreshold: 0,
      };
      bySession.set(r.session, s);
    }
    const ctx = contextOf(r);
    const cost = costOf(r, pricing);
    if (s.lastCtx > 50000 && ctx < s.lastCtx * 0.5) {
      s.compactions++;
      s.lastCompactionTs = r.ts;
    }
    s.messages++;
    s.lastTs = r.ts;
    s.lastCtx = ctx;
    s.model = r.model;
    s.speed = r.speed;
    s.project = r.project;
    s.peakCtx = Math.max(s.peakCtx, ctx);
    if (ctx >= o.compactThresholdTokens) s.aboveThreshold++;
    if (s.early.length < 10) s.early.push(cost);
    s.recent.push(cost);
    if (s.recent.length > 10) s.recent.shift();
  }

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const out = [];
  for (const s of bySession.values()) {
    if (s.lastCtx < o.compactThresholdTokens) continue;
    const excess = Math.max(0, s.lastCtx - o.compactTargetTokens);
    const savePerMsg = costOf(
      { model: s.model, speed: s.speed, in: 0, out: 0, cw5: 0, cw1: 0, cr: excess },
      pricing
    );
    const m = meta[s.session] || {};
    const idleHours = (now - s.lastTs) / 3600000;
    out.push({
      session: s.session,
      title: m.title || m.prompt || null,
      project: s.project,
      model: s.model,
      messages: s.messages,
      lastActivity: s.lastTs,
      idleHours: Math.round(idleHours * 10) / 10,
      idle: idleHours > o.compactIdleHours,
      contextNow: s.lastCtx,
      contextPeak: s.peakCtx,
      turnsAboveThreshold: s.aboveThreshold,
      compactions: s.compactions,
      lastCompaction: s.lastCompactionTs,
      costPerMsgNow: avg(s.recent),
      costPerMsgEarly: avg(s.early),
      savePerMsg,
      saveNext50: savePerMsg * 50,
    });
  }
  // Active sessions first, then by how much is at stake per message.
  out.sort((a, b) => (a.idle !== b.idle ? (a.idle ? 1 : -1) : b.savePerMsg - a.savePerMsg));

  return {
    threshold: o.compactThresholdTokens,
    target: o.compactTargetTokens,
    idleHours: o.compactIdleHours,
    sessionsChecked: bySession.size,
    suggestions: out,
  };
}

function toCsv(data) {
  const cols = ['date', 'input', 'output', 'thinking', 'cacheWrite', 'cacheRead', 'total', 'messages', 'sessions', 'cost'];
  const lines = [cols.join(',')];
  for (const d of data.series) {
    lines.push(cols.map((c) => (c === 'cost' ? d.cost.toFixed(4) : d[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  loadConfig,
  loadPricing,
  scan,
  aggregate,
  toCsv,
  RANGES,
  // exported for tests
  parseFile,
  buildProjectResolver,
  costOf,
};
