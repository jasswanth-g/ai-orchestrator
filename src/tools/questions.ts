import { z } from 'zod';
import { defineTool, idArg, matches, toLabel, view } from './define.ts';

/** Question tags that aren't the team: whose side, where it stands, and the channel capture adds. */
const QUESTION_STATES = new Set(['waiting', 'to-ask', 'in-review']);
const NOT_TEAM = new Set(['internal', 'external', ...QUESTION_STATES]);
export const isTeamLabel = (l: string) => !NOT_TEAM.has(l) && !l.startsWith('from-');

/** Swaps the question's team label (its first team label) for `team`; '' or 'other' removes it. */
export function withTeam(labels: string[], team: string): string[] {
  const i = labels.findIndex(isTeamLabel);
  const rest = i === -1 ? labels : labels.filter((_, j) => j !== i);
  return team && team !== 'other' ? [team, ...rest] : rest;
}

export const questionTools = [
  defineTool({
    name: 'ask_question',
    description:
      'Log an open doubt or question (e.g. something waiting on an external team). Topic is a person, team or subject.',
    input: {
      text: z.string().min(1),
      topic: z.string().optional().describe('Person, team or subject, e.g. "tcp-team", "ondc"'),
      notes: z.string().optional(),
      approach: z.string().optional().describe('Recommended approach or proposed solution, if there is one'),
    },
    async run({ store }, { text, topic, notes, approach }) {
      return view(await store.create('questions', { title: text, notes, approach, labels: topic ? [toLabel(topic)] : [] }));
    },
  }),
  defineTool({
    name: 'edit_question',
    description:
      'Change an open question: its wording, notes, recommended approach / proposed solution, team, or whether we are ' +
      'where it stands (to-ask, waiting on them, in-review once an answer is being checked). An empty string clears notes or approach.',
    input: {
      id: idArg,
      text: z.string().min(1).optional(),
      notes: z.string().optional(),
      approach: z.string().optional().describe('Recommended approach or proposed solution'),
      topic: z.string().optional().describe('New team / person / subject; replaces the current one'),
      state: z
        .enum(['to-ask', 'waiting', 'in-review'])
        .optional()
        .describe('to-ask = not asked yet; waiting = asked, they owe us; in-review = answer came back, checking it'),
    },
    async run({ store }, { id, text, notes, approach, topic, state }) {
      let labels: string[] | undefined;
      if (topic !== undefined || state !== undefined) {
        const current = (await store.list('questions')).find((q) => q.id === id);
        if (!current) throw new Error(`No open question ${id}`);
        labels = current.labels;
        if (topic !== undefined) labels = withTeam(labels, toLabel(topic));
        if (state !== undefined) labels = [...labels.filter((l) => !QUESTION_STATES.has(l)), state];
      }
      return view(await store.update(id, { title: text, notes, approach, labels }));
    },
  }),
  defineTool({
    name: 'open_questions',
    description: 'List unanswered questions, oldest first, optionally filtered by topic or text.',
    input: { topic: z.string().optional(), query: z.string().optional() },
    async run({ store }, { topic, query }) {
      const label = topic ? toLabel(topic) : undefined;
      const open = (await store.list('questions'))
        .filter((q) => !label || q.labels.includes(label))
        .filter((q) => matches(query, q.title, q.notes))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { total: open.length, questions: open.map(view) };
    },
  }),
  defineTool({
    name: 'answer_question',
    description: 'Record the answer to a question (saved as a comment) and close it. It stays searchable in history.',
    input: { id: idArg, answer: z.string().min(1) },
    async run({ store }, { id, answer }) {
      await store.comment(id, `Answer: ${answer}`);
      await store.close(id);
      return { answered: id };
    },
  }),
];
