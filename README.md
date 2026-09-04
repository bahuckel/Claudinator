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

## Your data stays yours

Claudinator ships no data of any kind. There are no sample transcripts, no
bundled numbers and no baked-in paths — the repository is only code. Every
figure you see is computed on your machine, at the moment you press FETCH, from
your own transcripts, so **two people running this see completely different
dashboards**: their own projects, their own agents, their own days.

Nothing is ever uploaded, and nothing derived from your transcripts is
committable by accident: the parse cache (`.cache/`), your `config.json` and
your compaction marks (`compact-marks.json`) are all gitignored.

---

## Quick start

Requires **Node 18+** and nothing else — zero dependencies, no build step.

```bash
git clone https://github.com/bahuckel/Claudinator.git
cd Claudinator
node server.js
```

Open <http://localhost:8752>. There are launchers that start the server and
open the browser for you: `start.bat` on Windows, `./start.sh` on macOS and
Linux.

Run the test suite with:

```bash
npm test
```

---

## What the dashboard shows

### Fetching

Press **FETCH** (or the `R` key) to rescan your transcripts. The status line
under the header reports the window, the totals and how long the round trip
took.

**AUTO** (or the `T` key) turns on a rescan timer — 30s, 1m, 5m or 15m, your
choice — and is **off by default**. A hidden tab skips its scans and catches up
when you come back to it.

Pick a range with the pills: **1D / 7D / 1M / 6M / 1Y / ALL**. These are rolling
windows ending today, not calendar periods. Your range, chart metric, stacking
mode and the collapsed state of the suggestions panel are remembered in the
browser.

### KPI cards

Total tokens, estimated cost, output (with the thinking share), cache hit rate,
cache never reused, messages and active days, plus a **Fast mode** card when any
turn ran at `speed: "fast"` and a **Server tools** card when web search or web
fetch was used. Where a comparable previous window exists (the 7 days before the
current 7, for example), each card also shows the change against it.

**Cache hit rate** is the share of prompt tokens that were served from cache
instead of being sent fresh. On long agentic sessions this is normally very
high; a low number means something is invalidating the prompt prefix on every
turn.

**Cache never reused** is the other side of that coin: cache writes that nothing
read back before they expired. A 5-minute write only pays off if the same
conversation asks again within five minutes, an hour write within the hour, so
each write is checked against the next turn of the same conversation (subagents
counted separately, since they have their own context).

If a model appears that `pricing.json` does not list, a banner names it and says
how much of the window was priced at the fallback rate — an unknown model
silently costed at Opus rates is how an estimate ends up 5x wrong.

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
- how much of that context is **tool output**, and which tool dominates it;
- an `idle Nd` badge for sessions untouched for longer than `compactIdleHours`
  (default 48) — those only matter if you resume them.

**🔔 Notify me** asks the browser for notification permission and then raises a
desktop notification when a session first crosses the threshold, or when one
already flagged has doubled its context since the last alert. It is per-browser,
off by default, and only fires on a fetch — pair it with **AUTO** so it can
check without you. Marking a session compacted resets its alert.

Each card has a **Compacted ✓** button. Press it after you actually run
`/compact` in that session: the click timestamp is recorded, and from then on
only turns *after* it count toward the suggestion. The card disappears until
the session grows past the threshold again.

Marks collect at the bottom of the panel in a collapsed **Marked compacted**
dropdown — a count badge, then newest first when you open it, each row showing
the project, when you marked it, how many turns have happened since, when it
expires, and an **undo** that forgets the mark and measures the whole session
again. A mark is forgotten automatically after `markRetentionDays` (default 7),
at which point the session counts from its beginning again; expired marks are
deleted from the file, not merely hidden. Marks live in `compact-marks.json`
next to `server.js` (gitignored).

The panel header stays visible when collapsed, so the count is always at hand.

### Daily usage chart

One column per day, with two independent toggles:

- **Stack by** — *type* (input / output / cache write / cache read), *project*,
  *model*, or *effort* (`output_config.effort` of each turn). The categorical
  stacks keep the top 8 keys and fold the rest into `other`.
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

### Breakdowns and drill-down

- **Per project** — see *How attribution works* below.
- **Per agent** — the main thread versus each subagent type.
- **🔧 Tool output** — how many tokens each tool has poured into contexts, with
  call counts, the average per call, and the biggest single results. This is
  usually what makes a session expensive: a tool result is re-read by every
  turn that follows it.
- **📈 Context growth** — the exactly measured counterpart: how many tokens were
  appended between one turn and the next, and the largest jumps with the tools
  that ran in them.
- **Agent runs** — every individual subagent launch, by its task description.
- **Per model** — tokens and cost split by model id.
- **Per effort** — the same split by effort level.
- **Top sessions** — the 25 largest, titled from the session's custom title or
  its first prompt, with the current context size of each.

Rows in the project, agent, model, effort and session tables are **clickable**:
one click filters the entire dashboard — every chart, KPI and panel — to that
slice. Active filters show as chips under the header; remove one with its
cross, or clear them all with `Escape`. The CSV export follows the current
filter.

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

A session started directly inside a workspace folder has no project of its own,
so its **file paths are used instead**: every absolute path in its tool calls
(`file_path` arguments, and paths inside shell commands, quoted ones included)
is mapped to a project, and if one project takes at least 60% of at least three
hits, the whole session is attributed there and the row is marked *inferred
from file paths*. Genuinely cross-project sessions and sessions that touched
nothing keep the `<name> (root)` label. Turn this off with
`"inferProjectFromPaths": false`.

On the corpus this was built against, that moves 15 of 17 root sessions to a
real project with a 100% one-sided signal, shrinking the meaningless
`(root)` bucket from 460M tokens to 4M.

The project table shows how many folders fed each project and how many of its
sessions were inferred; hover for the list. If the heuristic guesses wrong for
your layout, override it in `config.json`.

**Agents.** Main-thread records are `main thread`. Subagent transcripts live in
`<session>/subagents/agent-<agentId>.jsonl` and every line carries `agentId`.
The spawning session holds the other half of the link: an `Agent`/`Task`
tool call (which knows the `subagent_type`) and the matching tool result whose
`toolUseResult.agentId` names the subagent. Claudinator joins the two, which is
what gives both the agent type and the human-readable task description.

**Total tokens** = input + output + cache write + cache read. Cache reads
usually dominate, which is normal for long agentic sessions — they are also the
cheapest tokens, at 10% of the input rate.

**Tool output** is sized from the tool result's own `content` — the part the
model actually reads — at roughly 4 characters per token, plus a flat 1,600
tokens per image block. Results under 400 characters are ignored. The
transcript line is *not* a good proxy: it carries the payload a second time
under `toolUseResult` plus routing metadata, so measuring the line roughly
doubles the real figure.

**Context growth** is exact rather than estimated. The prompt of turn N+1,
minus the prompt of turn N, minus what the model itself wrote in turn N, is
precisely what got appended in between — all three numbers come straight from
the usage blocks. Turns where the prompt shrank (compaction, context editing)
are skipped rather than counted as zero.

### Why the per-tool numbers are estimates

It is tempting to attribute that exact growth to the individual tool results in
the gap, which would give exact per-tool token counts. Measured against real
transcripts, it does not hold:

- Aggregated over 3,550 turn gaps, the growth implies **0.87 characters per
  token** — impossible for text. The gap carries system reminders and other
  injected context, not just the tool result.
- The overhead is not a constant that can be subtracted: turns where nothing
  arrived still grew by 97 tokens at the 10th percentile and 2,097 at the 90th.
- Over a thousand gaps show a *negative* delta from context editing and
  compaction, which breaks attribution for those turns outright.

Exact per-result counts would need a tokenizer for the current Claude models,
which Anthropic does not publish, or a call to the token-counting API, which
would mean an API key and network access. Both were rejected in favour of
keeping this tool local and keyless, so per-tool figures are labelled as
estimates and per-turn growth is offered as the measured number beside them.

---

## Cost estimates

Costs are computed locally from `pricing.json` (USD per 1M tokens, first-party
Anthropic API rates) with the standard cache multipliers: a 5-minute cache write
costs 1.25× the input rate, a 1-hour cache write 2×, and a cache read 0.1×.
Fast-mode responses use the `fast` rates where a model defines them, and server
tools are billed per 1,000 requests from the `serverTools` block (web search
$10/1k; web fetch has no per-request fee — its content arrives as input tokens
and is already counted).

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
  "compactIdleHours": 48,
  "markRetentionDays": 7,
  "inferProjectFromPaths": true
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
| `markRetentionDays` | Days a "Compacted ✓" mark survives before it is deleted. `0` keeps them forever. Default `7`. |
| `inferProjectFromPaths` | Attribute workspace-root sessions to a project using the files they touched. Default `true`. |

`CLAUDINATOR_ROOTS` (path-delimiter separated) and `PORT` override the file.

---

## API

The page is a thin client over three endpoints:

| Endpoint | Returns |
| --- | --- |
| `GET /api/usage?range=1d\|7d\|30d\|180d\|365d\|all` | Everything the page shows, as JSON. Optional `project`, `agent`, `model`, `session`, `effort` filters. |
| `GET /api/usage.csv?range=…` | The daily series as CSV. |
| `POST /api/compact-mark` | Body `{"session":"…","ts":1757000000000}` records a compaction mark; `{"session":"…","clear":true}` removes it. Refuses cross-origin writes. |
| `GET /api/health` | Liveness, version, boot time, the mtime of the loaded code, the configured roots and the pid. |

---

## Performance

Transcripts are read line by line with `readline`, so a file is never held in
memory whole — the parser is unbothered by multi-gigabyte transcript folders.
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
compact-marks.json  your "I compacted this" timestamps (created on demand)
public/index.html   page structure
public/styles.css   dark theme
public/app.js       SVG charts, tables, interactions (no libraries)
test/scan.test.js   parsing, attribution, pricing and aggregation tests
test/server.test.js live HTTP tests against a real server on an empty root
start.bat           Windows launcher
start.sh            macOS / Linux launcher
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

---

## License

[MIT](LICENSE) — © 2026 Bahuckel.

---

*Made by Bahuckel, perfected with Claude.*
