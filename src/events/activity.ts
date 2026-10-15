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
  action: 'created' | 'annotated' | 'reopened' | 'ignored' | 'error' | 'done';
  reason: string;
  taskId?: string;
  link?: string;
  /** Extra line, e.g. sender and text of a skipped message. */
  detail?: string;
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

/**
 * Per-source counters and timestamps for the dashboard's source cards, saved
 * to a JSON file so they survive restarts. `since` is when counting started.
 */
export class SourceStats {
  since = new Date().toISOString();
  lastEventAt?: string;
  lastCatchUp?: { at: string; summary: string };
  counts = { created: 0, annotated: 0, reopened: 0, ignored: 0, error: 0 };

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<SourceStats>;
        this.since = saved.since ?? this.since;
        this.lastEventAt = saved.lastEventAt;
        this.lastCatchUp = saved.lastCatchUp;
        this.counts = { ...this.counts, ...saved.counts };
      } catch {
        // unreadable: start counting again
      }
    }
  }

  /** Counts an outcome; `live` = it came from an event, so it moves lastEventAt. */
  record(action: keyof SourceStats['counts'], live = true): void {
    this.counts[action]++;
    if (live) this.lastEventAt = new Date().toISOString();
    this.save();
  }

  caughtUp(summary: string): void {
    this.lastCatchUp = { at: new Date().toISOString(), summary };
    this.save();
  }

  toJSON() {
    return { since: this.since, lastEventAt: this.lastEventAt, lastCatchUp: this.lastCatchUp, counts: this.counts };
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this));
  }
}
