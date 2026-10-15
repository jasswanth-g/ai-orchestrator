import { z } from 'zod';
import { rank } from '../prioritize.ts';
import { defineTool, view } from './define.ts';

export const briefTools = [
  defineTool({
    name: 'brief',
    description:
      'One-call overview: top-ranked tasks, tasks due today or overdue, open questions and a backlog count. Use at the start of a session or when the user switches context.',
    input: { top: z.number().int().min(1).max(20).default(5) },
    async run({ store, today }, { top }) {
      const [tasks, questions, backlog] = await Promise.all([store.list('work'), store.list('questions'), store.list('backlog')]);
      const day = today();
      const ranked = rank(tasks, day);
      const withWhy = (r: (typeof ranked)[number]) => ({ ...view(r.item), why: r.reasons.join(' · ') });
      const oldestQuestions = questions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return {
        today: day,
        topTasks: ranked.slice(0, top).map(withWhy),
        dueTodayOrOverdue: ranked.filter((r) => r.daysLeft !== undefined && r.daysLeft <= 0).map(withWhy),
        openQuestions: { total: questions.length, oldest: oldestQuestions.slice(0, top).map(view) },
        // Just the counts: the backlog is optional work, listed only when asked for (backlog tool).
        backlog: { total: backlog.length, highImpact: backlog.filter((i) => i.priority === 1).length },
      };
    },
  }),
];
