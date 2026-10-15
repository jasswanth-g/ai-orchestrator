import { z } from 'zod';
import { defineTool, idArg, matches, newestFirst, toLabel, view } from './define.ts';

export const memoryTools = [
  defineTool({
    name: 'remember',
    description: 'Store a fact worth keeping across sessions (decisions, preferences, who owns what).',
    input: {
      fact: z.string().min(1),
      tags: z.array(z.string()).default([]),
      notes: z.string().optional(),
    },
    async run({ store }, { fact, tags, notes }) {
      return view(await store.create('memory', { title: fact, notes, labels: tags.map(toLabel) }));
    },
  }),
  defineTool({
    name: 'recall',
    description: 'Search remembered facts by words and/or tag, newest first. No arguments lists everything.',
    input: {
      query: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async run({ store }, { query, tag, limit }) {
      const label = tag ? toLabel(tag) : undefined;
      const hits = (await store.list('memory'))
        .filter((m) => !label || m.labels.includes(label))
        .filter((m) => matches(query, m.title, m.notes, m.path, m.labels.join(' ')))
        .sort(newestFirst);
      return { total: hits.length, facts: hits.slice(0, limit).map(view) };
    },
  }),
  defineTool({
    name: 'forget',
    description: 'Permanently delete a remembered fact or file location.',
    input: { id: idArg },
    async run({ store }, { id }) {
      await store.remove(id);
      return { forgotten: id };
    },
  }),
];
