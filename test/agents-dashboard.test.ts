import { beforeEach, describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { agentsDashboard } from '../src/agents-dashboard/routes.ts';
import { BugNotes, Settings } from '../src/agents-settings.ts';
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
  let settings: Settings;
  let notes: BugNotes;
  const make = (extra: Record<string, unknown> = {}) =>
    agentsDashboard({ port: 4320, store, receivers: [], activity, adoOn: true, settings, bugNotes: notes, todoDashboardUrl: 'http://127.0.0.1:4319', ...extra });
  const post = (path: string, headers: Record<string, string> = { 'content-type': 'application/json', host: '127.0.0.1:4320' }) =>
    handle(new Request(`http://127.0.0.1:4320${path}`, { method: 'POST', headers, body: '{}' }));
  const postJson = (path: string, body: unknown) =>
    handle(new Request(`http://127.0.0.1:4320${path}`, { method: 'POST', headers: { 'content-type': 'application/json', host: '127.0.0.1:4320' }, body: JSON.stringify(body) }));

  beforeEach(() => {
    store = new InMemoryStore();
    activity = new ActivityLog(tmp('activity.jsonl'));
    settings = new Settings(tmp('settings.json'), { watch: [], keywords: [] });
    notes = new BugNotes(tmp('notes.json'));
    handle = make();
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
    expect((await post(`/api/tasks/${agent.id}/explode`))?.status).toBe(404);
    expect(await store.list('work')).toHaveLength(2);
  });

  test('overview lists only agent tasks and reports an ADO start error', async () => {
    await store.create('work', { title: 'personal', source: 'manual' });
    await store.create('work', { title: 'Bug 2', source: 'azure-devops', link: 'https://ado/2' });
    handle = make({ adoError: 'az token failed' });
    const res = await handle(new Request('http://127.0.0.1:4320/api/overview', { headers: { host: '127.0.0.1:4320' } }));
    const d = (await res!.json()) as any;
    expect(d.tasks.map((t: any) => t.title)).toEqual(['Bug 2']);
    expect(d.sources.ado.error).toBe('az token failed');
  });

  test('ignore closes a bug task and remembers it; restore brings it back', async () => {
    const t = await store.create('work', { title: 'Bug 42: Wrong total', source: 'azure-devops', labels: ['ado-42', 'bug'] });
    expect((await post(`/api/tasks/${t.id}/ignore`))?.status).toBe(200);
    expect(await store.list('work')).toEqual([]);
    expect(settings.ignoredBugs).toMatchObject([{ id: 42, title: 'Wrong total' }]);
    expect((await post('/api/bugs/42/restore'))?.status).toBe(200);
    expect(settings.isIgnored(42)).toBe(false);
    expect((await store.list('work')).map((x) => x.id)).toEqual([t.id]);
  });

  test('WhatsApp tasks cannot be ignored as bugs', async () => {
    const t = await store.create('work', { title: 'WhatsApp · x', source: 'whatsapp', labels: ['whatsapp'] });
    expect((await post(`/api/tasks/${t.id}/ignore`))?.status).toBe(400);
  });

  test('notes are stored per bug for the Investigator and shown on the task', async () => {
    await store.create('work', { title: 'Bug 7: x', source: 'azure-devops', labels: ['ado-7'] });
    expect((await postJson('/api/bugs/7/notes', { type: 'recommendation', text: ' use the cart total ' }))?.status).toBe(200);
    expect((await postJson('/api/bugs/7/notes', { type: 'shout', text: 'x' }))?.status).toBe(400);
    expect(notes.for(7)).toMatchObject([{ type: 'recommendation', text: 'use the cart total' }]);
    const d = (await (await handle(new Request('http://127.0.0.1:4320/api/overview', { headers: { host: '127.0.0.1:4320' } })))!.json()) as any;
    expect(d.tasks[0].notes).toHaveLength(1);
    expect((await post('/api/bugs/7/notes/0/delete'))?.status).toBe(200);
    expect(notes.for(7)).toEqual([]);
  });

  test('WhatsApp settings are saved, trimmed and de-duplicated', async () => {
    const res = await postJson('/api/settings/whatsapp', { watch: ['1@g.us', ' 1@g.us', '2@g.us'], keywords: ['Jass', ' ', 'Jass'] });
    expect(await res!.json()).toEqual({ watch: ['1@g.us', '2@g.us'], keywords: ['Jass'] });
    expect(settings.whatsapp.watch).toEqual(['1@g.us', '2@g.us']);
  });
});
