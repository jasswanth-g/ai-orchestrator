import type { Store } from '../store/store.ts';
import { toLabel } from '../tools/define.ts';
import type { Item, Priority } from '../types.ts';
import { type Bug, type BugEvent, htmlToText, OPEN_STATES } from './events.ts';

/**
 * Bug events → todo-brain tasks. One task per bug, found by its ado-<id>
 * label. The task is the Investigator's queue entry: `to-investigate` marks
 * it as not looked at yet, `new-comment` marks unread discussion.
 */

export const SOURCE = 'azure-devops';
export const TO_INVESTIGATE = 'to-investigate';
export const NEW_COMMENT = 'new-comment';
/** How far back a closed task still counts as "already tracked". */
const TRACKED_DAYS = 90;

export interface Me {
  email: string;
  /** My identity id plus every group I belong to — a mention of any of them reaches me. */
  identityId: string;
  groupIds: string[];
}

export interface IntakeOptions {
  store: Store;
  me: Me;
  /** Custom.Application values I own: any new bug there becomes a task. */
  myApps: string[];
  /** Work item link, e.g. https://dev.azure.com/org/project/_workitems/edit/<id>. */
  bugUrl: (id: number) => string;
  now?: () => Date;
}

export type Outcome = { bug: number; action: 'created' | 'annotated' | 'reopened' | 'ignored'; reason: string; taskId?: string };

const adoLabel = (id: number) => `ado-${id}`;
const isOpen = (b: Bug) => OPEN_STATES.includes(b.state);
const toPriority = (p?: number): Priority | undefined => (p && p >= 1 && p <= 4 ? (p as Priority) : undefined);

export class BugIntake {
  private readonly now: () => Date;
  constructor(private readonly o: IntakeOptions) {
    this.now = o.now ?? (() => new Date());
  }

  /** The open or recently closed task for a bug. */
  async find(bugId: number): Promise<{ item: Item; closed: boolean } | undefined> {
    const label = adoLabel(bugId);
    for (const bucket of ['work', 'backlog'] as const) {
      const item = (await this.o.store.list(bucket)).find((i) => i.labels.includes(label));
      if (item) return { item, closed: false };
    }
    const since = new Date(this.now().getTime() - TRACKED_DAYS * 86_400_000).toISOString();
    const item = (await this.o.store.listCompleted('work', since)).find((i) => i.labels.includes(label));
    return item ? { item, closed: true } : undefined;
  }

  /** Why this event concerns me, or undefined when it doesn't. */
  private reasonToTrack(e: BugEvent): string | undefined {
    const { me } = this.o;
    if (e.kind === 'created') return e.bug.application && this.o.myApps.includes(e.bug.application) ? 'my-area' : undefined;
    if (e.kind === 'assigned') return e.bug.assignedTo?.email === me.email ? 'assigned' : undefined;
    if (e.kind === 'comment') {
      if (e.mentionIds.includes(me.identityId)) return 'mentioned';
      if (e.mentionIds.some((id) => me.groupIds.includes(id))) return 'team-mentioned';
    }
    return undefined;
  }

  async handle(e: BugEvent): Promise<Outcome> {
    const { bug } = e;
    if ('by' in e && e.by?.email === this.o.me.email) return { bug: bug.id, action: 'ignored', reason: 'my own change' };

    const tracked = await this.find(bug.id);
    if (!tracked) {
      const reason = this.reasonToTrack(e);
      if (!reason) return { bug: bug.id, action: 'ignored', reason: `${e.kind}: not for me` };
      if (!isOpen(bug)) return { bug: bug.id, action: 'ignored', reason: `already ${bug.state}` };
      const item = await this.create(bug, reason);
      if (e.kind === 'comment') await this.o.store.comment(item.id, this.note(e));
      return { bug: bug.id, action: 'created', reason, taskId: item.id };
    }

    const { item, closed } = tracked;
    await this.o.store.comment(item.id, this.note(e));
    const labels = new Set(item.labels);
    if (e.kind === 'comment') labels.add(NEW_COMMENT);
    if (labels.size !== item.labels.length) await this.o.store.update(item.id, { labels: [...labels] });
    if (closed && isOpen(bug)) {
      await this.o.store.reopen(item.id);
      return { bug: bug.id, action: 'reopened', reason: `${e.kind}, bug is ${bug.state}`, taskId: item.id };
    }
    return { bug: bug.id, action: 'annotated', reason: e.kind, taskId: item.id };
  }

  /** Creates the task for a bug found outside an event (startup catch-up). */
  async track(bug: Bug, reason: string): Promise<Outcome> {
    if (await this.find(bug.id)) return { bug: bug.id, action: 'ignored', reason: 'already tracked' };
    const item = await this.create(bug, reason);
    return { bug: bug.id, action: 'created', reason, taskId: item.id };
  }

  private create(bug: Bug, reason: string): Promise<Item> {
    const facts = [
      bug.application && `App: ${bug.application}`,
      bug.severity && `Severity: ${bug.severity}`,
      `State: ${bug.state}`,
      bug.createdBy && `Raised by: ${bug.createdBy.name}`,
      bug.assignedTo && `Assigned to: ${bug.assignedTo.name}`,
      `Why: ${reason}`,
    ].filter(Boolean);
    return this.o.store.create('work', {
      title: `Bug ${bug.id}: ${bug.title}`,
      notes: facts.join('\n'),
      priority: toPriority(bug.priority),
      labels: [adoLabel(bug.id), 'bug', TO_INVESTIGATE, reason, ...(bug.application ? [toLabel(bug.application)] : [])],
      source: SOURCE,
      link: this.o.bugUrl(bug.id),
    });
  }

  private note(e: BugEvent): string {
    const who = 'by' in e && e.by ? e.by.name : 'someone';
    switch (e.kind) {
      case 'comment':
        return `${who} commented: ${htmlToText(e.html)}`;
      case 'assigned':
        return `${who} assigned it to ${e.bug.assignedTo?.name ?? 'nobody'}`;
      case 'state':
        return `${who} moved it ${e.from ?? '?'} → ${e.bug.state}`;
      case 'created':
        return 'Bug created';
    }
  }
}
