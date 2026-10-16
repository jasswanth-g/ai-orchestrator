import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Settings changed from the agents dashboard, kept in one JSON file next to
 * the todo-brain DB. Read on every use, so a change applies without a restart.
 */

export interface IgnoredBug {
  id: number;
  title: string;
  at: string;
}

export interface AgentSettings {
  whatsapp: {
    /** Chat JIDs (or exact names) the WhatsApp intake acts on. */
    watch: string[];
    /** Words that make a group message "for me". */
    keywords: string[];
    /** Per chat JID: what the group is for, in my words — given to the AI step. */
    purpose?: Record<string, string>;
    /** My company's people: WhatsApp ids (phone number or LID user part) → display name. */
    team?: Record<string, string>;
  };
  /** Bugs I don't want to work on: no task, later events ignored. */
  ignoredBugs: IgnoredBug[];
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

export class Settings {
  private value: AgentSettings;

  /** `defaults` seeds the file on first run (e.g. from WHATSAPP_WATCH_CHATS). */
  constructor(private readonly file: string, defaults: AgentSettings['whatsapp']) {
    const saved = readJson<Partial<AgentSettings>>(file, {});
    this.value = {
      whatsapp: { watch: saved.whatsapp?.watch ?? defaults.watch, keywords: saved.whatsapp?.keywords ?? defaults.keywords, purpose: saved.whatsapp?.purpose ?? {}, team: saved.whatsapp?.team ?? {} },
      ignoredBugs: saved.ignoredBugs ?? [],
    };
  }

  get whatsapp(): AgentSettings['whatsapp'] {
    return this.value.whatsapp;
  }

  setWhatsApp(w: AgentSettings['whatsapp']): void {
    const clean = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
    this.value.whatsapp = { watch: clean(w.watch), keywords: clean(w.keywords), purpose: this.value.whatsapp.purpose ?? {}, team: this.value.whatsapp.team ?? {} };
    writeJson(this.file, this.value);
  }

  /** What a group is for (empty text clears it). */
  setPurpose(chatJid: string, text: string): void {
    const purpose = { ...(this.value.whatsapp.purpose ?? {}) };
    const t = text.trim().slice(0, 600);
    if (t) purpose[chatJid] = t;
    else delete purpose[chatJid];
    this.value.whatsapp = { ...this.value.whatsapp, purpose };
    writeJson(this.file, this.value);
  }

  purposeOf = (chatJid: string): string | undefined => this.value.whatsapp.purpose?.[chatJid];

  /** Tag or untag a WhatsApp id as one of my company's people. */
  setTeamMember(id: string, name: string, member: boolean): void {
    const team = { ...(this.value.whatsapp.team ?? {}) };
    const key = id.replace(/^\+/, '').split('@')[0]!.split(':')[0]!;
    if (member) team[key] = name.trim() || key;
    else delete team[key];
    this.value.whatsapp = { ...this.value.whatsapp, team };
    writeJson(this.file, this.value);
  }

  get team(): Record<string, string> {
    return this.value.whatsapp.team ?? {};
  }

  get ignoredBugs(): IgnoredBug[] {
    return this.value.ignoredBugs;
  }

  isIgnored = (bugId: number): boolean => this.value.ignoredBugs.some((b) => b.id === bugId);

  ignoreBug(id: number, title: string): void {
    if (this.isIgnored(id)) return;
    this.value.ignoredBugs.push({ id, title, at: new Date().toISOString() });
    writeJson(this.file, this.value);
  }

  restoreBug(id: number): boolean {
    const before = this.value.ignoredBugs.length;
    this.value.ignoredBugs = this.value.ignoredBugs.filter((b) => b.id !== id);
    if (this.value.ignoredBugs.length === before) return false;
    writeJson(this.file, this.value);
    return true;
  }
}

/** What I add to a bug for the Investigator: a comment, or a recommended fix/approach. */
export type NoteType = 'comment' | 'recommendation';
export interface BugNote {
  type: NoteType;
  text: string;
  at: string;
}

/**
 * My notes per bug, in bug-notes.json. The Investigator reads them as input and
 * folds them into its report; they are never posted to Azure DevOps as-is.
 */
export class BugNotes {
  private notes: Record<string, BugNote[]>;

  constructor(private readonly file: string) {
    this.notes = readJson(file, {});
  }

  for(bugId: number): BugNote[] {
    return this.notes[bugId] ?? [];
  }

  add(bugId: number, type: NoteType, text: string): BugNote {
    const note = { type, text: text.trim(), at: new Date().toISOString() };
    (this.notes[bugId] ??= []).push(note);
    writeJson(this.file, this.notes);
    return note;
  }

  remove(bugId: number, index: number): boolean {
    const list = this.notes[bugId];
    if (!list?.[index]) return false;
    list.splice(index, 1);
    if (!list.length) delete this.notes[bugId];
    writeJson(this.file, this.notes);
    return true;
  }
}
