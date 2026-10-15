import { z } from 'zod';
import { formatEstimate } from '../estimate.ts';
import { DEFAULT_ESTIMATE_MINUTES, planDay } from '../prioritize.ts';
import { defineTool, view } from './define.ts';

export const planTools = [
  defineTool({
    name: 'plan_day',
    description:
      'Plan the day: picks Work tasks that fit the available hours, ranked by priority, deadline and effort. ' +
      'Overdue and due-today tasks always go in first, even past capacity. ' +
      `Tasks without an estimate count as ${DEFAULT_ESTIMATE_MINUTES / 60}h — suggest estimates for them.`,
    input: { hours: z.number().min(0.5).max(16).default(6).describe('Focus hours available today') },
    async run({ store, today }, { hours }) {
      const p = planDay(await store.list('work'), today(), Math.round(hours * 60));
      return {
        today: today(),
        capacity: formatEstimate(p.capacityMinutes),
        planned: formatEstimate(p.plannedMinutes),
        overCapacity: p.overCapacity,
        plan: p.plan.map((r) => ({
          ...view(r.item),
          time: `${formatEstimate(r.minutes)}${r.estimateAssumed ? ' (assumed)' : ''}`,
          mustDo: r.mustDo || undefined,
          why: r.reasons.join(' · '),
        })),
        nextUp: p.didNotFit.map((r) => ({ id: r.item.id, title: r.item.title, why: r.reasons.join(' · ') })),
        unestimatedTasks: p.unestimated,
      };
    },
  }),
];
