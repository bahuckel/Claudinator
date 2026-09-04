# Claudinator

A local dashboard for your own Claude Code token usage.

Claude Code already writes a full JSONL transcript of every session to
`~/.claude/projects`. Each assistant response in those files carries a `usage`
block — input, output, thinking, cache-write and cache-read tokens. Claudinator
reads those files, aggregates them, and serves a single-page dashboard so you
can see where your tokens actually go: which projects, which subagents, which
models, which days, and which long-running sessions are quietly costing you a
fortune in re-read context.

**Everything is local.** No API key, no network calls, no telemetry. The server
binds to `127.0.0.1` and only ever reads files that are already on your disk.

---

## Quick start

Requires **Node 18+** and nothing else — zero dependencies, no build step.

```bash
git clone https://github.com/bahuckel/Claudinator.git
cd Claudinator
node server.js
```

Open <http://localhost:8752>. On Windows you can double-click `start.bat`,
which starts the server and opens the browser for you.

Run the test suite with:

```bash
npm test
```

---

## What the dashboard shows

### Fetching

There is no background polling. Press **FETCH** (or the `R` key) to rescan your
transcripts. The status line under the header reports the window, the totals and
how long the round trip took.

Pick a range with the pills: **1D / 7D / 1M / 6M / 1Y / ALL**. These are rolling
windows ending today, not calendar periods. Your range, chart metric, stacking
mode and the collapsed state of the suggestions panel are remembered in the
browser.

### KPI cards

Total tokens, estimated cost, output (with the thinking share), cache hit rate,
messages, active days, input and cache write. Where a comparable previous window
exists (the 7 days before the current 7, for example), each card also shows the
change against it.

**Cache hit rate** is the share of prompt tokens that were served from cache
instead of being sent fresh. On long agentic sessions this is normally very
high; a low number means something is invalidating the prompt prefix on every
turn.

### `/compact` suggestions

Every main-thread turn re-reads the entire discussion, so a session's cost per
turn tracks its context size. Claudinator measures that context directly: for
the latest main-thread turn of each session, `input + cache write + cache read`
is what the model had to read to answer.

Sessions at or above `compactThresholdTokens` (default 150,000) are grouped by
project and listed with:

- current context per turn, against a 1M window, plus the peak it has reached;
- cost per turn right now, and **what share of that is pure re-reading**;
- how many times the session has already been compacted — detected as a drop of
  more than 50% in context between two consecutive turns;
- what `/compact` would save per turn, and over the next 50 turns (assuming the
  context lands near `compactTargetTokens`, priced at the cache-read rate);
- an `idle Nd` badge for sessions untouched for longer than `compactIdleHours`
  (default 48) — those only matter if you resume them.

The panel header stays visible when collapsed, so the count is always at hand.

### Daily usage chart

One column per day, with two independent toggles:

- **Stack by** — *type* (input / output / cache write / cache read), *project*,
  or *model*. Project and model stacking keep the top 8 keys and fold the rest
  into `other`.
- **Metric** — tokens, estimated cost, or output only.

Long ranges are bucketed automatically: more than ~10 weeks of days are grouped
into weeks, more than ~13 months into months. Hovering any column gives the
exact numbers.

### Calendar, rhythm and best days

- **Calendar** (1M and up) — a GitHub-style heatmap, one cell per day.
- **Rhythm** — token totals by hour of day and by weekday, so you can see when
  you actually work.
- **🏆 Best days** — the top 10 days by total tokens, each naming the project
  that dominated it.

### Breakdowns

- **Per project** — see *How attribution works* below.
- **Per agent** — the main thread versus each subagent type.
- **Agent runs** — every individual subagent launch, by its task description.
- **Per model** — tokens and cost split by model id.
- **Top sessions** — the 25 largest, titled from the session's custom title or
  its first prompt, with the current context size of each.

### Export

The **CSV** button downloads the daily series for the current range
(`/api/usage.csv?range=…`).

---

## How attribution works

**Deduplication.** One record is one assistant API response. Claude Code writes
the same `message.id` once per streamed content block, so records are deduped on
`message.id + requestId`. A transcript that also exists in an `archive/` folder
or a backup root is deduped the same way, so adding backup folders is safe.
`<synthetic>` messages — local errors, interrupts — are not API calls and are
skipped.

**Projects.** A session's `cwd` is often a subfolder (`myrepo/src/client`), so
each cwd is rolled up:

1. to the enclosing **git repository**, if there is one (deepest `.git` wins, so
   nested repos stay separate);
2. otherwise to the shallowest folder in use that is not a **workspace** — a
   folder that contains several distinct project subfolders in use, such as
   `~/Desktop/Projects`;
3. otherwise to the cwd itself.

Sessions started directly inside a workspace folder are labelled `<name> (root)`.
The project table shows how many folders fed each project; hover for the list.
If the heuristic guesses wrong for your layout, override it in `config.json`.

**Agents.** Main-thread records are `main thread`. Subagent transcripts live in
`<session>/subagents/agent-<agentId>.jsonl` and every line carries `agentId`.
The spawning session holds the other half of the link: an `Agent`/`Task`
tool call (which knows the `subagent_type`) and the matching tool result whose
`toolUseResult.agentId` names the subagent. Claudinator joins the two, which is
what gives both the agent type and the human-readable task description.

**Total tokens** = input + output + cache write + cache read. Cache reads
usually dominate, which is normal for long agentic sessions — they are also the
cheapest tokens, at 10% of the input rate.

---

## Cost estimates

Costs are computed locally from `pricing.json` (USD per 1M tokens, first-party
Anthropic API rates) with the standard cache multipliers: a 5-minute cache write
costs 1.25× the input rate, a 1-hour cache write 2×, and a cache read 0.1×.
Fast-mode responses use the `fast` rates where a model defines them.

This is an **estimate, not a bill.** A Claude subscription is not billed per
token, and published rates change. Edit `pricing.json` to match your own
numbers — it is re-read on every fetch, so no restart is needed.

---

## Configuration

Everything works with no configuration. To change something, create a
`config.json` next to `server.js` (it is gitignored); all keys are optional:

```json
{
  "roots": ["~/.claude/projects", "D:/backups/claude-transcripts"],
  "port": 8752,
  "workspaces": ["~/Desktop/Projects"],
  "projectRoots": ["~/code/monorepo"],
  "minWorkspaceChildren": 3,
  "compactThresholdTokens": 150000,
  "compactTargetTokens": 20000,
  "compactIdleHours": 48
}
```

| Key | Meaning |
| --- | --- |
| `roots` | Transcript folders to scan, recursively. Defaults to `~/.claude/projects`. Duplicates across roots are dropped. |
| `port` | HTTP port. Default `8752`. |
| `workspaces` | Folders to always treat as containers of projects rather than projects. |
| `projectRoots` | Folders to always treat as a single project, even without `.git` and even when many subfolders are in use. |
| `minWorkspaceChildren` | How many distinct subfolders in use make a folder a workspace automatically. Default `3`. |
| `compactThresholdTokens` | Context size at which a session earns a `/compact` suggestion. Default `150000`. |
| `compactTargetTokens` | Assumed context size after compaction, used for the savings estimate. Default `20000`. |
| `compactIdleHours` | Sessions idle longer than this are shown dimmed. Default `48`. |

`CLAUDINATOR_ROOTS` (path-delimiter separated) and `PORT` override the file.

---

## API

The page is a thin client over three endpoints:

| Endpoint | Returns |
| --- | --- |
| `GET /api/usage?range=1d\|7d\|30d\|180d\|365d\|all` | Everything the page shows, as JSON. |
| `GET /api/usage.csv?range=…` | The daily series as CSV. |
| `GET /api/health` | Liveness, the configured roots and the pid. |

---

## Performance

Parsed files are cached in `.cache/records.json`, keyed on each file's size and
mtime, so only changed transcripts are re-read and the cache file is only
rewritten when something actually changed. A cold scan of ~90 MB of transcripts
takes about half a second; warm scans are around 10 ms.

---

## Project layout

```
server.js           static file server + JSON/CSV API
lib/scan.js         discovery, parsing, caching, project/agent attribution,
                    aggregation, /compact analysis
pricing.json        per-model rates and cache multipliers
public/index.html   page structure
public/styles.css   dark theme
public/app.js       SVG charts, tables, interactions (no libraries)
test/scan.test.js   node:test suite — npm test
start.bat           Windows launcher
```

---

## Troubleshooting

**"No data in this range."** Either the range predates your transcripts, or the
scan found no files. Check the footer line: it reports how many files and bytes
were scanned and from which roots.

**Wrong project grouping.** Set `workspaces` / `projectRoots` in `config.json`,
then press FETCH — no restart needed for those, but a restart is needed if you
change `roots` or `port`.

**Nothing loads at all.** Check the terminal running `node server.js` for the
listening line, and make sure nothing else holds port 8752.
