import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ActivityLog } from '../src/events/activity.ts';
import { SeenIds } from '../src/events/seen.ts';
import { InMemoryStore } from '../src/store/in-memory.ts';
import { whatsappReceiver } from '../src/whatsapp/receiver.ts';
import { type ChatLine, type Decision, triage } from '../src/whatsapp/triage.ts';

const lines = (n: number, from = 0): ChatLine[] => Array.from({ length: n }, (_, i) => ({ from: `p${i + from}`, text: `msg ${i + from}`, at: `2026-10-16T09:${String(10 + i).padStart(2, '0')}:00.000Z` }));
const decide = (over: Partial<Decision> = {}): Decision => ({ needMoreContext: false, forMe: true, kind: 'question', summary: 'asks you to check the payload', why: 'asked of Qwipo tech', ...over });

describe('triage chunks', () => {
  const older = lines(23); // newest first, as history() returns

  test('clear after the first 5 earlier messages: one call, 5 read', async () => {
    const prompts: string[] = [];
    const r = await triage({ chat: 'G', incoming: lines(1, 99), history: (o, l) => older.slice(o, o + l), ask: async (_s, p) => (prompts.push(p), decide()), me: { names: ['Jass'] } });
    expect(prompts).toHaveLength(1);
    expect(r.contextUsed).toBe(5);
    expect(prompts[0]).toContain('msg 0');
    expect(prompts[0]).not.toContain('msg 5');
  });

  test('asks for more until clear, 5 at a time', async () => {
    let calls = 0;
    const r = await triage({ chat: 'G', incoming: lines(1, 99), history: (o, l) => older.slice(o, o + l), ask: async () => decide({ needMoreContext: ++calls < 3 }), me: { names: [] } });
    expect(calls).toBe(3);
    expect(r.contextUsed).toBe(15);
  });

  test('stops at the start of the chat or the cap, and must decide then', async () => {
    const prompts: string[] = [];
    const r = await triage({ chat: 'G', incoming: lines(1, 99), history: (o, l) => older.slice(o, o + l), ask: async (_s, p) => (prompts.push(p), decide({ needMoreContext: true })), me: { names: [] } });
    expect(r.contextUsed).toBe(23); // 5+5+5+5+3: the 5th chunk was short → start of chat
    expect(r.needMoreContext).toBe(false);
    expect(prompts.at(-1)).toContain('decide now');
    let n = 0;
    const capped = await triage({ chat: 'G', incoming: lines(1, 99), history: (o, l) => lines(100).slice(o, o + l), ask: async () => (n++, decide({ needMoreContext: true })), me: { names: [] } });
    expect(n).toBe(6);
    expect(capped.contextUsed).toBe(30);
  });

  test('the group purpose goes into every prompt', async () => {
    const prompts: string[] = [];
    await triage({ chat: 'HUL', incoming: lines(1, 99), history: () => [], ask: async (_s, p) => (prompts.push(p), decide()), me: { names: [] }, purpose: 'HUL devs report ONDC payload issues for us to fix' });
    expect(prompts[0]).toContain('What this group is for (from the user): HUL devs report ONDC payload issues');
  });
});

describe('receiver AI step', () => {
  const tmp = () => `${process.env.TMPDIR ?? '/tmp'}/tri-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const setup = (decision: Decision | Error) => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, 'messages.db'));
    db.run('CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TEXT, is_from_me BOOLEAN, media_type TEXT, filename TEXT)');
    for (let i = 0; i < 8; i++) db.run(`INSERT INTO messages VALUES ('old${i}', 'g@g.us', 's${i}', 'earlier ${i}', '2026-10-16 09:0${i}:00+00:00', 0, NULL, NULL)`);
    db.close();
    const store = new InMemoryStore();
    const activity = new ActivityLog(join(dir, 'a.jsonl'));
    const skipped = new ActivityLog(join(dir, 's.jsonl'));
    const asked: string[] = [];
    const r = whatsappReceiver({
      store, secret: 's', storeDir: dir, settings: () => ({ watch: ['g@g.us'], keywords: [] }), seen: new SeenIds(join(dir, 'seen.json')),
      checkpointFile: join(dir, 'cp'), activity, skipped, statsFile: join(dir, 'st.json'),
      ai: { ask: async (_s, p) => { asked.push(p); if (decision instanceof Error) throw decision; return decision; }, names: () => ['Jass'], purpose: () => 'HUL integration', debounceMs: 30 },
    });
    const post = (id: string, content: string, minute: number) =>
      r.handle(new Request('http://x/hooks/whatsapp', { method: 'POST', headers: { authorization: 'Bearer s' }, body: JSON.stringify({ id, chat_jid: 'g@g.us', chat_name: 'HUL Tech', is_group: true, sender: 'p1', sender_name: 'Ravi', is_from_me: false, content, timestamp: `2026-10-16T09:${minute}:00Z`, me: ['me@lid'] }) }));
    return { store, activity, skipped, asked, post };
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('a burst is judged once with earlier context; for-me makes one task', async () => {
    const t = setup(decide());
    await t.post('n1', 'the on_search is failing again', 20);
    await t.post('n2', 'can Qwipo check today?', 21);
    await wait(150);
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]).toContain('Ravi: the on_search is failing again');
    expect(t.asked[0]).toContain('earlier 7');
    expect(t.asked[0]).toContain('HUL integration');
    const [task] = await t.store.list('work');
    expect(task?.title).toBe('WhatsApp · HUL Tech: asks you to check the payload');
    expect(task?.labels).toContain('ai-question');
  });

  test('not for me → skipped with the AI reason; AI down → rules decide', async () => {
    const no = setup(decide({ forMe: false, kind: 'none', summary: '', why: 'chit-chat' }));
    await no.post('x1', 'good morning all', 20);
    await wait(120);
    expect(await no.store.list('work')).toEqual([]);
    expect(no.skipped.recent(1)[0]?.reason).toContain('AI: chit-chat');

    const down = setup(new Error('Not logged in'));
    await down.post('y1', 'anyone?', 20);
    await wait(120);
    expect(down.skipped.recent(1)[0]?.reason).toBe('not for me (rules; AI unavailable)');
    expect(down.activity.recent(1)[0]).toMatchObject({ action: 'error' });
  });
});
