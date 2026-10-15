import { beforeEach, expect, test } from 'bun:test';
import { dashboardState } from '../src/dashboard/state.ts';
import { InMemoryStore } from '../src/store/in-memory.ts';
import type { ToolContext } from '../src/tools/define.ts';
import { LOCATION_LABEL } from '../src/types.ts';

let store: InMemoryStore;
let ctx: ToolContext;

beforeEach(() => {
  store = new InMemoryStore();
  ctx = { store, filesRoot: '/work', today: () => '2026-10-01', exists: (p) => p === '/work/spec.md' };
});

test('ranks tasks, splits out must-do work and plans within the hours', async () => {
  await store.create('work', { title: 'later', priority: 4, estimate: 120 });
  await store.create('work', { title: 'overdue', priority: 2, due: '2026-09-29', estimate: 60 });
  await store.create('work', { title: 'quick', priority: 1, estimate: 30 });

  const s = await dashboardState(ctx, 2);
  expect(s.today).toBe('2026-10-01');
  expect(s.tasks.map((t: any) => t.title)).toEqual(['overdue', 'quick', 'later']);
  expect((s.tasks[0] as any).why).toBe('P2 · overdue 2d');
  expect(s.dueTodayOrOverdue.map((t: any) => t.title)).toEqual(['overdue']);
  expect(s.plan.items.map((t: any) => [t.title, t.mustDo])).toEqual([['overdue', true], ['quick', false]]);
  expect(s.plan).toMatchObject({ capacityMinutes: 120, plannedMinutes: 90, overCapacity: false });
});

test('separates file locations from memories and checks they exist', async () => {
  await store.create('memory', { title: 'prefers short PRs' });
  await store.create('memory', { title: 'spec', path: '/work/spec.md', labels: [LOCATION_LABEL] });
  await store.create('memory', { title: 'gone', path: '/work/gone.md', labels: [LOCATION_LABEL] });
  await store.create('questions', { title: 'who owns billing?' });

  const s = await dashboardState(ctx, 6);
  expect(s.memories.map((m: any) => m.title)).toEqual(['prefers short PRs']);
  expect(Object.fromEntries(s.locations.map((l: any) => [l.title, l.exists]))).toEqual({ spec: true, gone: false });
  expect(s.questions.map((q: any) => q.title)).toEqual(['who owns billing?']);
});

test('groups questions by team: internal first, waiting split from to-ask', async () => {
  await store.create('questions', { title: 'TCPL: daily API limits?', labels: ['tcpl', 'external', 'to-ask'] });
  await store.create('questions', { title: 'HUL: wholesaler?', labels: ['hul', 'external', 'waiting'] });
  await store.create('questions', { title: 'Kranthi: answer L1–L13?', labels: ['kranthi', 'internal', 'waiting', 'from-teams'] });
  await store.create('questions', { title: 'TCPL: order-id field?', labels: ['tcpl', 'external', 'waiting'] });
  await store.create('questions', { title: 'who owns billing?' });
  await store.create('questions', { title: 'TCPL: expiry answer OK?', labels: ['tcpl', 'external', 'in-review'] });

  const { questionGroups } = await dashboardState(ctx, 6);
  const titles = (qs: any[]) => qs.map((q) => q.title);
  expect(questionGroups.map((g) => [g.team, g.side])).toEqual([
    ['kranthi', 'internal'],
    ['hul', 'external'],
    ['tcpl', 'external'],
    ['other', 'unknown'],
  ]);
  const tcpl = questionGroups.find((g) => g.team === 'tcpl')!;
  expect(titles(tcpl.waiting)).toEqual(['TCPL: order-id field?']);
  expect(titles(tcpl.toAsk)).toEqual(['TCPL: daily API limits?']);
  expect(titles(tcpl.inReview)).toEqual(['TCPL: expiry answer OK?']);
  expect(titles(questionGroups.at(-1)!.untagged)).toEqual(['who owns billing?']);
});

test('the board gets recently completed tasks, newest first; reopened ones go back', async () => {
  const a = await store.create('work', { title: 'shipped' });
  const b = await store.create('work', { title: 'also shipped' });
  await store.create('work', { title: 'open' });
  await store.close(a.id);
  await store.close(b.id);

  let s = await dashboardState(ctx, 6);
  expect(s.tasks.map((t: any) => t.title)).toEqual(['open']);
  expect(s.completed.map((t: any) => t.title).sort()).toEqual(['also shipped', 'shipped']);
  expect(s.completed[0]!.closedAt).toBeString();

  await store.reopen(a.id);
  s = await dashboardState(ctx, 6);
  expect(s.completed.map((t: any) => t.title)).toEqual(['also shipped']);
});
