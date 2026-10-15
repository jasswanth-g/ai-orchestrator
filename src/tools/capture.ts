import { z } from 'zod';
import { DEFAULT_SOURCE, KIND_TO_BUCKET, KNOWN_SOURCES, type Kind } from '../types.ts';
import { defineTool, estimateArg, priorityArg, toLabel, view } from './define.ts';

export const captureTools = [
  defineTool({
    name: 'capture',
    description:
      'File something from any channel (a mail, a WhatsApp or Teams message) as a task, question, memory or backlog item ' +
      '(backlog = should be handled some day, not committed), ' +
      'keeping where it came from. Read the message with that channel\'s own MCP tools first, then call this.',
    input: {
      text: z.string().min(1).describe('Short, actionable summary — becomes the item title'),
      kind: z.enum(Object.keys(KIND_TO_BUCKET) as [Kind, ...Kind[]]),
      source: z
        .string()
        .default(DEFAULT_SOURCE)
        .describe(`Channel it came from. Suggested: ${KNOWN_SOURCES.join(', ')} — any new channel name works`),
      link: z.string().optional().describe('URL or id of the original message'),
      priority: priorityArg.optional().describe('Tasks: 1 = P1 … 4 = P4. Backlog: impact, 1 = high, 2 = medium, 3 = low'),
      due: z.string().optional().describe('Tasks only'),
      estimate: estimateArg.optional().describe('Tasks only. Effort, e.g. 30m, 2h'),
      tags: z.array(z.string()).default([]).describe('Topic / person labels'),
      notes: z.string().optional().describe('Extra context, e.g. the sender and the key lines'),
    },
    async run({ store }, a) {
      const source = toLabel(a.source) || DEFAULT_SOURCE;
      const labels = [...a.tags.map(toLabel), ...(source !== DEFAULT_SOURCE ? [`from-${source}`] : [])];
      const isTask = a.kind === 'task';
      const ranked = isTask || a.kind === 'backlog';
      const item = await store.create(KIND_TO_BUCKET[a.kind], {
        title: a.text,
        notes: a.notes,
        labels,
        source,
        link: a.link,
        priority: ranked ? a.priority : undefined,
        due: isTask ? a.due : undefined,
        estimate: ranked ? a.estimate : undefined,
      });
      return { kind: a.kind, ...view(item) };
    },
  }),
];
