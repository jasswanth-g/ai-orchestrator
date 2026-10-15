import { z } from 'zod';
import { IMPACT, type Impact, impactOf, type Item, STATUSES } from '../types.ts';
import { defineTool, estimateArg, idArg, matches, toLabel, view } from './define.ts';

/**
 * The backlog holds work that should be handled some day but isn't committed:
 * no due date, never ranked, planned or counted as overdue. Pulling an item
 * into work makes it a normal task; until then it is grouped by area (its
 * first label) and sorted by impact.
 */

const impactArg = z.enum(Object.keys(IMPACT) as [Impact, ...Impact[]]);

/** Owning team, kept as a `team-<name>` label. */
export const TEAMS = ['dev', 'product'] as const;
const TEAM_PREFIX = 'team-';
export const teamOf = (i: Item) => i.labels.find((l) => l.startsWith(TEAM_PREFIX))?.slice(TEAM_PREFIX.length);
/** Replaces the team label; '' removes it. */
export const withTeamLabel = (labels: string[], team: string) => [
  ...labels.filter((l) => !l.startsWith(TEAM_PREFIX)),
  ...(team ? [TEAM_PREFIX + toLabel(team)] : []),
];

/** Labels that describe an item rather than name its area. */
const isAreaLabel = (l: string) => !l.startsWith('from-') && !l.startsWith('ado-') && !l.startsWith(TEAM_PREFIX) && !l.endsWith('-gap');

/** An item's area: its first descriptive label, else "other". */
export const areaOf = (i: Item) => i.labels.find(isAreaLabel) ?? 'other';

export const backlogView = (i: Item) => ({ ...view(i), impact: impactOf(i.priority), area: areaOf(i), team: teamOf(i) });

/** Highest impact first, then oldest first — the longest-waiting important item leads. */
export const byImpact = (a: Item, b: Item) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt);

/** Backlog grouped by area, biggest areas first. */
export function groupBacklog(items: Item[]) {
  const groups = new Map<string, Item[]>();
  for (const i of [...items].sort(byImpact)) groups.set(areaOf(i), [...(groups.get(areaOf(i)) ?? []), i]);
  return [...groups.entries()]
    .sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b))
    .map(([area, list]) => ({ area, items: list.map(backlogView) }));
}

export const backlogTools = [
  defineTool({
    name: 'add_backlog',
    description:
      'Park work that should be handled some day but is not committed (a known gap, a nice-to-have). ' +
      'It gets no due date and stays out of next_tasks, plan_day and the overdue list until pulled into work.',
    input: {
      title: z.string().min(1),
      area: z.array(z.string()).min(1).describe('Area first (e.g. ondc-protocol, partner-portal), then any other tags'),
      team: z.string().optional().describe(`Owning team, e.g. ${TEAMS.join(', ')}`),
      impact: impactArg.default('medium'),
      notes: z.string().optional(),
      estimate: estimateArg.optional(),
      source: z.string().optional(),
      link: z.string().optional(),
    },
    async run({ store }, a) {
      const item = await store.create('backlog', {
        title: a.title,
        labels: withTeamLabel(a.area.map(toLabel).filter(Boolean), a.team ?? ''),
        priority: IMPACT[a.impact],
        notes: a.notes,
        estimate: a.estimate,
        source: a.source ? toLabel(a.source) : undefined,
        link: a.link,
      });
      return backlogView(item);
    },
  }),
  defineTool({
    name: 'backlog',
    description: 'List the backlog grouped by area, highest impact first. Use when the user asks what is parked, pending or not yet planned.',
    input: {
      area: z.string().optional().describe('Only items carrying this label'),
      team: z.string().optional().describe('Only items owned by this team'),
      query: z.string().optional().describe('Words to match in title or notes'),
    },
    async run({ store }, { area, team, query }) {
      const items = (await store.list('backlog')).filter(
        (i) =>
          (!area || i.labels.includes(toLabel(area))) &&
          (!team || teamOf(i) === toLabel(team)) &&
          matches(query, i.title, i.notes),
      );
      return { total: items.length, groups: groupBacklog(items) };
    },
  }),
  defineTool({
    name: 'pull_into_work',
    description:
      'Commit a backlog item: it becomes a normal task with a due date and starts counting in ranking and plan_day. ' +
      'Pass the Azure DevOps work item id when a story was created for it.',
    input: {
      id: idArg,
      due: z.string().optional().describe('YYYY-MM-DD, today, tomorrow, a weekday, "next week" or "in N days/weeks"'),
      priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional().describe('Defaults to its impact'),
      ado: z.string().regex(/^\d+$/).optional().describe('Azure DevOps work item id'),
    },
    async run({ store }, { id, due, priority, ado }) {
      const current = (await store.list('backlog')).find((i) => i.id === id);
      if (!current) throw new Error(`No backlog item ${id}`);
      const item = await store.update(id, {
        bucket: 'work',
        status: 'todo',
        due,
        priority,
        labels: ado ? [...current.labels.filter((l) => !l.startsWith('ado-')), `ado-${ado}`] : undefined,
      });
      return view(item);
    },
  }),
  defineTool({
    name: 'move_to_backlog',
    description: 'Park a task back in the backlog: its due date is cleared and it stops counting in the plan.',
    input: { id: idArg },
    async run({ store }, { id }) {
      return backlogView(await store.update(id, { bucket: 'backlog', due: null, status: 'todo' }));
    },
  }),
  defineTool({
    name: 'set_status',
    description: 'Move a task or backlog item between todo, in-progress and in-review; done completes it.',
    input: { id: idArg, status: z.enum([...STATUSES, 'done']) },
    async run({ store }, { id, status }) {
      if (status === 'done') {
        await store.close(id);
        return { completed: id };
      }
      return view(await store.update(id, { status }));
    },
  }),
];
