import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatLine } from './triage.ts';

/**
 * Draft replies for 1:1 WhatsApp chats. The agents never send WhatsApp
 * messages: a draft waits on the dashboard, where you edit it, copy it, or open
 * the chat in WhatsApp with it typed into the box — sending is always you.
 */

export interface Draft {
  chatJid: string;
  chatName: string;
  text: string;
  /** What to check before sending (missing facts, promises it avoided), if anything. */
  note?: string;
  /** The message it answers. */
  forMessageId: string;
  at: string;
}

export interface DraftOut {
  reply: string;
  note: string;
}

export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'note'],
  properties: {
    reply: { type: 'string', maxLength: 600, description: 'The message to send, in their voice' },
    note: { type: 'string', maxLength: 200, description: 'For them, not the recipient: what to check before sending; empty if nothing' },
  },
};

export type Write = (system: string, prompt: string) => Promise<DraftOut>;

export function draftSystem(me: { names: string[] }) {
  return `You draft WhatsApp replies for one person: a software developer at Qwipo (B2B commerce on ONDC).${me.names.length ? ` They may be called: ${me.names.join(', ')}.` : ''} Their own earlier messages are shown as "You" — match their tone, language mix and length.
Write the reply they would send to the latest message(s): short, natural, plain WhatsApp style, no greeting padding, no sign-off.
Never invent facts, dates, numbers, or commitments that aren't in the conversation. If an answer needs something you don't know, write a brief holding reply (acknowledge, say you'll check) and put what to check in note.
note is for the person, not the recipient; leave it empty if nothing needs checking.`;
}

/** Drafts a reply from the recent conversation (oldest first, ends with the message to answer). */
export async function draftReply(o: { chat: string; conversation: ChatLine[]; write: Write; me: { names: string[] } }): Promise<DraftOut> {
  const prompt = `Chat with: ${o.chat}

Conversation (oldest first; reply to the last message from them):
${o.conversation.map((l) => `[${l.at.slice(11, 16)}] ${l.from}: ${l.text}`).join('\n')}`;
  return o.write(draftSystem(o.me), prompt);
}

/** Drafts on disk (whatsapp-drafts.json), one per chat. */
export class Drafts {
  private items: Record<string, Draft>;
  constructor(private readonly file: string) {
    try {
      this.items = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    } catch {
      this.items = {};
    }
  }
  get(chatJid: string): Draft | undefined {
    return this.items[chatJid];
  }
  set(d: Draft): void {
    this.items[d.chatJid] = d;
    this.save();
  }
  /** Your edits on the dashboard. */
  edit(chatJid: string, text: string): Draft | undefined {
    const d = this.items[chatJid];
    if (!d) return undefined;
    this.items[chatJid] = { ...d, text: text.slice(0, 2000), at: new Date().toISOString() };
    this.save();
    return this.items[chatJid];
  }
  clear(chatJid: string): void {
    if (!this.items[chatJid]) return;
    delete this.items[chatJid];
    this.save();
  }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.items, null, 2));
  }
}
