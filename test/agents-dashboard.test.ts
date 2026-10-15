import { beforeEach, describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { agentsDashboard } from '../src/agents-dashboard/routes.ts';
import { ActivityLog, SourceStats } from '../src/events/activity.ts';
import { loadOrCreateSecret } from '../src/events/receiver.ts';
import { InMemoryStore } from '../src/store/in-memory.ts';

const tmp = (name: string) => `${process.env.TMPDIR ?? '/tmp'}/${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test('SourceStats keeps counts and since across restarts', () => {
  const file = tmp('stats.json');
  const a = new SourceStats(file);
  a.record('created');
  a.record('ignored');
  a.caughtUp('3 new task(s)');
  const b = new SourceStats(file);
  expect(b.counts).toMatchObject({ created: 1, ignored: 1 });
  expect(b.since).toBe(a.since);
  expect(b.lastCatchUp?.summary).toBe('3 new task(s)');
});

test('loadOrCreateSecret creates a 0600 file once and reuses it', () => {
  const file = tmp('secret');
  const s = loadOrCreateSecret(file);
  expect(s).toHaveLength(48);
  expect(loadOrCreateSecret(file)).toBe(s);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

describe('dashboard task actions', () => {
  let store: InMemoryStore;
  let handle: (req: Request) => Promise<Response | undefined>;
  let activity: ActivityLog;
  const post = (path: string, headers: Record<string, string> = { 'content-type': 'application/json', host: '127.0.0.1:4320' }) =>
    handle(new Request(`http://127.0.0.1:4320${path}`, { method: 'POST', headers, body: '{}' }));

  beforeEach(() => {
    store = new InMemoryStore();
    activity = new ActivityLog(tmp('activity.jsonl'));
    handle = agentsDashboard({ port: 4320, store, receivers: [], activity, adoOn: true, todoDashboardUrl: 'http://127.0.0.1:4319' });
  });

  test('replied and read drop their flag; done closes the task', async () => {
    const t = await store.create('work', { title: 'WhatsApp · x', source: 'whatsapp', labels: ['whatsapp', 'needs-reply', 'new-comment'] });
    expect((await post(`/api/tasks/${t.id}/replied`))?.status).toBe(200);
    expect((await post(`/api/tasks/${t.id}/read`))?.status).toBe(200);
    expect((await store.list('work'))[0]?.labels).toEqual(['whatsapp']);
    expect((await post(`/api/tasks/${t.id}/done`))?.status).toBe(200);
    expect(await store.list('work')).toEqual([]);
    expect(activity.recent().map((a) => a.kind)).toEqual(['done', 'read', 'replied']);
  });

  test('only agent tasks, only JSON, only localhost', async () => {
    const mine = await store.create('work', { title: 'personal', source: 'manual' });
    const agent = await store.create('work', { title: 'Bug 1', source: 'azure-devops' });
    expect((await post(`/api/tasks/${mine.id}/done`))?.status).toBe(404);
    expect((await post(`/api/tasks/${agent.id}/done`, { host: '127.0.0.1:4320', 'content-type': 'text/plain' }))?.status).toBe(415);
    expect((await post(`/api/tasks/${agent.id}/done`, { host: 'evil.com', 'content-type': 'application/json' }))?.status).toBe(403);
    expect((await post(`/api/tasks/${agent.id}/explode`))?.status).toBe(400);
    expect(await store.list('work')).toHaveLength(2);
  });

  test('overview lists only agent tasks and reports an ADO start error', async () => {
    await store.create('work', { title: 'personal', source: 'manual' });
    await store.create('work', { title: 'Bug 2', source: 'azure-devops', link: 'https://ado/2' });
    handle = agentsDashboard({ port: 4320, store, receivers: [], activity, adoOn: true, adoError: 'az token failed', todoDashboardUrl: '' });
    const res = await handle(new Request('http://127.0.0.1:4320/api/overview', { headers: { host: '127.0.0.1:4320' } }));
    const d = (await res!.json()) as any;
    expect(d.tasks.map((t: any) => t.title)).toEqual(['Bug 2']);
    expect(d.sources.ado.error).toBe('az token failed');
  });
});
