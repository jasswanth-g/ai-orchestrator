import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { LOCATION_LABEL } from '../types.ts';
import { defineTool, matches, newestFirst, toLabel, view } from './define.ts';

/** `~/x` → home, relative → filesRoot (or cwd when unset), absolute as is. */
export const resolvePath = (p: string, filesRoot?: string) => {
  const expanded = p.startsWith('~/') ? `${homedir()}${p.slice(1)}` : p;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(filesRoot ?? process.cwd(), expanded);
};

export const fileTools = [
  defineTool({
    name: 'remember_location',
    description:
      'Record where a file or folder lives so it can be found later with where_is. ' +
      'Call this whenever you save, create or move a file in the work folder. Relative paths resolve against the work folder.',
    input: {
      path: z.string().min(1),
      description: z.string().min(1).describe('What the file is, in words the user would search for'),
      tags: z.array(z.string()).default([]),
    },
    async run({ store, filesRoot, exists }, { path, description, tags }) {
      const abs = resolvePath(path, filesRoot);
      // Same path remembered before → replace it rather than keep two entries.
      const prior = (await store.list('memory')).filter((m) => m.path === abs);
      for (const m of prior) await store.remove(m.id);
      const item = await store.create('memory', {
        title: description,
        path: abs,
        labels: [LOCATION_LABEL, ...tags.map(toLabel)],
      });
      return { ...view(item), exists: exists(abs), replaced: prior.length };
    },
  }),
  defineTool({
    name: 'where_is',
    description: 'Find a remembered file or folder by description, tag or path fragment. Returns the path and whether it still exists.',
    input: { query: z.string().min(1), limit: z.number().int().min(1).max(50).default(10) },
    async run({ store, exists }, { query, limit }) {
      const hits = (await store.list('memory'))
        .filter((m) => m.labels.includes(LOCATION_LABEL) && m.path)
        .filter((m) => matches(query, m.title, m.path, m.labels.join(' ')))
        .sort(newestFirst)
        .slice(0, limit);
      return {
        total: hits.length,
        locations: hits.map((m) => ({ id: m.id, description: m.title, path: m.path, exists: exists(m.path!) })),
      };
    },
  }),
];
