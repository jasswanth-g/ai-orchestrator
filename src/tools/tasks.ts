import { z } from 'zod';
import { rank } from '../prioritize.ts';
import { defineTool, estimateArg, idArg, priorityArg, toLabel, view } from './define.ts';

const dueArg = z.string().describe('YYYY-MM-DD, today, tomorrow, a weekday (fri), "next week" or "in N days/weeks"');

export const taskTools = [
  defineTool({
    name: 'next_tasks',
    description:
      'Open Work tasks ranked by priority, deadline and effort, each with the reasons for its place. ' +
      'Use when the user asks what to do next.',
    input: { limit: z.number().int().min(1).max(50).default(5) },
    async run({ store, today }, { limit }) {
      const ranked = rank(await store.list('work'), today());
      return {
        total: ranked.length,
        tasks: ranked.slice(0, limit).map((r) => ({ ...view(r.item), why: r.reasons.join(' · ') })),
      };
    },
  }),
  defineTool({
    name: 'add_task',
    description: 'Add a Work task. Give an estimate whenever the effort is known — plan_day uses it.',
    input: {
      title: z.string().min(1),
      priority: priorityArg.default(4),
      due: dueArg.optional(),
      estimate: estimateArg.optional(),
      labels: z.array(z.string()).optional(),
      notes: z.string().optional(),
    },
    async run({ store }, a) {
      return view(await store.create('work', { ...a, labels: a.labels?.map(toLabel) }));
    },
  }),
  defineTool({
    name: 'reprioritize',
    description: 'Change a task priority, due date and/or estimate.',
    input: { id: idArg, priority: priorityArg.optional(), due: dueArg.optional(), estimate: estimateArg.optional() },
    async run({ store }, { id, priority, due, estimate }) {
      if (!priority && !due && estimate === undefined) throw new Error('Give a priority, due date or estimate to change');
      return view(await store.update(id, { priority, due, estimate }));
    },
  }),
  defineTool({
    name: 'complete_task',
    description: 'Mark a task done.',
    input: { id: idArg },
    async run({ store }, { id }) {
      await store.close(id);
      return { completed: id };
    },
  }),
];
