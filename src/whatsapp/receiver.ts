import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../config.ts';
import { errText, type Receiver, sameSecret } from '../events/receiver.ts';
import { type ActivityLog, SourceStats } from '../events/activity.ts';
import type { SeenIds } from '../events/seen.ts';
import type { Store } from '../store/store.ts';
import { type WaMessage, WhatsAppIntake } from './intake.ts';

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
}): Receiver {
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

  async function processMessage(m: WaMessage, via: string) {
    if (o.seen.has(m.id)) return;
    if (watched(m)) {
      const out = await intake.handle(m);
      stats.record(out.action, via === 'live');
      // Ignored chatter goes to its own list; the main feed would drown in it.
      if (out.action === 'ignored') {
        if (!m.is_from_me) {
          const text = m.content || (m.media_type ? `[${m.media_type}]` : '');
          o.skipped.add({ source: 'whatsapp', kind: via, subject: m.chat_name || m.chat_jid, action: 'ignored', reason: out.reason, detail: `${m.sender_name || m.sender}: ${text.slice(0, 200)}` });
        }
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

    async status() {
      const { watch, keywords } = o.settings();
      return { watch: watch.map(chatName), keywords, checkpoint: checkpoint || undefined, ...stats.toJSON(), skipped: o.skipped.recent(100) };
    },
  };
}
