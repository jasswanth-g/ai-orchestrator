import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Settings } from '../src/agents-settings.ts';
import { ActivityLog } from '../src/events/activity.ts';
import { SeenIds } from '../src/events/seen.ts';
import { InMemoryStore } from '../src/store/in-memory.ts';
import { listSenders, loadPeople } from '../src/whatsapp/people.ts';
import { whatsappReceiver } from '../src/whatsapp/receiver.ts';

const tmp = () => `${process.env.TMPDIR ?? '/tmp'}/team-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A bridge store: Akshith posts as LID 4147 = phone 919100000001 (a contact); Ravi is LID 1203, unmapped. */
function bridge() {
  const dir = tmp();
  mkdirSync(dir, { recursive: true });
  const wa = new Database(join(dir, 'whatsapp.db'));
  wa.run('CREATE TABLE whatsmeow_lid_map (lid TEXT PRIMARY KEY, pn TEXT)');
  wa.run('CREATE TABLE whatsmeow_contacts (our_jid TEXT, their_jid TEXT, first_name TEXT, full_name TEXT, push_name TEXT, business_name TEXT, redacted_phone TEXT)');
  wa.run("INSERT INTO whatsmeow_lid_map VALUES ('4147', '919100000001')");
  wa.run("INSERT INTO whatsmeow_contacts VALUES ('me', '919100000001@s.whatsapp.net', 'Akshith', 'Akshith Pallem', 'Akshith', NULL, NULL)");
  wa.close();
  const msgs = new Database(join(dir, 'messages.db'));
  msgs.run('CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TEXT, is_from_me BOOLEAN, media_type TEXT, filename TEXT)');
  msgs.run("INSERT INTO messages VALUES ('m1', 'g@g.us', '1203', 'orders are being rejected, please check', '2026-10-16 09:00:00+00:00', 0, NULL, NULL)");
  msgs.run("INSERT INTO messages VALUES ('m2', 'g@g.us', '4147', 'we are on it, will update by noon', '2026-10-16 09:05:00+00:00', 0, NULL, NULL)");
  msgs.close();
  return dir;
}

test('people: LID and phone are one person, named from contacts', () => {
  const p = loadPeople(bridge());
  expect(p.aliases('4147@lid')).toEqual(['4147', '919100000001']);
  expect(p.name('4147')).toBe('Akshith Pallem');
  expect(p.phone('4147')).toBe('919100000001');
  expect(p.name('1203')).toBeUndefined();
});

test('listSenders: who posted in watched groups, busiest first, with names', () => {
  const dir = bridge();
  const s = listSenders(dir, ['g@g.us'], loadPeople(dir), () => 'HUL Tech');
  expect(s.map((x) => [x.id, x.name, x.chats])).toEqual([['1203', undefined, ['HUL Tech']], ['4147', 'Akshith Pallem', ['HUL Tech']]]);
});

test('Settings: tag by phone; + and suffixes are normalised', () => {
  const st = new Settings(join(tmp(), 's.json'), { watch: [], keywords: [] });
  st.setTeamMember('+919100000001@s.whatsapp.net', 'Akshith', true);
  expect(st.team).toEqual({ '919100000001': 'Akshith' });
  st.setTeamMember('919100000001', '', false);
  expect(st.team).toEqual({});
});

test('the AI sees colleagues as [team] — tagged by phone, posting as LID — and my task notes their reply', async () => {
  const dir = bridge();
  const store = new InMemoryStore();
  const prompts: string[] = [];
  const team = { '919100000001': 'Akshith' };
  const activity = new ActivityLog(join(dir, 'a'));
  const r = whatsappReceiver({
    store, secret: 's', storeDir: dir, settings: () => ({ watch: ['g@g.us'], keywords: ['Jass'] }), seen: new SeenIds(join(dir, 'seen')),
    checkpointFile: join(dir, 'cp'), activity, skipped: new ActivityLog(join(dir, 'sk')), statsFile: join(dir, 'st'), team: () => team,
    ai: { ask: async (_s, p) => (prompts.push(p), { needMoreContext: false, forMe: false, kind: 'none', summary: '', why: 'a colleague took it' }), names: () => [], debounceMs: 20 },
  });
  const post = (body: object) => r.handle(new Request('http://x/hooks/whatsapp', { method: 'POST', headers: { authorization: 'Bearer s' }, body: JSON.stringify({ chat_jid: 'g@g.us', chat_name: 'HUL Tech', is_group: true, is_from_me: false, timestamp: '2026-10-16T09:10:00Z', me: ['me@lid'], ...body }) }));

  // A keyword hit puts a reply on me…
  await post({ id: 'k1', sender: '1203', sender_name: 'Ravi', content: 'Jass any update?' });
  expect((await store.list('work'))[0]?.labels).toContain('needs-reply');
  // …then Akshith (LID 4147, tagged by his phone number) answers in the group.
  await post({ id: 't1', sender: '4147', sender_name: 'Akshith', content: 'fix is deployed, please retry' });
  await wait(80);
  const [task] = await store.list('work');
  expect(task?.labels).toContain('team-replied');
  expect(activity.recent(5).some((a) => a.reason === 'Akshith (team) replied')).toBe(true);
  // The AI read the history with Akshith tagged and Ravi not.
  expect(prompts[0]).toContain('Akshith [team]: we are on it, will update by noon');
  expect(prompts[0]).toContain('Akshith [team]: fix is deployed, please retry');
  expect(prompts[0]).not.toContain('Ravi [team]');
});
