import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Who's who in WhatsApp chats. Group senders usually appear as private ids
 * (LIDs); the bridge's whatsapp.db maps LIDs to phone numbers and holds your
 * contacts' names. Everything is keyed by the bare user part ("9198…" or the
 * LID number), and a person's LID and phone number are treated as one.
 */

export const userOf = (jid: string) => jid.split('@')[0]!.split(':')[0]!;

export interface People {
  /** Best display name for a sender id, or undefined. */
  name(id: string): string | undefined;
  /** All ids that are the same person (LID ↔ phone number). */
  aliases(id: string): string[];
  /** Phone number for an id, if known. */
  phone(id: string): string | undefined;
}

export function loadPeople(storeDir: string, live: Map<string, string> = new Map()): People {
  const lidToPn = new Map<string, string>();
  const pnToLid = new Map<string, string>();
  const names = new Map<string, string>();
  const file = join(storeDir, 'whatsapp.db');
  if (existsSync(file)) {
    const db = new Database(file, { readonly: true });
    try {
      for (const r of db.query<{ lid: string; pn: string }, []>('SELECT lid, pn FROM whatsmeow_lid_map').all()) {
        lidToPn.set(userOf(r.lid), userOf(r.pn));
        pnToLid.set(userOf(r.pn), userOf(r.lid));
      }
      type C = { their_jid: string; full_name: string | null; first_name: string | null; push_name: string | null; business_name: string | null };
      for (const c of db.query<C, []>('SELECT their_jid, full_name, first_name, push_name, business_name FROM whatsmeow_contacts').all()) {
        const n = c.full_name || c.first_name || c.push_name || c.business_name;
        if (n) names.set(userOf(c.their_jid), n);
      }
    } catch {
      // older bridge schema: names from live messages only
    } finally {
      db.close();
    }
  }
  const aliases = (id: string) => {
    const u = userOf(id);
    return [u, lidToPn.get(u), pnToLid.get(u)].filter((x): x is string => !!x);
  };
  return {
    aliases,
    name: (id) => {
      for (const a of aliases(id)) {
        const n = names.get(a) ?? live.get(a);
        if (n) return n;
      }
      return undefined;
    },
    phone: (id) => {
      const u = userOf(id);
      return lidToPn.get(u) ?? (pnToLid.has(u) || /^\d{10,15}$/.test(u) ? u : undefined);
    },
  };
}

export interface Sender {
  id: string;
  name?: string;
  phone?: string;
  messages: number;
  chats: string[];
  lastAt?: string;
  lastText?: string;
}

/** Everyone who has posted in these chats (not me), busiest first. */
export function listSenders(storeDir: string, chatJids: string[], people: People, chatName: (jid: string) => string): Sender[] {
  const file = join(storeDir, 'messages.db');
  if (!existsSync(file) || !chatJids.length) return [];
  const db = new Database(file, { readonly: true });
  try {
    const rows = db
      .query<{ sender: string; chat_jid: string; content: string | null; timestamp: string }, []>(
        `SELECT sender, chat_jid, content, timestamp FROM messages WHERE is_from_me = 0 AND chat_jid IN (${chatJids.map((j) => `'${j.replace(/'/g, "''")}'`).join(',')}) ORDER BY timestamp`,
      )
      .all();
    const by = new Map<string, Sender>();
    for (const r of rows) {
      const id = userOf(r.sender);
      const s = by.get(id) ?? { id, name: people.name(id), phone: people.phone(id), messages: 0, chats: [] };
      s.messages++;
      const chat = chatName(r.chat_jid);
      if (!s.chats.includes(chat)) s.chats.push(chat);
      s.lastAt = new Date(r.timestamp.replace(' ', 'T')).toISOString();
      if (r.content) s.lastText = r.content.slice(0, 120);
      by.set(id, s);
    }
    return [...by.values()].sort((a, b) => b.messages - a.messages);
  } finally {
    db.close();
  }
}
