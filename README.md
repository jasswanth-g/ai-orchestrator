# todo-brain

Personal MCP server that gives Claude priorities, open questions, a memory bank
and a file-location index. Stored locally in one SQLite file — no account, no
network. Todoist is an optional alternative backend.

```
Outlook / WhatsApp / Teams MCP ─┐
                                ├─► Claude Code (hub) ──► todo-brain ──► Store ──► brain.db
                     you ───────┘                                    (interface)  local SQLite (default) or Todoist
```

## Tools (24)

| Area | Tools |
|---|---|
| Tasks | `next_tasks`, `add_task`, `reprioritize`, `complete_task` |
| Backlog | `add_backlog`, `backlog`, `pull_into_work`, `move_to_backlog`, `set_status` |
| Planning | `plan_day(hours)` — fills the day by rank; overdue / due-today always first |
| Questions | `ask_question`, `edit_question` (wording, notes, recommended approach, team, waiting / to-ask), `open_questions`, `answer_question` |
| Memory | `remember`, `recall`, `forget` |
| Capture | `capture` (task / question / memory / backlog from any channel, keeps `source` + `link`) |
| Files | `remember_location`, `where_is` |
| Overview | `brief` |
| Reports | `save_report`, `get_report`, `list_reports` — investigation reports, versioned, tagged to the bug and investigation, with your reviews |

## Setup

```bash
claude mcp add --scope user todo-brain \
  -e TODO_BRAIN_FILES_ROOT=~/Documents/Work \
  -- bun run ~/Documents/GitHub/todo-brain/src/index.ts
```

Restart Claude Code. Data lives in `<TODO_BRAIN_FILES_ROOT>/.todo-brain/brain.db` — back up that one file.

| Env var | Meaning |
|---|---|
| `TODO_BRAIN_FILES_ROOT` | Work folder; relative paths in the Files tools resolve here, and the DB lives under it |
| `TODO_BRAIN_DB` | Override the SQLite file path |
| `TODOIST_API_TOKEN` | Set it to use Todoist instead of SQLite (phone app, reminders) |
| `TODO_BRAIN_DRY_RUN` | `1` = in-memory store, nothing saved |

## Backlog and board

The backlog holds work that should be handled some day but isn't committed
(known gaps, nice-to-haves). Backlog items have no due date and never show up
in `next_tasks`, `plan_day` or the overdue list. The brief only counts them.

- **Area** = the item's first label (`ondc-protocol`, `partner-portal`, …).
- **Impact** high / medium / low is stored as priority P1 / P2 / P3.
- `pull_into_work` turns an item into a normal task (optionally with a due date and
  an Azure DevOps id, kept as an `ado-<id>` label); `move_to_backlog` parks it again.
- Tasks and backlog items have a status: todo → in-progress → in-review; done completes them.
- The dashboard board (drag and drop) adds a Completed column with the last 2 weeks of done tasks; dragging one out reopens it.

Team sprints live in Azure DevOps; this is the personal side.

## Prioritizing

Every task gets an explainable score (`why` on each result):

| Signal | Points |
|---|---|
| Priority | P1 40 · P2 30 · P3 20 · P4 10 |
| Deadline | overdue 50 · today 40 · tomorrow 30 · ≤3 days 20 · ≤7 days 10 |
| Quick win (estimate ≤ 30m) | +5 |

Estimates: `30m`, `2h`, `1h30m`, `1.5h`. Unestimated tasks count as 1h in `plan_day` and are flagged.

Due dates accept `YYYY-MM-DD`, `today`, `tomorrow`, a weekday (`fri`), `next week`, `in N days/weeks`.

## Work folder layout

```
<TODO_BRAIN_FILES_ROOT>/
├─ 00-inbox/      new files land here first
├─ projects/      one folder per project
├─ references/    specs, API docs, field maps
├─ meetings/      notes by date (2026-10-01-tcp-sync.md)
└─ archive/       finished work
```

## Develop

```bash
bun install
bun test
bun run typecheck
bun run dashboard   # http://127.0.0.1:4319
```

- New storage backend → implement `src/store/store.ts`, swap it in `src/index.ts`.
- New tool group → add a file in `src/tools/`, list it in `src/tools/index.ts`.
- New channel → nothing to build; see `src/sources/README.md`.
- Structured fields (`source`, `link`, `path`) live in the item description footer (`src/store/meta.ts`).

## Agents server (`bun run agents`)

One process for every agent input: a local event server (127.0.0.1:4320) with a
route per source, plus the WhatsApp bridge as a child process. Each source
catches up on start, so nothing is lost while it was down. No polling.

```
Azure DevOps service hooks ─HTTPS─► tunnel ─┐
                                            ├─► src/agents.ts ─► intake ─► Store (todo-brain)
bridges/whatsapp (child) ─── localhost ─────┘   /hooks/ado, /hooks/whatsapp
```

```bash
bun run agents                                      # then pick WhatsApp chats on the dashboard
bun run ado-hooks create https://<public-host>      # one-time, after the tunnel is up
```

| Env var | Meaning |
|---|---|
| `AGENTS_PORT` | Event server port, default 4320 |
| `ADO` | `off` = no Azure DevOps (default on: startup catch-up even without a tunnel) |
| `ADO_HOOK_SECRET` | Basic-auth password on the ADO service hooks; default a stored secret in `ado-hook-secret` (0600) next to the todo-brain DB |
| `ADO_ORG` / `ADO_PROJECT` | Default `https://dev.azure.com/xavica` / `Qwipo B2B` |
| `WHATSAPP_BRIDGE` | `off` = don't start the bridge |
| `WHATSAPP_WATCH_CHATS` / `WHATSAPP_KEYWORDS` | First-run defaults only; after that the dashboard's **Choose chats & keywords** owns them (`agents-settings.json`). Nothing selected = nothing watched |
| `WHATSAPP_STORE_DIR` | Bridge session + `messages.db`; default the whatsapp-mcp store, so the WhatsApp MCP server keeps reading the same data |

**Dashboard:** `http://127.0.0.1:4320/` — tabs: **Overview** (all agents),
**Messenger** (`/messenger`: ADO + WhatsApp intake, chat picker, ignored bugs,
skipped messages) and **Investigator** (`/investigator`: investigations, reports
and reviews, bugs waiting). It shows each source's status (ADO account,
last catch-up or start error; WhatsApp link state), counts of tasks created /
notes / ignored / errors (kept across restarts, with the date counting began),
the open tasks the agents created with **Replied** / **Mark read** / **Done**, and
for bugs **Add note** (a comment or recommendation, kept in `bug-notes.json` for
the Investigator to use and rewrite — never posted to ADO as-is) and **Ignore**
(closes the task and drops later events; **Restore** from the Ignored bugs list),
the activity feed (`agents-activity.jsonl`, last 500) and the WhatsApp messages
the rules skipped (`whatsapp-skipped.jsonl`, last 100). State files live next to
the todo-brain DB.

### Azure DevOps work items

Only **open work items assigned to me**, of any type (Bug, Task, Story, …).
"Open" is decided per type from ADO's own state categories (Proposed /
InProgress), since the same state name can be open for one type and done for
another. Mentions alone don't create tasks.

| Event | Task |
|---|---|
| An open item is (or gets) assigned to me | created (`<Type> <id>: <title>`, labels `ado-<id>`, the type, `assigned`) |
| Comment / state / assignment change on a tracked item | comment attached; comments add `new-comment`; a reopened item reopens a done task |
| An item I ignored on the dashboard, my own changes, closed items, everything else | ignored |

**Done → Azure DevOps** (`src/ado/transitions.ts`). Done on a dashboard task moves
the work item; the confirm step says exactly what (e.g. "Confirm → Closed in
Azure DevOps"). If ADO refuses, the task stays open and the reason is in the feed.
Empty required fields are filled with 1. Ignore never touches ADO.

| Type | Done | Developer starts (Developer agent, later) |
|---|---|---|
| Bug | Resolved (Fixed), Completed Work, "ready for retest" comment with the report's checks — QA closes it | Active |
| Bug whose report says works-as-designed / cannot-reproduce / requirement-gap | handed back: Active, assigned to the reporter, the finding as a comment | — |
| Task | Closed, Completed Work kept, Remaining Work cleared (ADO requires it empty) | Active |
| Story | Ready for QA | In Development |
| Issue | Resolved | In Development |

Generating or reviewing a report changes nothing in ADO.

**Refresh** (top bar, every page) runs the catch-up on demand: new open items
assigned to me become tasks, and tasks whose item was closed or reassigned in
ADO are closed with a note saying why. The same runs once on start. WhatsApp's
catch-up runs too. The result shows in the top bar and in Activity.

Only **Bugs** get `to-investigate` and the Investigate button. Auth to ADO uses
the `az login` session. `bun run ado-hooks list | create <url> | delete` manages
the service hooks (updated + commented, all work item types).

### WhatsApp

`bridges/whatsapp` is the whatsmeow bridge from
[lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) (MIT, see its
LICENSE) plus `forward.go`, which POSTs each live message in watched chats to
`/hooks/whatsapp`. The agents server builds it with Go, starts it, restarts it if
it exits, and refuses to start it while another bridge holds port 8080 — two
clients on one session conflict, so stop the whatsapp-mcp bridge first.

**Connect / re-link:** open `http://127.0.0.1:4320/whatsapp` — link status,
the pairing QR (scan from WhatsApp → Settings → Linked devices), a new QR when
one expires, and Unlink. The page only answers on localhost.

**Bridge API security:** every bridge endpoint (`/api/send`, `/api/download`,
status, QR, pair, logout) requires the `X-Bridge-Secret` header. The secret lives
in `<WHATSAPP_STORE_DIR>/bridge-secret` (0600), created on first start; the agents
server and the WhatsApp MCP server (`whatsapp-mcp-server/whatsapp.py`) read it
from there. A custom header also means a web page can't call the bridge from
your browser.

A message is **for me** when it mentions me, replies to me, is a 1:1 chat, or
contains one of `WHATSAPP_KEYWORDS`. One open task per chat (`wa-<chat>`)
collects those messages as comments and carries `needs-reply`; my own reply in
that chat removes it.

## Investigator

Click **Investigate** on a bug task in the dashboard. The agents server gathers
the bug from Azure DevOps into `BRIEF.md` (repro steps, every comment, the parent
Story's description and acceptance criteria, the Feature, and your notes), then
opens a new **iTerm** window running an interactive Claude Code session with
`prompts/investigator.md` as its instructions. Watch it work and type to it any
time. It saves its report to **todo-brain** with `save_report` — not to a file:
every save is a new version tagged to the bug and the investigation, and the
tool's length limits keep it short (2-3 sentence summary, one requirement line,
≤6 files, ≤5 before → after changes, ≤4 tests, ≤4 blocking questions). The
Investigator page shows verdict, summary and fix first, evidence folded away,
with **Approve**, **Reject** and **Request changes**. Reviews are stored with the
report; a change request is typed into the open session (or resumes it), which
reads it with `get_report` and saves a new version. **Terminal** brings the
window back. Any Claude session can read reports with `get_report` / `list_reports`.

The session's only MCP server is this repo's todo-brain, renamed `reports` and
limited to the three report tools (`TODO_BRAIN_ONLY`) — so a personal allow rule
like `mcp__todo-brain` can't hand it `add_task` or anything else.

Each bug's folder is `<state>/investigations/bug-<id>/` (BRIEF.md, settings.json,
mcp.json, run.sh); the repo knowledge file is
`<state>/investigator/REPOS.md`, seeded once from each work repo's
CLAUDE.md/README.md and extended by the Investigator ("Learned") and by you.

**Read-only by construction** (per-session `settings.json`, `dontAsk` mode —
anything not allowed is refused without prompting):

| Allowed | Refused |
|---|---|
| Read/Grep/Glob in the work repos, its folder, REPOS.md | Edit/Write anywhere in the repos (explicit deny) |
| Edit REPOS.md; the three report tools | Edit in its own folder; any other shell command (`rm`, `touch`, `git checkout`, …) |
| `cd`, `ls`, `git log/show/blame/diff/grep/ls-files`, `az boards work-item show` | `git … --output`, web fetch/search, every other MCP server and todo-brain tool, your hooks |

Your personal Claude Code allow rules (`~/.claude/settings.json`) still apply in
these sessions — keep Bash/Edit allow rules out of it, or they reach the Investigator too.

| Env var | Meaning |
|---|---|
| `INVESTIGATOR_REPOS` | Folder with the git clones, default `~/Documents/GitHub` |
| `INVESTIGATOR_REPO_REMOTE` | Only clones whose origin contains this are work repos, default `dev.azure.com/xavica` |

ONDC protocol knowledge: not wired yet — the report lists protocol questions it
can't confirm as open questions.
