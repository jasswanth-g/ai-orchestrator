import { beforeEach, describe, expect, test } from 'bun:test';
import { htmlToText, mentionIds, parsePayload, toPerson } from '../src/ado/events.ts';
import { BugIntake, NEW_COMMENT, TO_INVESTIGATE } from '../src/ado/intake.ts';
import { InMemoryStore } from '../src/store/in-memory.ts';

const ME = { email: 'me@qwipo.com', identityId: 'fb9dd439-fd08-6b65-911a-28cc5812721f' };
const MY_GROUP = '20e22acd-6baa-4920-950d-87abb38cc120';
const STRANGER = 'a65a9f1e-b353-4d39-8511-881666abb71a';
const mention = (id: string, name: string) => `<a href="#" data-vss-mention="version:2.0,${id}">@${name}</a>`;

const bugFields = (over: Record<string, unknown> = {}) => ({
  'System.WorkItemType': 'Bug',
  'System.Title': 'Order total differs from To pay',
  'System.State': 'New',
  'Custom.Application': 'eB2B Buyer App',
  'Microsoft.VSTS.Common.Priority': 2,
  'Microsoft.VSTS.Common.Severity': '3 - Medium',
  'System.CreatedBy': 'Swapna K <swapna@qwipo.com>',
  'System.AssignedTo': 'Swapna K <swapna@qwipo.com>',
  'System.ChangedBy': 'Swapna K <swapna@qwipo.com>',
  ...over,
});

const commented = (html: string, over: Record<string, unknown> = {}, id = 'evt-c') => ({
  id,
  eventType: 'workitem.commented',
  resource: { id: 21583, fields: bugFields({ 'System.History': html, ...over }) },
});

const assigned = (to: string, id = 'evt-a') => ({
  id,
  eventType: 'workitem.updated',
  resource: {
    workItemId: 21583,
    fields: { 'System.AssignedTo': { oldValue: 'Swapna K <swapna@qwipo.com>', newValue: to } },
    revision: { id: 21583, fields: bugFields({ 'System.AssignedTo': to }) },
  },
});

describe('parsePayload', () => {
  test('reads mentions, comment author and bug fields', () => {
    const [e] = parsePayload(commented(`<div>${mention(ME.identityId, 'Me')} please check</div>`));
    expect(e?.kind).toBe('comment');
    if (e?.kind !== 'comment') return;
    expect(e.mentionIds).toEqual([ME.identityId]);
    expect(e.by).toEqual({ name: 'Swapna K', email: 'swapna@qwipo.com' });
    expect(e.bug).toMatchObject({ id: 21583, state: 'New', application: 'eB2B Buyer App', priority: 2 });
  });

  test('updated event yields assigned and state changes, nothing else', () => {
    const p = assigned('Me <me@qwipo.com>');
    (p.resource.fields as Record<string, unknown>)['System.State'] = { oldValue: 'New', newValue: 'Active' };
    expect(parsePayload(p).map((e) => e.kind)).toEqual(['assigned', 'state']);
    const historyOnly = { ...p, resource: { ...p.resource, fields: { 'System.History': { newValue: 'x' } } } };
    expect(parsePayload(historyOnly)).toEqual([]);
  });

  test('parses every work item type and keeps the type', () => {
    const [e] = parsePayload(commented('hi', { 'System.WorkItemType': 'Story' }));
    expect(e?.bug.type).toBe('Story');
  });

  test('helpers', () => {
    expect(toPerson({ displayName: 'A', uniqueName: 'A@X.com' })).toEqual({ name: 'A', email: 'a@x.com' });
    expect(mentionIds(mention(STRANGER, 'X'))).toEqual([STRANGER]);
    expect(htmlToText('<div>a&nbsp;&amp; b</div><div>c</div>')).toBe('a & b\nc');
  });
});

describe('BugIntake', () => {
  let store: InMemoryStore;
  let intake: BugIntake;
  let ignored: Set<number>;
  const handle = async (p: object) => {
    const out = [];
    for (const e of parsePayload(p)) out.push(await intake.handle(e));
    return out;
  };

  beforeEach(() => {
    store = new InMemoryStore();
    ignored = new Set();
    intake = new BugIntake({ store, me: ME, isIgnored: (id) => ignored.has(id), bugUrl: (id) => `https://ado/${id}` });
  });

  const mine = { 'System.AssignedTo': 'Me <me@qwipo.com>' };

  test('a comment on a bug assigned to me creates one task carrying the comment', async () => {
    const [out] = await handle(commented('<div>can you look?</div>', mine));
    expect(out).toMatchObject({ action: 'created', reason: 'assigned' });
    const [task] = await store.list('work');
    expect(task).toMatchObject({ title: 'Bug 21583: Order total differs from To pay', priority: 2, source: 'azure-devops', link: 'https://ado/21583' });
    expect(task?.labels).toEqual(['ado-21583', 'bug', TO_INVESTIGATE, 'assigned', 'eb2b-buyer-app']);
  });

  test('a mention alone — by name or group — no longer creates a task', async () => {
    expect((await handle(commented(mention(ME.identityId, 'Me'))))[0]?.action).toBe('ignored');
    expect((await handle(commented(mention(MY_GROUP, 'Dev'), {}, 'e2')))[0]?.action).toBe('ignored');
    expect(await store.list('work')).toEqual([]);
  });

  test('a Task assigned to me is tracked without going to the Investigator', async () => {
    const [out] = await handle(assigned('Me <me@qwipo.com>', 'evt-t'));
    expect(out?.action).toBe('created');
    store = new InMemoryStore();
    intake = new BugIntake({ store, me: ME, bugUrl: (id) => `https://ado/${id}`, isOpen: (type, state) => type === 'Task' && state === 'Active' });
    const task = { ...assigned('Me <me@qwipo.com>', 'evt-t2') } as any;
    task.resource.revision.fields = { ...task.resource.revision.fields, 'System.WorkItemType': 'Task', 'System.State': 'Active' };
    await handle(task);
    const [t] = await store.list('work');
    expect(t?.title).toBe('Task 21583: Order total differs from To pay');
    expect(t?.labels).toContain('task');
    expect(t?.labels).not.toContain(TO_INVESTIGATE);
  });

  test('open/closed follows the per-type states', async () => {
    intake = new BugIntake({ store, me: ME, bugUrl: (id) => `https://ado/${id}`, isOpen: (type, state) => type === 'Feature' && state === 'Resolved' });
    expect((await intake.track({ id: 1, type: 'Feature', title: 'f', state: 'Resolved' }, 'assigned')).action).toBe('created');
    expect((await intake.track({ id: 2, type: 'Bug', title: 'b', state: 'Resolved' }, 'assigned')).action).toBe('created'); // track() trusts catch-up's filter
  });

  test('an ignored item gets no task and no notes', async () => {
    ignored.add(21583);
    const [out] = await handle(commented('<div>hi</div>', mine));
    expect(out).toMatchObject({ action: 'ignored', reason: 'you ignored this bug' });
    expect((await intake.track({ id: 21583, type: 'Bug', title: 't', state: 'Active' }, 'assigned')).action).toBe('ignored');
    expect(await store.list('work')).toEqual([]);
  });

  test('comments on untracked items not assigned to me are ignored', async () => {
    const [out] = await handle(commented(mention(STRANGER, 'Akshith')));
    expect(out?.action).toBe('ignored');
    expect(await store.list('work')).toEqual([]);
  });

  test('later comments on a tracked item are added and flagged, without a second task', async () => {
    await handle(commented('<div>first</div>', mine, 'e1'));
    const [out] = await handle(commented('<div>Still failing on UAT</div>', { 'System.ChangedBy': 'PM <pm@qwipo.com>' }, 'e2'));
    expect(out?.action).toBe('annotated');
    const tasks = await store.list('work');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.labels).toContain(NEW_COMMENT);
  });

  test('assigned to me creates a task; assigned to someone else does not', async () => {
    expect((await handle(assigned('Other <o@qwipo.com>')))[0]?.action).toBe('ignored');
    expect((await handle(assigned('Me <me@qwipo.com>')))[0]).toMatchObject({ action: 'created', reason: 'assigned' });
  });

  test('my own changes are ignored', async () => {
    const [out] = await handle(commented('<div>x</div>', { ...mine, 'System.ChangedBy': 'Me <me@qwipo.com>' }));
    expect(out?.reason).toBe('my own change');
  });

  test('a newly created bug is not tracked unless it is assigned to me', async () => {
    const created = { eventType: 'workitem.created', resource: { id: 1, fields: bugFields() } };
    expect((await handle(created))[0]?.action).toBe('ignored');
  });

  test('closed bugs are not turned into tasks', async () => {
    const [out] = await handle(commented('<div>x</div>', { ...mine, 'System.State': 'Closed' }));
    expect(out).toMatchObject({ action: 'ignored', reason: 'already Closed' });
  });

  test('a done task is reopened when the bug is reopened', async () => {
    const [first] = await handle(assigned('Me <me@qwipo.com>'));
    await store.close(first!.taskId!);
    const reopen = commented('<div>Reopening, still broken</div>', { 'System.State': 'Reopen', 'System.ChangedBy': 'QA <qa@qwipo.com>' });
    expect((await handle(reopen))[0]?.action).toBe('reopened');
    expect(await store.list('work')).toHaveLength(1);
  });

  test('track() is idempotent for startup catch-up', async () => {
    const bug = { id: 7, type: 'Bug', title: 't', state: 'Active' };
    expect((await intake.track(bug, 'assigned')).action).toBe('created');
    expect((await intake.track(bug, 'mentioned')).action).toBe('ignored');
  });
});
