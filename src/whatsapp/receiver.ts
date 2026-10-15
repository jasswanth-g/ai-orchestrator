import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../config.ts';
import { errText, type Receiver, sameSecret } from '../events/receiver.ts';
import { type ActivityLog, SourceStats } from '../events/activity.ts';
import type { SeenIds } from '../events/seen.ts';
import type { Store } from '../store/store.ts';
import { type WaMessage, WhatsAppIntake } from './intake.ts';

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
  watch: string[];
  keywords: string[];
  seen: SeenIds;
  checkpointFile: string;
  activity: ActivityLog;
}): Receiver {
  const stats = new SourceStats();
  const intake = new WhatsAppIntake({ store: o.store, keywords: o.keywords });
  let checkpoint = existsSync(o.checkpointFile) ? readFileSync(o.checkpointFile, 'utf8').trim() : '';
  const watched = (m: WaMessage) => !o.watch.length || o.watch.includes(m.chat_jid) || o.watch.includes(m.chat_name);

  async function processMessage(m: WaMessage, via: string) {
    if (o.seen.has(m.id)) return;
    if (watched(m)) {
      const out = await intake.handle(m);
      stats.record(out.action);
      // Ignored chatter is only counted; the feed would drown in it.
      if (out.action !== 'ignored') {
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
    },

    async status() {
      return { watch: o.watch, keywords: o.keywords, checkpoint: checkpoint || undefined, ...stats };
    },
  };
}
