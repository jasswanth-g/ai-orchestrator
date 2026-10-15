import { beforeEach, describe, expect, test } from 'bun:test';
import { SeenIds } from '../src/events/seen.ts';
import { InMemoryStore } from '../src/store/in-memory.ts';
import { NEEDS_REPLY, reasonForMe, userOf, type WaMessage, WhatsAppIntake } from '../src/whatsapp/intake.ts';

const ME = ['919000000001:26@s.whatsapp.net', '111222333:26@lid'];
const msg = (over: Partial<WaMessage> = {}): WaMessage => ({
  id: 'm1',
  chat_jid: '120363425035763883@g.us',
  chat_name: 'EB2b tech group',
  is_group: true,
  sender: '123343021830277',
  sender_name: 'Partner',
  is_from_me: false,
  content: 'Hi team, please update',
  timestamp: '2026-10-15T09:50:37.000Z',
  me: ME,
  ...over,
});

describe('reasonForMe', () => {
  test('mention by jid, by @text, reply to me, 1:1, keyword', () => {
    expect(reasonForMe(msg({ mentioned_jids: ['111222333@lid'] }), [])).toBe('mentioned');
    expect(reasonForMe(msg({ content: 'Hey @111222333 can you check' }), [])).toBe('mentioned');
    expect(reasonForMe(msg({ reply_to_sender: '919000000001@s.whatsapp.net' }), [])).toBe('reply-to-me');
    expect(reasonForMe(msg({ is_group: false }), [])).toBe('direct');
    expect(reasonForMe(msg({ content: 'jasswanth any update?' }), ['Jasswanth'])).toBe('keyword');
  });

  test('general group chatter is not for me', () => {
    expect(reasonForMe(msg({ mentioned_jids: ['999@lid'] }), ['Jasswanth'])).toBeUndefined();
  });

  test('userOf strips server and device', () => {
    expect(userOf('111222333:26@lid')).toBe('111222333');
  });
});

describe('WhatsAppIntake', () => {
  let store: InMemoryStore;
  let intake: WhatsAppIntake;
  beforeEach(() => {
    store = new InMemoryStore();
    intake = new WhatsAppIntake({ store, keywords: () => [] });
  });

  test('one task per chat; later messages for me become comments', async () => {
    const a = await intake.handle(msg({ id: 'a', mentioned_jids: ['111222333@lid'] }));
    expect(a).toMatchObject({ action: 'created', reason: 'mentioned' });
    const b = await intake.handle(msg({ id: 'b', is_group: false }));
    expect(b.action).toBe('annotated');
    const tasks = await store.list('work');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'WhatsApp · EB2b tech group: reply needed', source: 'whatsapp' });
    expect(tasks[0]?.labels).toEqual(['whatsapp', 'wa-eb2b-tech-group', NEEDS_REPLY, 'mentioned']);
  });

  test('messages not for me create nothing', async () => {
    expect((await intake.handle(msg())).action).toBe('ignored');
    expect(await store.list('work')).toEqual([]);
  });

  test('my reply drops needs-reply; the next mention puts it back', async () => {
    await intake.handle(msg({ id: 'a', mentioned_jids: ['111222333@lid'] }));
    await intake.handle(msg({ id: 'b', is_from_me: true, content: 'On it' }));
    expect((await store.list('work'))[0]?.labels).not.toContain(NEEDS_REPLY);
    await intake.handle(msg({ id: 'c', content: '@111222333 any update?' }));
    expect((await store.list('work'))[0]?.labels).toContain(NEEDS_REPLY);
  });

  test('my own message with no open task is ignored', async () => {
    expect((await intake.handle(msg({ is_from_me: true }))).reason).toBe('my own message');
  });
});

test('SeenIds remembers across instances and trims the oldest', () => {
  const file = `${process.env.TMPDIR ?? '/tmp'}/seen-${Date.now()}.json`;
  const s = new SeenIds(file, 2);
  s.add('a');
  s.add('b');
  s.add('c');
  const again = new SeenIds(file, 2);
  expect([again.has('a'), again.has('b'), again.has('c')]).toEqual([false, true, true]);
});

test('ActivityLog keeps the newest entries across restarts', async () => {
  const { ActivityLog } = await import('../src/events/activity.ts');
  const file = `${process.env.TMPDIR ?? '/tmp'}/activity-${Date.now()}.jsonl`;
  const log = new ActivityLog(file, 3);
  for (const n of [1, 2, 3, 4]) log.add({ source: 'ado', kind: 'test', subject: `Bug ${n}`, action: 'created', reason: 'r' });
  expect(log.recent().map((a) => a.subject)).toEqual(['Bug 4', 'Bug 3', 'Bug 2']);
  expect(new ActivityLog(file, 3).recent(2).map((a) => a.subject)).toEqual(['Bug 4', 'Bug 3']);
});
