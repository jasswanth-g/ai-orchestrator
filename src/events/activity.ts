import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** One thing an agent input did, for the dashboard feed. */
export interface Activity {
  at: string;
  source: string;
  /** Event type or channel step, e.g. workitem.commented, live, catch-up. */
  kind: string;
  /** What it was about, e.g. "Bug 21583" or a chat name. */
  subject: string;
  action: 'created' | 'annotated' | 'reopened' | 'ignored' | 'error';
  reason: string;
  taskId?: string;
  link?: string;
}

/**
 * Recent activity, newest last, persisted as JSON lines so the feed survives a
 * restart. Trimmed to `max` entries when loaded and every `max` appends.
 */
export class ActivityLog {
  private readonly items: Activity[];
  private sinceTrim = 0;

  constructor(private readonly file: string, private readonly max = 500) {
    this.items = existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .flatMap((l) => {
            try {
              return [JSON.parse(l) as Activity];
            } catch {
              return [];
            }
          })
          .slice(-max)
      : [];
    this.rewrite();
  }

  add(a: Omit<Activity, 'at'> & { at?: string }): void {
    const item = { at: new Date().toISOString(), ...a };
    this.items.push(item);
    appendFileSync(this.file, `${JSON.stringify(item)}\n`);
    if (this.items.length > this.max) this.items.shift();
    if (++this.sinceTrim >= this.max) this.rewrite();
  }

  recent(n = 100): Activity[] {
    return this.items.slice(-n).reverse();
  }

  private rewrite(): void {
    this.sinceTrim = 0;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, this.items.map((i) => `${JSON.stringify(i)}\n`).join(''));
  }
}

/** Per-source counters and timestamps for the dashboard's source cards. */
export class SourceStats {
  lastEventAt?: string;
  lastCatchUp?: { at: string; summary: string };
  counts = { created: 0, annotated: 0, reopened: 0, ignored: 0, error: 0 };

  record(action: keyof SourceStats['counts']): void {
    this.counts[action]++;
    this.lastEventAt = new Date().toISOString();
  }

  caughtUp(summary: string): void {
    this.lastCatchUp = { at: new Date().toISOString(), summary };
  }
}
