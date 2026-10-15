import { planDay, rank, type Ranked } from '../prioritize.ts';
import { groupBacklog, TEAMS } from '../tools/backlog.ts';
import { isTeamLabel } from '../tools/questions.ts';
import type { ToolContext } from '../tools/define.ts';
import { view } from '../tools/define.ts';
import { type Item, LOCATION_LABEL } from '../types.ts';

/** Ranked task as the page shows it: the item plus its score and reasons. */
const rankedView = (r: Ranked) => ({ ...view(r.item), score: r.score, why: r.reasons.join(' · '), daysLeft: r.daysLeft });

/**
 * Open questions grouped by team, so each person's asks read as one list:
 * internal teams first, then external ones, then anything untagged. Inside a
 * team, "waiting" (they owe us) is split from "to-ask" (we still have to ask)
 * and "in-review" (an answer came back and we are checking it).
 */
export function groupQuestions(questions: Item[]) {
  type Side = 'internal' | 'external' | 'unknown';
  type Group = { team: string; side: Side; waiting: ReturnType<typeof view>[]; toAsk: ReturnType<typeof view>[]; inReview: ReturnType<typeof view>[]; untagged: ReturnType<typeof view>[] };
  const groups = new Map<string, Group>();
  for (const q of questions) {
    const labels = q.labels;
    const team = labels.find(isTeamLabel) ?? 'other';
    const side: Side = labels.includes('internal') ? 'internal' : labels.includes('external') ? 'external' : 'unknown';
    const g = groups.get(team) ?? { team, side, waiting: [], toAsk: [], inReview: [], untagged: [] };
    if (g.side === 'unknown') g.side = side;
    const list = labels.includes('in-review') ? g.inReview : labels.includes('waiting') ? g.waiting : labels.includes('to-ask') ? g.toAsk : g.untagged;
    list.push(view(q));
    groups.set(team, g);
  }
  const order = { internal: 0, external: 1, unknown: 2 } as const;
  return [...groups.values()].sort((a, b) => order[a.side] - order[b.side] || a.team.localeCompare(b.team));
}

/** Everything the dashboard renders, in one read of the store. */
/** How far back the board's Completed column looks. */
export const COMPLETED_DAYS = 14;
const COMPLETED_MAX = 30;

export async function dashboardState({ store, today, exists }: ToolContext, hours: number) {
  const since = new Date(Date.now() - COMPLETED_DAYS * 864e5).toISOString();
  const [tasks, questions, memories, backlog, completed] = await Promise.all([
    store.list('work'),
    store.list('questions'),
    store.list('memory'),
    store.list('backlog'),
    store.listCompleted('work', since),
  ]);
  const day = today();
  const ranked = rank(tasks, day);
  const plan = planDay(tasks, day, Math.round(hours * 60));
  const isLocation = (m: (typeof memories)[number]) => m.labels.includes(LOCATION_LABEL);
  const byNewest = <T extends { createdAt: string }>(a: T, b: T) => b.createdAt.localeCompare(a.createdAt);

  return {
    today: day,
    tasks: ranked.map(rankedView),
    completed: completed.slice(0, COMPLETED_MAX).map((i) => ({ ...view(i), closedAt: i.closedAt })),
    dueTodayOrOverdue: ranked.filter((r) => r.daysLeft !== undefined && r.daysLeft <= 0).map(rankedView),
    plan: {
      capacityMinutes: plan.capacityMinutes,
      plannedMinutes: plan.plannedMinutes,
      overCapacity: plan.overCapacity,
      unestimated: plan.unestimated,
      items: plan.plan.map((p) => ({ ...rankedView(p), minutes: p.minutes, estimateAssumed: p.estimateAssumed, mustDo: p.mustDo })),
    },
    backlog: { total: backlog.length, groups: groupBacklog(backlog), teams: TEAMS },
    questions: questions.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(view),
    questionGroups: groupQuestions(questions),
    memories: memories.filter((m) => !isLocation(m)).sort(byNewest).map(view),
    locations: memories
      .filter(isLocation)
      .sort(byNewest)
      .map((m) => ({ ...view(m), exists: m.path ? exists(m.path) : false })),
  };
}

export type DashboardState = Awaited<ReturnType<typeof dashboardState>>;
