import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../config.ts';
import { errText, type Receiver, sameSecret } from '../events/receiver.ts';
import { type ActivityLog, SourceStats } from '../events/activity.ts';
import type { SeenIds } from '../events/seen.ts';
import type { Store } from '../store/store.ts';
import { type WaMessage, WhatsAppIntake } from './intake.ts';
import { type Drafts, draftReply, type Write } from './drafts.ts';
import { loadPeople, type People } from './people.ts';
import { type Ask, type ChatLine, triage } from './triage.ts';

export interface WaChat {
  jid: string;
  name: string;
  isGroup: boolean;
  lastMessageAt?: string;
  messages30d: number;
}

/** Chats the bridge knows, busiest recent first — for the dashboard's chat picker. */
export function listChats(storeDir: string): WaChat[] {
  const file = join(storeDir, 'messages.db');
  if (!existsSync(file)) return [];
  const db = new Database(file, { readonly: true });
  try {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const counts = new Map<string, number>();
    for (const r of db.query<{ chat_jid: string; timestamp: string }, []>('SELECT chat_jid, timestamp FROM messages').all()) {
      if (new Date(r.timestamp.replace(' ', 'T')) > since) counts.set(r.chat_jid, (counts.get(r.chat_jid) ?? 0) + 1);
    }
    return db
      .query<{ jid: string; name: string | null; last_message_time: string | null }, []>('SELECT jid, name, last_message_time FROM chats')
      .all()
      .map((c) => ({
        jid: c.jid,
        name: c.name || c.jid.split('@')[0]!,
        isGroup: c.jid.endsWith('@g.us'),
        lastMessageAt: c.last_message_time ? new Date(c.last_message_time.replace(' ', 'T')).toISOString() : undefined,
        messages30d: counts.get(c.jid) ?? 0,
      }))
      .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  } finally {
    db.close();
  }
}

export interface WhatsAppReceiver extends Receiver {
  /** Drafts a fresh reply for a 1:1 chat now (the dashboard's Regenerate). Never sends. */
  redraft(chatJid: string): Promise<void>;
}

/**
 * Live messages from the WhatsApp bridge (bridges/whatsapp/forward.go) →
 * todo-brain tasks (intake.ts). catchUp() replays the bridge's messages.db
 * since the last message handled, so nothing is lost while we were down.
 */
export function whatsappReceiver(o: {
  store: Store;
  secret: string;
  /** Bridge store dir holding messages.db and whatsapp.db. */
  storeDir: string;
  /** Watched chats and keywords, read per message (dashboard settings). */
  settings: () => { watch: string[]; keywords: string[] };
  seen: SeenIds;
  checkpointFile: string;
  activity: ActivityLog;
  /** Messages in watched chats that were judged not for me. */
  skipped: ActivityLog;
  statsFile: string;
  /** AI reading of group context for messages the rules skip; unset = rules only. */
  ai?: { ask: Ask; names: () => string[]; purpose?: (chatJid: string) => string | undefined; debounceMs?: number };
  /** My company's people (id → name); their messages are tagged [team] for the AI. */
  team?: () => Record<string, string>;
  /** Draft replies for 1:1 chats — never sent; unset = no drafts. */
  drafts?: { store: Drafts; write: Write; names: () => string[]; debounceMs?: number };
}): WhatsAppReceiver {
  const stats = new SourceStats(o.statsFile);
  /** Watch entries are JIDs; show names where the bridge knows them. */
  const chatName = (entry: string) => (entry.includes('@') ? (listChats(o.storeDir).find((c) => c.jid === entry)?.name ?? entry) : entry);
  const intake = new WhatsAppIntake({ store: o.store, keywords: () => o.settings().keywords });
  let checkpoint = existsSync(o.checkpointFile) ? readFileSync(o.checkpointFile, 'utf8').trim() : '';
  // Nothing selected = nothing watched: every chat would sweep in personal 1:1s.
  const watched = (m: WaMessage) => {
    const { watch } = o.settings();
    return watch.includes(m.chat_jid) || (!!m.chat_name && watch.includes(m.chat_name));
  };

  // ── AI step ────────────────────────────────────────────────────────────
  // Group messages the rules skip wait briefly per chat (a burst is judged
  // together), then one AI call decides, reading earlier messages in chunks.
  const senderNames = new Map<string, string>();
  // Names from WhatsApp contacts + LID ↔ phone mapping; reloaded at most every 5 minutes.
  let people: People | undefined;
  let peopleAt = 0;
  const who = (): People => {
    if (!people || Date.now() - peopleAt > 300_000) (people = loadPeople(o.storeDir, senderNames)), (peopleAt = Date.now());
    return people;
  };
  const isTeam = (sender: string) => {
    const team = o.team?.() ?? {};
    return who().aliases(sender).some((a) => a in team);
  };
  /** "Akshith [team]" / "Ravi" / the id when nothing better is known. */
  const display = (sender: string, live?: string) => {
    const team = o.team?.() ?? {};
    const teamName = who().aliases(sender).map((a) => team[a]).find(Boolean);
    const name = teamName || live || who().name(sender) || sender;
    return isTeam(sender) ? `${name} [team]` : name;
  };
  const pending = new Map<string, { batch: WaMessage[]; timer: ReturnType<typeof setTimeout> }>();
  let queue: Promise<unknown> = Promise.resolve();

  function history(chatJid: string, before: WaMessage[]): (offset: number, limit: number) => ChatLine[] {
    const ids = new Set(before.map((m) => m.id));
    const first = new Date(before[0]!.timestamp).getTime();
    // strict: named parameters bind as `{ chat }` (without it they'd silently bind nothing).
    const db = new Database(join(o.storeDir, 'messages.db'), { readonly: true, strict: true });
    try {
      const rows = db
        .query<{ id: string; sender: string; content: string | null; media_type: string | null; timestamp: string; is_from_me: number }, { chat: string }>(
          'SELECT id, sender, content, media_type, timestamp, is_from_me FROM messages WHERE chat_jid = $chat ORDER BY timestamp DESC LIMIT 200',
        )
        .all({ chat: chatJid })
        .filter((r) => !ids.has(r.id) && new Date(r.timestamp.replace(' ', 'T')).getTime() <= first)
        .map((r) => ({
          from: r.is_from_me ? 'You' : display(r.sender, senderNames.get(r.sender)),
          text: r.content || (r.media_type ? `[${r.media_type}]` : ''),
          at: new Date(r.timestamp.replace(' ', 'T')).toISOString(),
        }));
      return (offset, limit) => rows.slice(offset, offset + limit);
    } finally {
      db.close();
    }
  }

  const lineOf = (m: WaMessage): ChatLine => ({ from: m.is_from_me ? 'You' : display(m.sender, m.sender_name), text: m.content || (m.media_type ? `[${m.media_type}]` : ''), at: m.timestamp });
  const skip = (m: WaMessage, reason: string, via: string) => {
    const text = m.content || (m.media_type ? `[${m.media_type}]` : '');
    o.skipped.add({ source: 'whatsapp', kind: via, subject: m.chat_name || m.chat_jid, action: 'ignored', reason, detail: `${m.sender_name || m.sender}: ${text.slice(0, 200)}` });
  };

  async function judge(batch: WaMessage[]) {
    const m = batch.at(-1)!;
    const chat = m.chat_name || m.chat_jid;
    try {
      const d = await triage({ chat, incoming: batch.map(lineOf), history: history(m.chat_jid, batch), ask: o.ai!.ask, me: { names: o.ai!.names() }, purpose: o.ai!.purpose?.(m.chat_jid) });
      if (d.forMe) {
        const out = await intake.fromAi(batch, d);
        stats.record(out.action, true);
        log(`whatsapp ai ${chat}: ${out.action} (${d.kind}) task ${out.taskId} — ${d.summary} [read ${d.contextUsed} earlier]`);
        o.activity.add({ source: 'whatsapp', kind: 'ai', subject: chat, action: out.action, reason: `AI (${d.kind}): ${d.summary} — read ${d.contextUsed} earlier message(s)`, taskId: out.taskId });
      } else {
        for (const x of batch) skip(x, `AI: ${d.why} (read ${d.contextUsed} earlier)`, 'ai');
      }
    } catch (err) {
      // AI unavailable (logged out, offline): the rules' "not for me" stands.
      log(`whatsapp ai failed for ${chat}: ${errText(err)}`);
      o.activity.add({ source: 'whatsapp', kind: 'ai', subject: chat, action: 'error', reason: `AI step failed, kept the rules' decision: ${errText(err).slice(0, 200)}` });
      for (const x of batch) skip(x, 'not for me (rules; AI unavailable)', 'live');
    }
  }

  // ── Drafts for 1:1 chats (never sent) ─────────────────────────────────
  const draftPending = new Map<string, { last: WaMessage; timer: ReturnType<typeof setTimeout> }>();

  /** The chat's latest messages, oldest first. */
  function recent(chatJid: string, limit: number): ChatLine[] {
    const db = new Database(join(o.storeDir, 'messages.db'), { readonly: true, strict: true });
    try {
      return db
        .query<{ sender: string; content: string | null; media_type: string | null; timestamp: string; is_from_me: number }, { chat: string; n: number }>(
          'SELECT sender, content, media_type, timestamp, is_from_me FROM messages WHERE chat_jid = $chat ORDER BY timestamp DESC LIMIT $n',
        )
        .all({ chat: chatJid, n: limit })
        .reverse()
        .map((r) => ({
          from: r.is_from_me ? 'You' : display(r.sender, senderNames.get(r.sender)),
          text: r.content || (r.media_type ? `[${r.media_type}]` : ''),
          at: new Date(r.timestamp.replace(' ', 'T')).toISOString(),
        }));
    } finally {
      db.close();
    }
  }

  async function writeDraft(m: WaMessage) {
    const d = o.drafts!;
    const chat = m.chat_name || m.sender_name || m.chat_jid;
    try {
      let conversation = recent(m.chat_jid, 12);
      // The bridge stores before forwarding, but don't rely on it: make sure the message being answered is there.
      if (!conversation.some((l) => l.text === m.content)) conversation = [...conversation, lineOf(m)];
      const out = await draftReply({ chat, conversation, write: d.write, me: { names: d.names() } });
      d.store.set({ chatJid: m.chat_jid, chatName: chat, text: out.reply, note: out.note || undefined, forMessageId: m.id, at: new Date().toISOString() });
      const taskId = await intake.markDraft(m);
      o.activity.add({ source: 'whatsapp', kind: 'draft', subject: chat, action: 'annotated', reason: 'reply drafted — waiting for you (not sent)', taskId });
    } catch (err) {
      log(`whatsapp draft failed for ${chat}: ${errText(err)}`);
      o.activity.add({ source: 'whatsapp', kind: 'draft', subject: chat, action: 'error', reason: `could not draft a reply: ${errText(err).slice(0, 200)}` });
    }
  }

  function enqueueDraft(m: WaMessage) {
    const entry = draftPending.get(m.chat_jid);
    if (entry) clearTimeout(entry.timer);
    const timer = setTimeout(() => {
      draftPending.delete(m.chat_jid);
      queue = queue.then(() => writeDraft(m));
    }, o.drafts!.debounceMs ?? 15_000);
    draftPending.set(m.chat_jid, { last: m, timer });
  }

  function enqueue(m: WaMessage) {
    const key = m.chat_jid;
    const entry = pending.get(key) ?? { batch: [], timer: undefined as never };
    clearTimeout(entry.timer);
    entry.batch.push(m);
    entry.timer = setTimeout(() => {
      pending.delete(key);
      // One AI call at a time, in arrival order.
      queue = queue.then(() => judge(entry.batch));
    }, o.ai!.debounceMs ?? 15_000);
    pending.set(key, entry);
  }

  async function processMessage(m: WaMessage, via: string) {
    if (o.seen.has(m.id)) return;
    if (m.sender_name && !m.is_from_me) senderNames.set(m.sender, m.sender_name);
    if (watched(m)) {
      // A colleague answering in a chat where I owe a reply: note it on my task.
      if (m.is_group && !m.is_from_me && via === 'live' && isTeam(m.sender)) {
        const name = display(m.sender, m.sender_name).replace(/ \[team\]$/, '');
        const taskId = await intake.teamReplied(m, name);
        if (taskId) o.activity.add({ source: 'whatsapp', kind: 'team', subject: m.chat_name || m.chat_jid, action: 'annotated', reason: `${name} (team) replied`, taskId });
      }
      const out = await intake.handle(m);
      // Live group chatter the rules skip goes to the AI step instead (not replays: no AI on old history).
      const toAi = out.action === 'ignored' && !m.is_from_me && m.is_group && via === 'live' && !!o.ai;
      if (!toAi) stats.record(out.action, via === 'live');
      // Ignored chatter goes to its own list; the main feed would drown in it.
      if (toAi) enqueue(m);
      // 1:1: I replied myself → the draft is moot; their message for me → draft a reply (never sent).
      if (!m.is_group && o.drafts && via === 'live') {
        if (m.is_from_me) {
          o.drafts.store.clear(m.chat_jid);
          const pend = draftPending.get(m.chat_jid);
          if (pend) (clearTimeout(pend.timer), draftPending.delete(m.chat_jid));
        } else if (out.action !== 'ignored') enqueueDraft(m);
      }
      else if (out.action === 'ignored') {
        if (!m.is_from_me) skip(m, out.reason, via);
      } else {
        log(`whatsapp ${via} ${m.chat_name}: ${out.action} (${out.reason}) task ${out.taskId}`);
        o.activity.add({ source: 'whatsapp', kind: via, subject: m.chat_name || m.chat_jid, action: out.action, reason: out.reason, taskId: out.taskId });
      }
    }
    o.seen.add(m.id);
    if (m.timestamp > checkpoint) writeFileSync(o.checkpointFile, (checkpoint = m.timestamp));
  }

  return {
    name: 'whatsapp',
    path: '/hooks/whatsapp',

    async handle(req) {
      if (!sameSecret(req.headers.get('authorization') ?? '', `Bearer ${o.secret}`)) return new Response('unauthorised', { status: 401 });
      const m = (await req.json().catch(() => undefined)) as WaMessage | undefined;
      if (!m?.id || !m.chat_jid) return new Response('bad message', { status: 400 });
      try {
        await processMessage({ ...m, timestamp: new Date(m.timestamp).toISOString() }, 'live');
        return new Response('ok');
      } catch (err) {
        log(`whatsapp failed on ${m.id}: ${errText(err)}`);
        stats.record('error');
        o.activity.add({ source: 'whatsapp', kind: 'live', subject: m.chat_name || m.chat_jid, action: 'error', reason: errText(err) });
        return new Response('error', { status: 500 });
      }
    },

    /** Replays messages.db since the checkpoint (first run: last 24h). */
    async catchUp() {
      const msgsDb = join(o.storeDir, 'messages.db');
      if (!existsSync(msgsDb)) return log(`whatsapp catch-up skipped: no ${msgsDb}`);
      const device = new Database(join(o.storeDir, 'whatsapp.db'), { readonly: true })
        .query<{ jid: string; lid: string | null }, []>('SELECT jid, lid FROM whatsmeow_device LIMIT 1')
        .get();
      const me = [device?.jid, device?.lid].filter((x): x is string => !!x);
      const since = checkpoint ? new Date(checkpoint) : new Date(Date.now() - 86_400_000);

      type Row = { id: string; chat_jid: string; name: string | null; sender: string; content: string | null; timestamp: string; is_from_me: number; media_type: string | null; filename: string | null };
      const rows = new Database(msgsDb, { readonly: true })
        .query<Row, []>(
          `SELECT m.id, m.chat_jid, c.name, m.sender, m.content, m.timestamp, m.is_from_me, m.media_type, m.filename
           FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid`,
        )
        .all()
        .map((r) => ({ ...r, at: new Date(r.timestamp.replace(' ', 'T')) }))
        .filter((r) => r.at > since)
        .sort((a, b) => a.at.getTime() - b.at.getTime());

      for (const r of rows) {
        await processMessage(
          {
            id: r.id,
            chat_jid: r.chat_jid,
            chat_name: r.name ?? '',
            is_group: r.chat_jid.endsWith('@g.us'),
            sender: r.sender,
            is_from_me: !!r.is_from_me,
            content: r.content ?? '',
            media_type: r.media_type ?? undefined,
            filename: r.filename ?? undefined,
            timestamp: r.at.toISOString(),
            me,
          },
          'catch-up',
        );
      }
      log(`whatsapp catch-up done: ${rows.length} message(s) since ${since.toISOString()}`);
      stats.caughtUp(`${rows.length} message(s) replayed`);
      return `${rows.length} new message(s) checked`;
    },

    async redraft(chatJid) {
      if (!o.drafts) throw new Error('drafts are off');
      const lines = recent(chatJid, 12);
      const lastTheirs = [...lines].reverse().find((l) => l.from !== 'You');
      if (!lastTheirs) throw new Error('no message from them to reply to');
      const name = o.drafts.store.get(chatJid)?.chatName ?? listChats(o.storeDir).find((c) => c.jid === chatJid)?.name ?? chatJid;
      await writeDraft({ id: `redraft-${Date.now()}`, chat_jid: chatJid, chat_name: name, is_group: false, sender: '', is_from_me: false, content: lastTheirs.text, timestamp: lastTheirs.at, me: [] });
    },

    async status() {
      const { watch, keywords } = o.settings();
      return { watch: watch.map(chatName), keywords, checkpoint: checkpoint || undefined, ...stats.toJSON(), skipped: o.skipped.recent(100) };
    },
  };
}
