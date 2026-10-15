import { z } from 'zod';
import type { Store } from '../store/store.ts';
import { formatEstimate, parseEstimate } from '../estimate.ts';
import type { Item } from '../types.ts';

/** Everything a tool may touch. Built once in index.ts, faked in tests. */
export interface ToolContext {
  store: Store;
  /** Base folder for relative paths in the Files tools (TODO_BRAIN_FILES_ROOT). */
  filesRoot?: string;
  /** Local date as YYYY-MM-DD — injectable so tests don't depend on the clock. */
  today: () => string;
  /** Existence check for remembered paths — injectable for tests. */
  exists: (path: string) => boolean;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  input: S;
  run: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

/** Identity helper that keeps `args` typed from the input shape. */
export const defineTool = <S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> => def;

export const priorityArg = z
  .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
  .describe('1 = P1 (most urgent) … 4 = P4');

/** Effort as people say it ("30m", "2h", "1h30m") → minutes. */
export const estimateArg = z
  .string()
  .transform((s, ctx) => {
    try {
      return parseEstimate(s);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: (e as Error).message });
      return z.NEVER;
    }
  })
  .describe('Effort, e.g. 30m, 2h, 1h30m');

export const idArg = z.string().min(1).describe('Item id as returned by a list tool');

/** Compact wire shape for an item — drops empty fields so results stay short. */
export const view = (i: Item) =>
  Object.fromEntries(
    Object.entries({
      id: i.id,
      title: i.title,
      priority: `P${i.priority}`,
      due: i.due,
      estimate: i.estimate !== undefined ? formatEstimate(i.estimate) : undefined,
      labels: i.labels.length ? i.labels : undefined,
      source: i.source === 'manual' ? undefined : i.source,
      link: i.link,
      path: i.path,
      notes: i.notes,
      approach: i.approach,
      status: i.status && i.status !== 'todo' ? i.status : undefined,
      createdAt: i.createdAt || undefined,
    }).filter(([, v]) => v !== undefined),
  );

/** Lowercase, dash-separated label safe for Todoist ("Waiting On" → "waiting-on"). */
export const toLabel = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Every whitespace-separated word of `query` appears somewhere in the haystack. */
export const matches = (query: string | undefined, ...fields: (string | undefined)[]) => {
  if (!query?.trim()) return true;
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
};

export const newestFirst = (a: Item, b: Item) => b.createdAt.localeCompare(a.createdAt);
