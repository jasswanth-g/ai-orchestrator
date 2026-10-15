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
