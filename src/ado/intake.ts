import type { Store } from '../store/store.ts';
import { toLabel } from '../tools/define.ts';
import type { Item, Priority } from '../types.ts';
import { type Bug, type BugEvent, htmlToText, OPEN_STATES } from './events.ts';

/** Is this state still open for this work item type? (ADO state categories Proposed / InProgress.) */
export type IsOpen = (type: string, state: string) => boolean;
const fallbackIsOpen: IsOpen = (_type, state) => OPEN_STATES.includes(state);

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
  /** Only a mention of this id counts — group mentions (@Dev, @QA) don't. */
  identityId: string;
}

export interface IntakeOptions {
  store: Store;
  me: Me;
  /** Items I chose to ignore: no task, and later events are dropped. */
  isIgnored?: (bugId: number) => boolean;
  /** Per-type open states from ADO; defaults to the Bug states. */
  isOpen?: IsOpen;
  /** Work item link, e.g. https://dev.azure.com/org/project/_workitems/edit/<id>. */
  bugUrl: (id: number) => string;
  now?: () => Date;
}

export type Outcome = { bug: number; action: 'created' | 'annotated' | 'reopened' | 'ignored'; reason: string; taskId?: string };

const adoLabel = (id: number) => `ado-${id}`;
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

  private isOpen = (b: Bug) => (this.o.isOpen ?? fallbackIsOpen)(b.type, b.state);

  /**
   * Why this event concerns me, else undefined. Only work items assigned to me
   * are tracked; mentions alone don't create a task (later comments on a
   * tracked item are still added to it).
   */
  private reasonToTrack(e: BugEvent): string | undefined {
    if (e.bug.assignedTo?.email === this.o.me.email && (e.kind === 'assigned' || e.kind === 'comment' || e.kind === 'state' || e.kind === 'created')) return 'assigned';
    return undefined;
  }

  async handle(e: BugEvent): Promise<Outcome> {
    const { bug } = e;
    if (this.o.isIgnored?.(bug.id)) return { bug: bug.id, action: 'ignored', reason: 'you ignored this bug' };
    if ('by' in e && e.by?.email === this.o.me.email) return { bug: bug.id, action: 'ignored', reason: 'my own change' };

    const tracked = await this.find(bug.id);
    if (!tracked) {
      const reason = this.reasonToTrack(e);
      if (!reason) return { bug: bug.id, action: 'ignored', reason: `${e.kind}: not for me` };
      if (!this.isOpen(bug)) return { bug: bug.id, action: 'ignored', reason: `already ${bug.state}` };
      const item = await this.create(bug, reason);
      if (e.kind === 'comment') await this.o.store.comment(item.id, this.note(e));
      return { bug: bug.id, action: 'created', reason, taskId: item.id };
    }

    const { item, closed } = tracked;
    await this.o.store.comment(item.id, this.note(e));
    const labels = new Set(item.labels);
    if (e.kind === 'comment') labels.add(NEW_COMMENT);
    if (labels.size !== item.labels.length) await this.o.store.update(item.id, { labels: [...labels] });
    if (closed && this.isOpen(bug)) {
      await this.o.store.reopen(item.id);
      return { bug: bug.id, action: 'reopened', reason: `${e.kind}, bug is ${bug.state}`, taskId: item.id };
    }
    return { bug: bug.id, action: 'annotated', reason: e.kind, taskId: item.id };
  }

  /**
   * Closes board tasks whose work item left my plate: closed/resolved in ADO,
   * or assigned to someone else. `stillMine` = ids currently open and assigned
   * to me; `fetch` reads the others to say why. Returns what was closed.
   */
  async reconcile(stillMine: Set<number>, fetch: (ids: number[]) => Promise<Bug[]>): Promise<Outcome[]> {
    const open = (await this.o.store.list('work')).filter((t) => t.source === SOURCE);
    const idOf = (t: Item) => Number(t.labels.find((l) => /^ado-\d+$/.test(l))?.slice(4));
    const gone = open.filter((t) => idOf(t) && !stillMine.has(idOf(t)));
    if (!gone.length) return [];
    const items = new Map((await fetch(gone.map(idOf))).map((b) => [b.id, b]));
    const out: Outcome[] = [];
    for (const task of gone) {
      const bug = items.get(idOf(task));
      const reason = !bug
        ? 'no longer found in Azure DevOps'
        : !this.isOpen(bug)
          ? `${bug.state} in Azure DevOps`
          : `now assigned to ${bug.assignedTo?.name ?? 'nobody'}`;
      await this.o.store.comment(task.id, `Closed by sync: ${reason}.`);
      await this.o.store.close(task.id);
      out.push({ bug: idOf(task), action: 'ignored', reason, taskId: task.id });
    }
    return out;
  }

  /** Creates the task for a bug found outside an event (startup catch-up). */
  async track(bug: Bug, reason: string): Promise<Outcome> {
    if (this.o.isIgnored?.(bug.id)) return { bug: bug.id, action: 'ignored', reason: 'you ignored this bug' };
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
    const isBug = bug.type === 'Bug';
    return this.o.store.create('work', {
      title: `${bug.type} ${bug.id}: ${bug.title}`,
      notes: facts.join('\n'),
      priority: toPriority(bug.priority),
      // Only Bugs go to the Investigator.
      labels: [adoLabel(bug.id), toLabel(bug.type), ...(isBug ? [TO_INVESTIGATE] : []), reason, ...(bug.application ? [toLabel(bug.application)] : [])],
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
        return `${e.bug.type} created`;
    }
  }
}
