import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Where an investigation stands. */
export type InvestigationStatus = 'running' | 'report-ready' | 'changes-requested' | 'approved' | 'rejected';

export interface Review {
  at: string;
  decision: 'approve' | 'reject' | 'changes';
  feedback?: string;
}

export interface Investigation {
  bugId: number;
  title: string;
  /** Claude Code session id — resumed with `claude --resume`. */
  sessionId: string;
  /** iTerm session showing it, while that window is open. */
  itermSession?: string;
  status: InvestigationStatus;
  startedAt: string;
  updatedAt: string;
  /** Latest report version seen (reports live in todo-brain), to notice a new or revised one. */
  reportVersion?: number;
  reportAt?: string;
  reviews: Review[];
}

/** investigations.json: one entry per bug, kept until the bug is resolved or the record is removed. */
export class Investigations {
  private items: Record<string, Investigation>;

  constructor(private readonly file: string) {
    this.items = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  }

  get(bugId: number): Investigation | undefined {
    return this.items[bugId];
  }

  all(): Investigation[] {
    return Object.values(this.items).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  put(inv: Investigation): Investigation {
    this.items[inv.bugId] = { ...inv, updatedAt: new Date().toISOString() };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.items, null, 2));
    return this.items[inv.bugId]!;
  }
}
