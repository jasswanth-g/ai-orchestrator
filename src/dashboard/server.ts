#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { filesRoot, localToday, log, pickStore } from '../config.ts';
import { DueParseError, parseDue } from '../due.ts';
import { EstimateParseError } from '../estimate.ts';
import type { ToolContext } from '../tools/define.ts';
import { toLabel, view } from '../tools/define.ts';
import { backlogView, withTeamLabel } from '../tools/backlog.ts';
import { IMPACT, type Impact, type ItemPatch, type Priority, STATUSES, type Status } from '../types.ts';
import { parseQuickAdd } from './quick-add.ts';
import { dashboardState } from './state.ts';

/**
 * Local dashboard over the same store the MCP server uses.
 * Bound to 127.0.0.1 only; every write requires a JSON request, which a
 * cross-site form can't send without a CORS preflight.
 */

const port = Number(process.env.TODO_BRAIN_DASHBOARD_PORT ?? 4319);
const ctx: ToolContext = { store: pickStore(), filesRoot, today: localToday, exists: existsSync };
const page = Bun.file(new URL('./page.html', import.meta.url));

const json = (body: unknown, status = 200) => Response.json(body, { status });

class BadRequest extends Error {}

/** Parses a JSON write request, or throws BadRequest. */
async function body(req: Request): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type') !== 'application/json') throw new BadRequest('JSON request required');
  const b = await req.json().catch(() => undefined);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new BadRequest('JSON object required');
  return b as Record<string, unknown>;
}

/** Runs a write handler, turning user-input errors into 400s. */
const write = <Path extends string>(handler: (req: Bun.BunRequest<Path>) => Promise<Response>) => async (req: Bun.BunRequest<Path>) => {
  try {
    return await handler(req);
  } catch (e) {
    if (e instanceof BadRequest || e instanceof DueParseError || e instanceof EstimateParseError) return json({ error: e.message }, 400);
    throw e;
  }
};

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  routes: {
    '/': () => new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    '/api/state': async (req) => {
      const hours = Number(new URL(req.url).searchParams.get('hours') ?? 6);
      return json(await dashboardState(ctx, Number.isFinite(hours) && hours > 0 && hours <= 16 ? hours : 6));
    },
    '/api/tasks': {
      POST: write(async (req) => {
        const { text, bucket = 'work' } = await body(req);
        if (typeof text !== 'string' || !text.trim()) throw new BadRequest('Type a task first');
        if (bucket !== 'work' && bucket !== 'backlog') throw new BadRequest('Add to work or backlog');
        const item = parseQuickAdd(text);
        if (bucket === 'backlog' && item.due) throw new BadRequest('Backlog items have no due date. Add it as a task instead, or drop the date.');
        return json(view(await ctx.store.create(bucket, { ...item, priority: item.priority ?? (bucket === 'backlog' ? 2 : undefined) })));
      }),
    },
    // Structured add from the Backlog tab's form.
    '/api/backlog': {
      POST: write(async (req) => {
        const { title, area, team, impact = 'medium', notes } = await body(req);
        if (typeof title !== 'string' || !title.trim()) throw new BadRequest('Give the item a title');
        for (const [k, v] of Object.entries({ area, team, notes })) if (v !== undefined && typeof v !== 'string') throw new BadRequest(`${k} must be text`);
        if (!(typeof impact === 'string' && impact in IMPACT)) throw new BadRequest('Impact must be high, medium or low');
        const labels = withTeamLabel(area ? [toLabel(area as string)].filter(Boolean) : [], (team as string | undefined) ?? '');
        const item = await ctx.store.create('backlog', {
          title: title.trim(),
          labels,
          priority: IMPACT[impact as Impact],
          notes: (notes as string | undefined)?.trim() || undefined,
        });
        return json(backlogView(item));
      }),
    },
    '/api/items/:id/update': {
      POST: write<'/api/items/:id/update'>(async (req) => {
        const { priority, due, status, bucket, title, notes, approach, labels } = await body(req);
        const patch: ItemPatch = {};
        if (title !== undefined) {
          if (typeof title !== 'string' || !title.trim()) throw new BadRequest('The title can\'t be empty');
          patch.title = title.trim();
        }
        for (const [key, value] of [['notes', notes], ['approach', approach]] as const) {
          if (value === undefined) continue;
          if (typeof value !== 'string') throw new BadRequest(`${key} must be text`);
          patch[key] = value.trim();
        }
        if (labels !== undefined) {
          if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string')) throw new BadRequest('Labels must be a list of text');
          patch.labels = [...new Set(labels.map(toLabel).filter(Boolean))];
        }
        if (status !== undefined) {
          if (!STATUSES.includes(status as Status)) throw new BadRequest(`Status must be one of ${STATUSES.join(', ')}`);
          patch.status = status as Status;
        }
        // Pull into work (with a due date) or park back in the backlog (clears it).
        if (bucket !== undefined) {
          if (bucket !== 'work' && bucket !== 'backlog') throw new BadRequest('Move to work or backlog');
          patch.bucket = bucket;
          patch.status = 'todo';
          if (bucket === 'backlog') patch.due = null;
        }
        if (priority !== undefined) {
          if (![1, 2, 3, 4].includes(priority as number)) throw new BadRequest('Priority must be 1–4');
          patch.priority = priority as Priority;
        }
        if (due !== undefined && bucket !== 'backlog') {
          if (typeof due !== 'string') throw new BadRequest('Due must be text');
          patch.due = parseDue(due);
        }
        if (!Object.keys(patch).length) throw new BadRequest('Nothing to change');
        return json(view(await ctx.store.update(req.params.id, patch)));
      }),
    },
    '/api/items/:id/close': {
      POST: write<'/api/items/:id/close'>(async (req) => {
        await body(req);
        await ctx.store.close(req.params.id);
        return json({ ok: true });
      }),
    },
    // Undo a Done, or drag a card out of Completed (optionally straight into a status column).
    '/api/items/:id/reopen': {
      POST: write<'/api/items/:id/reopen'>(async (req) => {
        const { status } = await body(req);
        if (status !== undefined && !STATUSES.includes(status as Status)) throw new BadRequest(`Status must be one of ${STATUSES.join(', ')}`);
        await ctx.store.reopen(req.params.id);
        if (status !== undefined) await ctx.store.update(req.params.id, { status: status as Status });
        return json({ ok: true });
      }),
    },
    // Permanent: unlike close, the item doesn't stay in history. The page waits out an Undo first.
    '/api/items/:id/delete': {
      POST: write<'/api/items/:id/delete'>(async (req) => {
        await body(req);
        await ctx.store.remove(req.params.id);
        return json({ ok: true });
      }),
    },
  },
  fetch: () => json({ error: 'not found' }, 404),
  error: (e) => json({ error: e.message }, 500),
});

log(`dashboard on ${server.url}`);
