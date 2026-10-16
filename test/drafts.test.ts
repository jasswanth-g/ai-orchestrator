import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ActivityLog } from '../src/events/activity.ts';
import { SeenIds } from '../src/events/seen.ts';
import { InMemoryStore } from '../src/store/in-memory.ts';
import { draftReply, Drafts } from '../src/whatsapp/drafts.ts';
import { whatsappReceiver } from '../src/whatsapp/receiver.ts';

const tmp = () => `${process.env.TMPDIR ?? '/tmp'}/drf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('the agents never send WhatsApp messages: no code calls the bridge send API', () => {
  const files: string[] = [];
  const walk = (d: string) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.ts') && files.push(join(d, f))));
  walk(new URL('../src', import.meta.url).pathname);
  const offenders = files.filter((f) => /\/api\/send\b|send_message|sendMessage/.test(readFileSync(f, 'utf8')));
  expect(offenders).toEqual([]);
});

test('draftReply asks for their voice, no invented facts, and answers the last message', async () => {
  let seen = { system: '', prompt: '' };
  const out = await draftReply({
    chat: 'Ravi',
    conversation: [{ from: 'You', text: 'will check', at: '2026-10-16T09:00:00Z' }, { from: 'Ravi', text: 'any update on the payload?', at: '2026-10-16T09:05:00Z' }],
    write: async (system, prompt) => ((seen = { system, prompt }), { reply: 'Checking now, will update by evening.', note: '' }),
    me: { names: ['Jass'] },
  });
  expect(out.reply).toContain('Checking');
  expect(seen.system).toContain('Never invent facts');
  expect(seen.prompt).toContain('[09:05] Ravi: any update on the payload?');
});

describe('receiver drafts for 1:1 chats', () => {
  const setup = () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, 'messages.db'));
    db.run('CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TEXT, is_from_me BOOLEAN, media_type TEXT, filename TEXT)');
    db.run("INSERT INTO messages VALUES ('a', '919000000002@s.whatsapp.net', '919000000002', 'hi, the order is stuck', '2026-10-16 09:00:00+00:00', 0, NULL, NULL)");
    db.close();
    const store = new InMemoryStore();
    const drafts = new Drafts(join(dir, 'drafts.json'));
    let writes = 0;
    const r = whatsappReceiver({
      store, secret: 's', storeDir: dir, settings: () => ({ watch: ['919000000002@s.whatsapp.net', 'g@g.us'], keywords: [] }), seen: new SeenIds(join(dir, 'seen.json')),
      checkpointFile: join(dir, 'cp'), activity: new ActivityLog(join(dir, 'a')), skipped: new ActivityLog(join(dir, 's')), statsFile: join(dir, 'st'),
      drafts: { store: drafts, write: async () => (writes++, { reply: 'Looking into it now.', note: 'confirm the order id' }), names: () => [], debounceMs: 20 },
    });
    const post = (body: object) => r.handle(new Request('http://x/hooks/whatsapp', { method: 'POST', headers: { authorization: 'Bearer s' }, body: JSON.stringify({ chat_name: 'Ravi', sender: '919000000002', sender_name: 'Ravi', is_from_me: false, timestamp: '2026-10-16T09:00:00Z', me: ['me@lid'], ...body }) }));
    return { r, store, drafts, post, writes: () => writes };
  };

  test('their message → a draft waits (label draft-ready); my reply clears it', async () => {
    const t = setup();
    await t.post({ id: 'a', chat_jid: '919000000002@s.whatsapp.net', is_group: false, content: 'hi, the order is stuck' });
    await wait(80);
    expect(t.drafts.get('919000000002@s.whatsapp.net')).toMatchObject({ text: 'Looking into it now.', note: 'confirm the order id' });
    expect((await t.store.list('work'))[0]?.labels).toContain('draft-ready');
    await t.post({ id: 'b', chat_jid: '919000000002@s.whatsapp.net', is_group: false, is_from_me: true, content: 'on it' });
    expect(t.drafts.get('919000000002@s.whatsapp.net')).toBeUndefined();
    expect((await t.store.list('work'))[0]?.labels).not.toContain('draft-ready');
  });

  test('a quick burst gets one draft; groups get none; Regenerate redrafts', async () => {
    const t = setup();
    await t.post({ id: 'x1', chat_jid: '919000000002@s.whatsapp.net', is_group: false, content: 'hello?' });
    await t.post({ id: 'x2', chat_jid: '919000000002@s.whatsapp.net', is_group: false, content: 'are you there' });
    await t.post({ id: 'g1', chat_jid: 'g@g.us', is_group: true, content: '@me can you check', mentioned_jids: ['me@lid'] });
    await wait(80);
    expect(t.writes()).toBe(1);
    expect(t.drafts.get('g@g.us')).toBeUndefined();
    await t.r.redraft('919000000002@s.whatsapp.net');
    expect(t.writes()).toBe(2);
  });
});
