# todo-brain

Personal MCP server that gives Claude priorities, open questions, a memory bank
and a file-location index. Stored locally in one SQLite file — no account, no
network. Todoist is an optional alternative backend.

```
Outlook / WhatsApp / Teams MCP ─┐
                                ├─► Claude Code (hub) ──► todo-brain ──► Store ──► brain.db
                     you ───────┘                                    (interface)  local SQLite (default) or Todoist
```

## Tools (21)

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

## Bug intake (Azure DevOps events)

Azure DevOps pushes Bug events to a local receiver, which turns them into
todo-brain tasks. No polling: one catch-up query runs on start for anything
missed while the Mac was off.

```
ADO service hook ──HTTPS──► tunnel ──► 127.0.0.1:4320/hooks/ado ──► BugIntake ──► Store
 (created / updated / commented, Bug only)      src/ado-webhook.ts      src/ado/intake.ts
```

| Event | Task |
|---|---|
| Bug assigned to me | created (`assigned`) |
| Comment mentions me / one of my groups | created (`mentioned` / `team-mentioned`), comment attached |
| New bug in one of `ADO_MY_APPS` | created (`my-area`) |
| Any comment / state / assignment change on a tracked bug | comment attached; comments add `new-comment`; reopened bug reopens a done task |
| My own changes, closed bugs, everything else | ignored |

Every task carries `ado-<id>`, `bug`, `to-investigate` and the app label — the
Investigator agent's queue. Auth to ADO uses the `az login` session.

```bash
export ADO_HOOK_SECRET=$(openssl rand -hex 24)   # basic-auth password ADO sends
export ADO_MY_APPS="eB2B Buyer App,Seller App"    # optional
bun run ado-webhook                               # receiver + catch-up
<start a tunnel to 127.0.0.1:4320 with a stable public URL>
bun run ado-hooks create https://<public-host>    # one-time: 3 service hooks
bun run ado-hooks list | delete
```

| Env var | Meaning |
|---|---|
| `ADO_HOOK_SECRET` | Required. Basic-auth password on the service hooks |
| `ADO_HOOK_PORT` | Receiver port, default 4320 |
| `ADO_MY_APPS` | Comma list of `Custom.Application` values I own |
| `ADO_ORG` / `ADO_PROJECT` | Default `https://dev.azure.com/xavica` / `Qwipo B2B` |
