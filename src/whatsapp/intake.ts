import type { Store } from '../store/store.ts';
import { toLabel } from '../tools/define.ts';
import type { Item } from '../types.ts';

/**
 * WhatsApp messages (forwarded live by the bridge, or read back from its
 * messages.db on catch-up) → todo-brain tasks. Rule-based for now: a message
 * is "for me" when it mentions me, replies to me, is a 1:1 chat, or names a
 * keyword. One open task per chat collects every such message as a comment,
 * so a busy thread is one reply-needed item, not ten.
 */

export const SOURCE = 'whatsapp';
export const NEEDS_REPLY = 'needs-reply';

/** Shape the bridge posts (whatsapp-bridge/forward.go). */
export interface WaMessage {
  id: string;
  chat_jid: string;
  chat_name: string;
  is_group: boolean;
  sender: string;
  sender_name?: string;
  is_from_me: boolean;
  content: string;
  media_type?: string;
  filename?: string;
  timestamp: string;
  mentioned_jids?: string[];
  reply_to_id?: string;
  reply_to_sender?: string;
  reply_to_text?: string;
  me: string[];
}

export type WaOutcome = { id: string; action: 'created' | 'annotated' | 'ignored'; reason: string; taskId?: string };

/** "9198…:26@s.whatsapp.net" / "1368…@lid" / "1368…" → "1368…". */
export const userOf = (jid: string) => jid.split('@')[0]!.split(':')[0]!;

export function reasonForMe(m: WaMessage, keywords: string[]): string | undefined {
  const me = new Set(m.me.map(userOf));
  if (!m.is_group) return 'direct';
  if ((m.mentioned_jids ?? []).some((j) => me.has(userOf(j)))) return 'mentioned';
  // messages.db keeps mentions only as "@<user>" in the text.
  if ([...me].some((u) => m.content.includes(`@${u}`))) return 'mentioned';
  if (m.reply_to_sender && me.has(userOf(m.reply_to_sender))) return 'reply-to-me';
  const text = m.content.toLowerCase();
  if (keywords.some((k) => new RegExp(`\\b${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text))) return 'keyword';
  return undefined;
}

export class WhatsAppIntake {
  constructor(private readonly o: { store: Store; keywords: string[] }) {}

  private chatLabel = (m: WaMessage) => `wa-${toLabel(m.chat_name || userOf(m.chat_jid))}`;

  private async openTask(m: WaMessage): Promise<Item | undefined> {
    const label = this.chatLabel(m);
    return (await this.o.store.list('work')).find((i) => i.labels.includes(label));
  }

  private line(m: WaMessage): string {
    const body = m.content || (m.media_type ? `[${m.media_type}${m.filename ? `: ${m.filename}` : ''}]` : '');
    const quoted = m.reply_to_text ? `\n  ↪ replying to: ${m.reply_to_text.slice(0, 200)}` : '';
    return `${m.is_from_me ? 'You' : m.sender_name || m.sender}: ${body}${quoted}`;
  }

  async handle(m: WaMessage): Promise<WaOutcome> {
    const task = await this.openTask(m);

    if (m.is_from_me) {
      if (!task) return { id: m.id, action: 'ignored', reason: 'my own message' };
      // I answered in that chat: keep the history, drop the reply flag.
      await this.o.store.comment(task.id, this.line(m));
      await this.o.store.update(task.id, { labels: task.labels.filter((l) => l !== NEEDS_REPLY) });
      return { id: m.id, action: 'annotated', reason: 'you replied', taskId: task.id };
    }

    const reason = reasonForMe(m, this.o.keywords);
    if (!reason) return { id: m.id, action: 'ignored', reason: 'not for me' };

    if (task) {
      await this.o.store.comment(task.id, this.line(m));
      if (!task.labels.includes(NEEDS_REPLY)) await this.o.store.update(task.id, { labels: [...task.labels, NEEDS_REPLY] });
      return { id: m.id, action: 'annotated', reason, taskId: task.id };
    }

    const item = await this.o.store.create('work', {
      title: `WhatsApp · ${m.chat_name || m.sender_name || userOf(m.chat_jid)}: reply needed`,
      notes: this.line(m),
      labels: ['whatsapp', this.chatLabel(m), NEEDS_REPLY, reason],
      source: SOURCE,
      link: m.chat_jid,
    });
    return { id: m.id, action: 'created', reason, taskId: item.id };
  }
}
