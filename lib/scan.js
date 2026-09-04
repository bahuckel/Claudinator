'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'records.json');
const MARKS_FILE = path.join(ROOT, 'compact-marks.json');
const CACHE_VERSION = 6;
const DAY = 86400000;

// Tool results smaller than this never move the needle on context size.
const MIN_TOOL_CHARS = 400;
// Rough chars-per-token for sizing tool output. Deliberately crude; labelled
// as an estimate everywhere it surfaces.
const CHARS_PER_TOKEN = 4;

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
    // "I compacted this" marks are forgotten after this many days.
    markRetentionDays: Number(cfg.markRetentionDays || 7),
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

/**
 * Read one transcript line by line — transcripts reach hundreds of megabytes,
 * so the whole file is never held in memory.
 *
 * Subagent transcripts live in `<session>/subagents/agent-<agentId>.jsonl` and
 * every line carries `agentId`. The spawning session holds the other half of
 * the link: an `Agent`/`Task` tool_use (which knows the subagent_type) and the
 * matching tool_result whose `toolUseResult.agentId` names the subagent.
 */
async function parseFile(file) {
  const toolUses = {}; // Agent/Task tool_use id -> { type, desc }
  const agentLinks = {}; // agentId -> { toolUseId, desc }
  const sessions = {}; // sessionId -> { title, prompt }
  const toolCalls = []; // { s: session, t: ts, n: tool name, c: chars }
  const toolNames = new Map(); // any tool_use id -> tool name
  const seen = new Map();

  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' });
  } catch (err) {
    return { records: [], toolUses, agentLinks, sessions, toolCalls, error: err.message };
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
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
          if (c.type === 'tool_use' && c.id) {
            toolNames.set(c.id, c.name || 'unknown');
            if ((c.name === 'Agent' || c.name === 'Task') && c.input) {
              toolUses[c.id] = {
                type: c.input.subagent_type || null,
                desc: c.input.description || null,
              };
            }
          }
          if (c.type === 'tool_result' && c.tool_use_id && line.length >= MIN_TOOL_CHARS) {
            // The serialized line is a good proxy for how much this result
            // adds to the context that every later turn re-reads.
            toolCalls.push({
              s: sid || path.basename(file, '.jsonl'),
              t: Date.parse(o.timestamp) || 0,
              n: toolNames.get(c.tool_use_id) || 'unknown',
              c: line.length,
              a: o.agentId || (o.isSidechain ? 'sub' : null),
            });
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
        effort: o.effort || 'unset',
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
  } catch (err) {
    return { records: [], toolUses, agentLinks, sessions, toolCalls, error: err.message };
  } finally {
    rl.close();
    stream.destroy();
  }

  return { records: [...seen.values()], toolUses, agentLinks, sessions, toolCalls, error: null };
}

/* ------------------------------------------------------------------ *
 * Project resolution
 *
 * A record's cwd is wherever the session happened to be, often a subfolder.
 * Roll it up to something a human calls "the project":
 *   1. the enclosing git repository, when there is one;
 *   2. else the shallowest observed ancestor that is not a workspace, where a
 *      workspace is a folder with several distinct project subfolders in use
 *      (e.g. ~/Desktop/Projects);
 *   3. else the cwd itself.
 * ------------------------------------------------------------------ */

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

  // 2. workspaces: explicit, plus any observed folder with >= N distinct
  //    first-level children in use.
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
 * Compaction marks
 *
 * "I compacted this session at time T": everything before T stops counting,
 * so the suggestion starts again from the click. { sessionId: epochMs }.
 * ------------------------------------------------------------------ */

/**
 * Marks expire so the list cannot grow forever: after `retentionDays` a mark
 * is dropped and the session counts from its beginning again. Expired entries
 * are pruned from the file on read, not just hidden.
 */
function loadMarks(retentionDays) {
  let m;
  try {
    m = JSON.parse(fs.readFileSync(MARKS_FILE, 'utf8'));
  } catch {
    return {};
  }
  const keep = Number(retentionDays) > 0 ? Date.now() - retentionDays * DAY : -Infinity;
  const out = {};
  let expired = 0;
  for (const k in m) {
    if (!Number.isFinite(m[k])) continue;
    if (m[k] < keep) expired++;
    else out[k] = m[k];
  }
  if (expired) {
    try {
      saveMarks(out);
    } catch {
      /* read-only disk: still report the pruned set */
    }
  }
  return out;
}

function saveMarks(marks) {
  fs.writeFileSync(MARKS_FILE, JSON.stringify(marks, null, 2));
}

function setMark(session, ts) {
  const marks = loadMarks();
  if (ts === null) delete marks[session];
  else marks[session] = ts;
  saveMarks(marks);
  return marks;
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
async function scan(roots, cfg) {
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
  const toolCalls = [];

  for (const f of found) {
    const stamp = f.size + ':' + f.mtimeMs;
    const hit = memCache[f.file];
    let entry;
    if (hit && hit.stamp === stamp) {
      entry = hit;
      cached++;
    } else {
      const p = await parseFile(f.file);
      entry = {
        stamp,
        records: p.records,
        toolUses: p.toolUses,
        agentLinks: p.agentLinks,
        sessions: p.sessions,
        toolCalls: p.toolCalls,
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
    for (const t of entry.toolCalls || []) toolCalls.push(t);
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

  toolCalls.sort((a, b) => a.t - b.t);

  return {
    records: unique,
    sessionMeta,
    toolCalls,
    stats: {
      roots,
      files: found.length,
      filesParsed: parsed,
      filesCached: cached,
      bytes: found.reduce((s, f) => s + f.size, 0),
      records: unique.length,
      toolResults: toolCalls.length,
      scanMs: Date.now() - started,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Pricing
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

// Rates for a model, and whether pricing.json actually knows it. An unknown
// model silently priced at the default rate is how a bill estimate goes wrong
// by 5x, so callers surface `known: false`.
function ratesFor(rec, pricing) {
  const known = Object.prototype.hasOwnProperty.call(pricing.models || {}, rec.model);
  const m = (pricing.models || {})[rec.model] || pricing.default || { input: 0, output: 0 };
  const rates = rec.speed === 'fast' && m.fast ? m.fast : m;
  return { rates, known };
}

function costOf(rec, pricing) {
  const { rates } = ratesFor(rec, pricing);
  const mult = pricing.cacheMultipliers || { write5m: 1.25, write1h: 2, read: 0.1 };
  const st = pricing.serverTools || { webSearchPer1k: 0, webFetchPer1k: 0 };
  const inR = (rates.input || 0) / 1e6;
  const outR = (rates.output || 0) / 1e6;
  return (
    rec.in * inR +
    rec.out * outR +
    (rec.cw5 || 0) * inR * mult.write5m +
    (rec.cw1 || 0) * inR * mult.write1h +
    (rec.cr || 0) * inR * mult.read +
    ((rec.webSearch || 0) * (st.webSearchPer1k || 0)) / 1000 +
    ((rec.webFetch || 0) * (st.webFetchPer1k || 0)) / 1000
  );
}

function tokensOf(rec) {
  return rec.in + rec.out + rec.cw5 + rec.cw1 + rec.cr;
}

function contextOf(rec) {
  return rec.in + rec.cw5 + rec.cw1 + rec.cr;
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

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

// Small per-key slice used for stacking the daily chart.
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

const FILTERABLE = ['project', 'agent', 'model', 'session', 'effort'];

function makeFilter(filter) {
  const active = [];
  for (const k of FILTERABLE) {
    if (filter && filter[k]) active.push([k, String(filter[k])]);
  }
  if (!active.length) return { predicate: null, active: null };
  return {
    predicate: (r) => active.every(([k, v]) => String(r[k]) === v),
    active: Object.fromEntries(active),
  };
}

/**
 * Cache writes that nothing ever read back.
 *
 * A 5-minute write only pays off if the same conversation asks again within
 * five minutes; an hour write within the hour. Conversations are keyed by
 * session plus subagent, because a subagent has its own context.
 */
function cacheWaste(sel, pricing) {
  const convos = new Map();
  for (const r of sel) {
    const key = r.session + '|' + (r.agentId || (r.sidechain ? 'sub' : ''));
    let list = convos.get(key);
    if (!list) convos.set(key, (list = []));
    list.push(r);
  }
  const mult = pricing.cacheMultipliers || { write5m: 1.25, write1h: 2 };
  let tokens = 0;
  let cost = 0;
  let writes = 0;
  for (const list of convos.values()) {
    list.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r.cw5 && !r.cw1) continue;
      writes++;
      const next = list[i + 1];
      const gap = next ? next.ts - r.ts : Infinity;
      const { rates } = ratesFor(r, pricing);
      const inR = (rates.input || 0) / 1e6;
      if (r.cw5 && gap > 5 * 60000) {
        tokens += r.cw5;
        cost += r.cw5 * inR * mult.write5m;
      }
      if (r.cw1 && gap > 60 * 60000) {
        tokens += r.cw1;
        cost += r.cw1 * inR * mult.write1h;
      }
    }
  }
  return { tokens, cost, writes };
}

/** Tool output volume, overall and per conversation. */
function toolStats(toolCalls, from, to, sessions) {
  const overall = new Map();
  const perSession = new Map();
  for (const t of toolCalls) {
    if (t.t < from || t.t > to) continue;
    if (sessions && !sessions.has(t.s)) continue;
    const o = overall.get(t.n) || { name: t.n, chars: 0, calls: 0 };
    o.chars += t.c;
    o.calls++;
    overall.set(t.n, o);

    let s = perSession.get(t.s);
    if (!s) perSession.set(t.s, (s = new Map()));
    const e = s.get(t.n) || { name: t.n, chars: 0, calls: 0 };
    e.chars += t.c;
    e.calls++;
    s.set(t.n, e);
  }
  const list = [...overall.values()]
    .map((o) => Object.assign({ tokens: Math.round(o.chars / CHARS_PER_TOKEN) }, o))
    .sort((a, b) => b.chars - a.chars);
  return { list, perSession };
}

function compactSuggestions(sel, pricing, sessionMeta, opts, now, marks, toolCalls) {
  const o = Object.assign(
    {
      compactThresholdTokens: 150000,
      compactTargetTokens: 20000,
      compactIdleHours: 48,
      markRetentionDays: 7,
    },
    opts || {}
  );
  const meta = sessionMeta || {};
  const marked = marks || {};
  const bySession = new Map();

  // Group main-thread turns per session; subagents carry their own context.
  for (const r of sel) {
    if (r.sidechain || r.agentId) continue;
    let turns = bySession.get(r.session);
    if (!turns) bySession.set(r.session, (turns = []));
    turns.push(r);
  }

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const out = [];
  const markList = [];

  for (const [session, all] of bySession) {
    const markedAt = marked[session] || 0;
    const turns = markedAt ? all.filter((r) => r.ts > markedAt) : all;
    const m = meta[session] || {};

    if (markedAt) {
      const last = all[all.length - 1];
      markList.push({
        session,
        title: m.title || m.prompt || null,
        project: last.project,
        markedAt,
        expiresAt: o.markRetentionDays > 0 ? markedAt + o.markRetentionDays * DAY : null,
        turnsSince: turns.length,
      });
    }
    if (!turns.length) continue;

    const last = turns[turns.length - 1];
    const lastCtx = contextOf(last);
    if (lastCtx < o.compactThresholdTokens) continue;

    let peakCtx = 0;
    let aboveThreshold = 0;
    let compactions = 0;
    let lastCompactionTs = null;
    let prevCtx = 0;
    const costs = [];
    for (const r of turns) {
      const ctx = contextOf(r);
      if (prevCtx > 50000 && ctx < prevCtx * 0.5) {
        compactions++;
        lastCompactionTs = r.ts;
      }
      prevCtx = ctx;
      peakCtx = Math.max(peakCtx, ctx);
      if (ctx >= o.compactThresholdTokens) aboveThreshold++;
      costs.push(costOf(r, pricing));
    }

    // What is actually sitting in that context: tool output since the mark.
    const tools = new Map();
    for (const t of toolCalls || []) {
      if (t.s !== session || t.a) continue; // main thread only
      if (t.t <= markedAt || t.t > last.ts) continue;
      const e = tools.get(t.n) || { name: t.n, chars: 0, calls: 0 };
      e.chars += t.c;
      e.calls++;
      tools.set(t.n, e);
    }
    const toolList = [...tools.values()]
      .map((e) => Object.assign({ tokens: Math.round(e.chars / CHARS_PER_TOKEN) }, e))
      .sort((a, b) => b.chars - a.chars);
    const toolTokens = toolList.reduce((s, e) => s + e.tokens, 0);

    const excess = Math.max(0, lastCtx - o.compactTargetTokens);
    const savePerMsg = costOf(
      { model: last.model, speed: last.speed, in: 0, out: 0, cw5: 0, cw1: 0, cr: excess },
      pricing
    );
    const idleHours = (now - last.ts) / 3600000;
    out.push({
      session,
      title: m.title || m.prompt || null,
      project: last.project,
      model: last.model,
      messages: turns.length,
      markedAt: markedAt || null,
      lastActivity: last.ts,
      idleHours: Math.round(idleHours * 10) / 10,
      idle: idleHours > o.compactIdleHours,
      contextNow: lastCtx,
      contextPeak: peakCtx,
      turnsAboveThreshold: aboveThreshold,
      compactions,
      lastCompaction: lastCompactionTs,
      costPerMsgNow: avg(costs.slice(-10)),
      costPerMsgEarly: avg(costs.slice(0, 10)),
      savePerMsg,
      saveNext50: savePerMsg * 50,
      toolTokens,
      toolShare: lastCtx ? Math.min(1, toolTokens / lastCtx) : 0,
      topTools: toolList.slice(0, 3),
    });
  }
  // Active sessions first, then by how much is at stake per message.
  out.sort((a, b) => (a.idle !== b.idle ? (a.idle ? 1 : -1) : b.savePerMsg - a.savePerMsg));
  markList.sort((a, b) => b.markedAt - a.markedAt);

  return {
    threshold: o.compactThresholdTokens,
    target: o.compactTargetTokens,
    idleHours: o.compactIdleHours,
    markRetentionDays: o.markRetentionDays,
    sessionsChecked: bySession.size,
    suggestions: out,
    marks: markList,
  };
}

function aggregate(records, range, pricing, sessionMeta, opts, marks, toolCalls, filter) {
  const meta = sessionMeta || {};
  const now = Date.now();
  const { days, from, prevFrom } = windowFor(range, now);
  const { predicate, active } = makeFilter(filter);

  const sel = [];
  const previous = prevFrom === null ? null : blankBucket();
  for (const r of records) {
    if (predicate && !predicate(r)) continue;
    if (r.ts >= from) sel.push(r);
    else if (previous && r.ts >= prevFrom) addTo(previous, r, costOf(r, pricing));
  }

  const totals = blankBucket({ webSearch: 0, webFetch: 0, fastMessages: 0, fastCost: 0 });
  const daily = new Map();
  const projects = new Map();
  const agents = new Map();
  const agentRuns = new Map();
  const models = new Map();
  const efforts = new Map();
  const sessions = new Map();
  const hours = Array.from({ length: 24 }, () => blankBucket());
  const weekdays = Array.from({ length: 7 }, () => blankBucket());
  const unknownModels = new Map();

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
    if (r.speed === 'fast') {
      totals.fastMessages += 1;
      totals.fastCost += cost;
    }
    if (!ratesFor(r, pricing).known) {
      const u = unknownModels.get(r.model) || { name: r.model, messages: 0, cost: 0 };
      u.messages++;
      u.cost += cost;
      unknownModels.set(r.model, u);
    }

    const d = dayKey(r.ts);
    let day = daily.get(d);
    if (!day) {
      day = blankBucket({ date: d, sessions: new Set(), byProject: {}, byModel: {}, byEffort: {} });
      daily.set(d, day);
    }
    addTo(day, r, cost);
    day.sessions.add(r.session);
    addSlice(day.byProject, r.project, r, cost);
    addSlice(day.byModel, r.model, r, cost);
    addSlice(day.byEffort, r.effort, r, cost);

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
    bump(efforts, r.effort, r, cost);

    const sb = bump(sessions, r.session, r, cost, () => ({
      project: r.project,
      projectTokens: {},
      first: r.ts,
      last: r.ts,
      contextNow: 0,
    }));
    sb.first = Math.min(sb.first, r.ts);
    sb.last = Math.max(sb.last, r.ts);
    sb.projectTokens[r.project] = (sb.projectTokens[r.project] || 0) + tokensOf(r);
    if (!r.sidechain && !r.agentId) sb.contextNow = contextOf(r);

    addTo(hours[new Date(r.ts).getHours()], r, cost);
    addTo(weekdays[new Date(r.ts).getDay()], r, cost);
  }

  let series = [...daily.values()].map((d) => {
    d.sessions = d.sessions.size;
    return d;
  });
  series.sort((a, b) => (a.date < b.date ? -1 : 1));

  // Fill gaps so the chart shows one column per day in the window — a fixed
  // range always renders its full width, even with nothing in it.
  if (series.length || days !== null) {
    const firstTs = sel.length ? startOfDay(sel[0].ts) : startOfDay(now);
    const startTs = days === null ? firstTs : from;
    const have = new Map(series.map((d) => [d.date, d]));
    const filled = [];
    for (let t = startTs; t <= now; t += DAY) {
      const k = dayKey(t);
      filled.push(
        have.get(k) ||
          blankBucket({ date: k, sessions: 0, byProject: {}, byModel: {}, byEffort: {} })
      );
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
    p.cwdList = [...projects.get(p.name).cwds].slice(0, 8);
    return p;
  });

  const cacheable = totals.input + totals.cacheWrite + totals.cacheRead;
  const selSessions = new Set(sel.map((r) => r.session));
  const tools = toolStats(toolCalls || [], sel.length ? sel[0].ts : 0, now, selSessions);

  return {
    range,
    days,
    filter: active,
    from: days === null ? (sel.length ? sel[0].ts : now) : from,
    to: now,
    generatedAt: now,
    totals,
    previous,
    cacheHitRate: cacheable ? totals.cacheRead / cacheable : 0,
    cacheWaste: cacheWaste(sel, pricing),
    unknownModels: [...unknownModels.values()].sort((a, b) => b.cost - a.cost),
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
    efforts: groupList(efforts),
    tools: tools.list.slice(0, 20),
    toolCharsPerToken: CHARS_PER_TOKEN,
    sessions: sessionList,
    compact: compactSuggestions(sel, pricing, meta, opts, now, marks, toolCalls),
    hours: hours.map((h, i) => Object.assign({ hour: i }, h)),
    weekdays: weekdays.map((w, i) => Object.assign({ day: i }, w)),
  };
}

function toCsv(data) {
  const cols = [
    'date',
    'input',
    'output',
    'thinking',
    'cacheWrite',
    'cacheRead',
    'total',
    'messages',
    'sessions',
    'cost',
  ];
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
  loadMarks,
  setMark,
  RANGES,
  FILTERABLE,
  // exported for tests
  parseFile,
  buildProjectResolver,
  costOf,
  cacheWaste,
};
