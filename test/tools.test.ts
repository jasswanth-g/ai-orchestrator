import { beforeEach, describe, expect, test } from 'bun:test';
import { InMemoryStore } from '../src/store/in-memory.ts';
import type { ToolContext } from '../src/tools/define.ts';
import { ALL_TOOLS } from '../src/tools/index.ts';

let store: InMemoryStore;
let existing: Set<string>;
let ctx: ToolContext;

/** Runs a tool by name the way the server does: zod-parse, then run. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const { z } = await import('zod');
  return tool.run(ctx, z.object(tool.input).parse(args) as never);
}

beforeEach(() => {
  store = new InMemoryStore();
  existing = new Set();
  ctx = { store, filesRoot: '/work', today: () => '2026-10-01', exists: (p) => existing.has(p) };
});

test('exposes 24 tools with unique names', () => {
  const names = ALL_TOOLS.map((t) => t.name);
  expect(names).toHaveLength(24);
  expect(new Set(names).size).toBe(24);
});

describe('edit_question', () => {
  test('rewrites the question, adds an approach, swaps team and state', async () => {
    const { id } = await call('ask_question', { text: 'expiry?', topic: 'kranthi' });
    await store.update(id, { labels: ['kranthi', 'internal', 'to-ask', 'from-teams'] });
    const q = await call('edit_question', {
      id,
      text: 'How should we handle outlet expiry?',
      approach: 'Store expiry per distributor and block orders after it',
      topic: 'TCPL',
      state: 'waiting',
    });
    expect(q).toMatchObject({
      title: 'How should we handle outlet expiry?',
      approach: 'Store expiry per distributor and block orders after it',
      labels: ['tcpl', 'internal', 'from-teams', 'waiting'],
    });
    expect((await call('edit_question', { id, state: 'in-review' })).labels).toEqual(['tcpl', 'internal', 'from-teams', 'in-review']);
    expect((await call('edit_question', { id, approach: '' })).approach).toBeUndefined();
    await expect(call('edit_question', { id: '999', state: 'waiting' })).rejects.toThrow(/No open question/);
  });

  test('ask_question keeps an approach', async () => {
    expect((await call('ask_question', { text: 'q', approach: 'do X' })).approach).toBe('do X');
  });
});

describe('backlog', () => {
  test('parked items stay out of next_tasks and plan_day, grouped by area and sorted by impact', async () => {
    await call('add_backlog', { title: 'schemes', area: ['ondc-catalog'], impact: 'low' });
    await call('add_backlog', { title: 'serviceability screen', area: ['partner-portal', 'hul'], impact: 'high' });
    await call('add_backlog', { title: 'category images', area: ['ondc-catalog'], impact: 'high' });
    await call('add_task', { title: 'real work', priority: 2 });

    expect((await call('next_tasks')).tasks.map((t: any) => t.title)).toEqual(['real work']);
    const { total, groups } = await call('backlog');
    expect(total).toBe(3);
    expect(groups.map((g: any) => [g.area, g.items.map((i: any) => [i.title, i.impact])])).toEqual([
      ['ondc-catalog', [['category images', 'high'], ['schemes', 'low']]],
      ['partner-portal', [['serviceability screen', 'high']]],
    ]);
    expect((await call('backlog', { area: 'hul' })).total).toBe(1);
    expect((await call('brief')).backlog).toEqual({ total: 3, highImpact: 2 });
  });

  test('pull_into_work makes it a ranked task with a due date and ADO link; move_to_backlog parks it again', async () => {
    const { id } = await call('add_backlog', { title: 'PT6H shows Tomorrow', area: ['ondc-orders'], impact: 'high' });
    const task = await call('pull_into_work', { id, due: '2026-10-03', ado: '21465' });
    expect(task).toMatchObject({ title: 'PT6H shows Tomorrow', priority: 'P1', due: '2026-10-03', labels: ['ondc-orders', 'ado-21465'] });
    expect((await call('next_tasks')).tasks.map((t: any) => t.id)).toEqual([id]);
    await expect(call('pull_into_work', { id })).rejects.toThrow(/No backlog item/);

    const parked = await call('move_to_backlog', { id });
    expect(parked.due).toBeUndefined();
    expect((await call('next_tasks')).total).toBe(0);
  });

  test('set_status moves through the board; done completes', async () => {
    const { id } = await call('add_task', { title: 't' });
    expect((await call('set_status', { id, status: 'in-review' })).status).toBe('in-review');
    expect(await call('set_status', { id, status: 'done' })).toEqual({ completed: id });
    expect((await call('next_tasks')).total).toBe(0);
  });

  test('team tags: set on add, shown, filtered, and kept out of the area', async () => {
    await call('add_backlog', { title: 'serviceability screen', area: ['partner-portal'], team: 'Product', impact: 'high' });
    await call('add_backlog', { title: 'NACK on bad on_search', area: ['ondc-validation'], team: 'dev' });
    await call('add_backlog', { title: 'no team yet', area: ['ondc-catalog'] });
    const { groups } = await call('backlog');
    const byTitle = Object.fromEntries(groups.flatMap((g: any) => g.items).map((i: any) => [i.title, [i.area, i.team]]));
    expect(byTitle).toEqual({
      'serviceability screen': ['partner-portal', 'product'],
      'NACK on bad on_search': ['ondc-validation', 'dev'],
      'no team yet': ['ondc-catalog', undefined],
    });
    expect((await call('backlog', { team: 'Product' })).groups.flatMap((g: any) => g.items).map((i: any) => i.title)).toEqual(['serviceability screen']);
  });

  test('capture files a backlog item with its impact', async () => {
    const item = await call('capture', { text: 'MOQ not handled', kind: 'backlog', priority: 2, tags: ['ondc-orders'], source: 'teams' });
    expect(item).toMatchObject({ kind: 'backlog', priority: 'P2', labels: ['ondc-orders', 'from-teams'] });
    expect((await call('backlog')).groups[0].area).toBe('ondc-orders');
  });
});

describe('tasks', () => {
  test('next_tasks ranks by priority + deadline and explains why', async () => {
    await call('add_task', { title: 'p3', priority: 3 });
    await call('add_task', { title: 'p1 undated', priority: 1 });
    await call('add_task', { title: 'p1 due', priority: 1, due: '2026-10-05' });
    const { tasks, total } = await call('next_tasks', { limit: 2 });
    expect(total).toBe(3);
    expect(tasks.map((t: any) => t.title)).toEqual(['p1 due', 'p1 undated']);
    expect(tasks[0].why).toBe('P1 · due in 4d');
  });

  test('reprioritize needs something to change', async () => {
    const t = await call('add_task', { title: 'x' });
    await expect(call('reprioritize', { id: t.id })).rejects.toThrow('priority, due date or estimate');
    expect((await call('reprioritize', { id: t.id, priority: 2 })).priority).toBe('P2');
    expect((await call('reprioritize', { id: t.id, estimate: '1h30m' })).estimate).toBe('1h30m');
  });

  test('complete_task removes it from next_tasks', async () => {
    const t = await call('add_task', { title: 'x' });
    await call('complete_task', { id: t.id });
    expect((await call('next_tasks')).total).toBe(0);
  });
});

describe('questions', () => {
  test('topic filter and answer closes with a comment', async () => {
    const q = await call('ask_question', { text: 'Which SKU field?', topic: 'TCP Team' });
    await call('ask_question', { text: 'ONDC timeout?', topic: 'ondc' });
    expect((await call('open_questions', { topic: 'tcp team' })).questions.map((x: any) => x.title)).toEqual([
      'Which SKU field?',
    ]);
    await call('answer_question', { id: q.id, answer: 'tcpl_SFAName__c' });
    expect(store.comments.get(q.id)).toEqual(['Answer: tcpl_SFAName__c']);
    expect((await call('open_questions')).total).toBe(1);
  });
});

describe('memory', () => {
  test('recall matches every word, filters by tag, newest first', async () => {
    await call('remember', { fact: 'TCP category comes from PH2', tags: ['tcp'] });
    await call('remember', { fact: 'ONDC uses NACK 30000', tags: ['ondc'] });
    await call('remember', { fact: 'TCP SKUs grouped by SFA name', tags: ['tcp'] });
    expect((await call('recall', { tag: 'tcp' })).facts.map((f: any) => f.title)).toEqual([
      'TCP SKUs grouped by SFA name',
      'TCP category comes from PH2',
    ]);
    expect((await call('recall', { query: 'tcp ph2' })).total).toBe(1);
    const all = await call('recall');
    await call('forget', { id: all.facts[0].id });
    expect((await call('recall')).total).toBe(2);
  });
});

describe('capture', () => {
  test('routes by kind and keeps the source', async () => {
    const t = await call('capture', {
      text: 'Send TCP the field map',
      kind: 'task',
      source: 'Mail',
      link: 'https://outlook/1',
      priority: 1,
      tags: ['tcp'],
    });
    expect(t).toMatchObject({ kind: 'task', priority: 'P1', source: 'mail', link: 'https://outlook/1' });
    expect(t.labels).toEqual(['tcp', 'from-mail']);

    const q = await call('capture', { text: 'Is UAT down?', kind: 'question', source: 'whatsapp', priority: 1 });
    expect(store.items.get(q.id)).toMatchObject({ bucket: 'questions', priority: 4 }); // priority is tasks-only

    const m = await call('capture', { text: 'Ravi owns TCP UAT', kind: 'memory' });
    expect(store.items.get(m.id)).toMatchObject({ bucket: 'memory', source: 'manual', labels: [] });
  });
});

describe('files', () => {
  test('remember_location resolves relative paths and where_is finds them', async () => {
    existing.add('/work/references/tcp-field-map.md');
    const r = await call('remember_location', {
      path: 'references/tcp-field-map.md',
      description: 'TCP integration field map',
      tags: ['tcp'],
    });
    expect(r).toMatchObject({ path: '/work/references/tcp-field-map.md', exists: true, replaced: 0 });

    await call('remember', { fact: 'TCP field map is versioned weekly' }); // a plain fact, not a location
    const found = await call('where_is', { query: 'field map' });
    expect(found.locations).toEqual([
      { id: r.id, description: 'TCP integration field map', path: '/work/references/tcp-field-map.md', exists: true },
    ]);
  });

  test('re-remembering a path replaces the old entry; missing files are flagged', async () => {
    await call('remember_location', { path: '/abs/spec.pdf', description: 'old name' });
    const r = await call('remember_location', { path: '/abs/spec.pdf', description: 'ONDC spec' });
    expect(r).toMatchObject({ replaced: 1, exists: false });
    expect((await call('where_is', { query: 'spec' })).locations.map((l: any) => l.description)).toEqual(['ONDC spec']);
  });
});

describe('estimates and plan_day', () => {
  test('add_task parses estimates; bad ones are rejected', async () => {
    expect((await call('add_task', { title: 'x', estimate: '90' })).estimate).toBe('1h30m');
    await expect(call('add_task', { title: 'y', estimate: 'soon' })).rejects.toThrow("Can't read estimate");
  });

  test('capture keeps an estimate on tasks only', async () => {
    const t = await call('capture', { text: 't', kind: 'task', estimate: '30m' });
    const m = await call('capture', { text: 'm', kind: 'memory', estimate: '30m' });
    expect(store.items.get(t.id)!.estimate).toBe(30);
    expect(store.items.get(m.id)!.estimate).toBeUndefined();
  });

  test('plan_day fits the hours and reports what is next', async () => {
    await call('add_task', { title: 'report', priority: 1, estimate: '3h' });
    await call('add_task', { title: 'review', priority: 2, estimate: '2h' });
    await call('add_task', { title: 'reply', priority: 3, estimate: '30m' });
    const p = await call('plan_day', { hours: 4 });
    expect(p.plan.map((t: any) => [t.title, t.time])).toEqual([
      ['report', '3h'],
      ['reply', '30m'],
    ]);
    expect(p).toMatchObject({ capacity: '4h', planned: '3h30m', overCapacity: false, unestimatedTasks: 0 });
    expect(p.nextUp.map((t: any) => t.title)).toEqual(['review']);
  });
});

describe('brief', () => {
  test('top tasks, due-or-overdue, open questions', async () => {
    await call('add_task', { title: 'overdue', priority: 3, due: '2026-09-28' });
    await call('add_task', { title: 'today', priority: 2, due: '2026-10-01' });
    await call('add_task', { title: 'later', priority: 1, due: '2026-10-09' });
    await call('ask_question', { text: 'q1' });
    const b = await call('brief', { top: 2 });
    expect(b.today).toBe('2026-10-01');
    // overdue P3 (20+50) and today P2 (30+40) both outrank a P1 due in 8 days (40+0)
    expect(b.topTasks.map((t: any) => t.title)).toEqual(['overdue', 'today']);
    expect(b.dueTodayOrOverdue.map((t: any) => t.title)).toEqual(['overdue', 'today']);
    expect(b.openQuestions.total).toBe(1);
  });
});
