import { dirname, join } from 'node:path';
import { log } from '../config.ts';
import { errText, loadOrCreateSecret, type Receiver, sameSecret } from '../events/receiver.ts';
import { dbPath } from '../config.ts';
import { type ActivityLog, SourceStats } from '../events/activity.ts';
import type { SeenIds } from '../events/seen.ts';
import type { Store } from '../store/store.ts';
import { AdoClient, adoConfig } from './client.ts';
import { type AdoPayload, parsePayload } from './events.ts';
import { ADDED, BugIntake } from './intake.ts';

/**
 * The service hooks' basic-auth password: ADO_HOOK_SECRET, else a secret kept
 * next to the todo-brain DB (created on first use). `ado-hooks create` uses it too.
 */
export const adoHookSecret = () => process.env.ADO_HOOK_SECRET || loadOrCreateSecret(join(dirname(dbPath), 'ado-hook-secret'));

export interface AddResult {
  taskId: string;
  title: string;
  assigned: boolean;
  reopened?: boolean;
}

/** The ADO receiver also lets the dashboard add a work item by id. */
export interface AdoReceiver extends Receiver {
  /** Puts work item `id` on the board; with assignToMe, first assigns it to me in ADO. */
  addWorkItem(id: number, assignToMe: boolean): Promise<AddResult>;
}

/**
 * Azure DevOps service-hook events for Bugs → todo-brain tasks (intake.ts).
 * ADO reaches it through a tunnel; the service hook authenticates with basic
 * auth whose password is `secret`. catchUp() runs one query instead of polling.
 */
export async function adoReceiver(o: {
  store: Store;
  secret: string;
  seen: SeenIds;
  activity: ActivityLog;
  statsFile: string;
  isIgnored: (bugId: number) => boolean;
}): Promise<AdoReceiver> {
  const ado = new AdoClient(adoConfig());
  const me = await ado.me();
  const isOpen = await ado.isOpenFn();
  const intake = new BugIntake({ store: o.store, me, isIgnored: o.isIgnored, isOpen, bugUrl: ado.bugUrl });
  log(`ado: ${me.email} — open work items assigned to me`);
  const stats = new SourceStats(o.statsFile);

  const authorised = (req: Request) => {
    const m = /^Basic (.+)$/.exec(req.headers.get('authorization') ?? '');
    const password = m ? Buffer.from(m[1]!, 'base64').toString().split(':').slice(1).join(':') : '';
    return !!m && sameSecret(password, o.secret);
  };

  return {
    name: 'ado',
    path: '/hooks/ado',

    async handle(req) {
      if (!authorised(req)) return new Response('unauthorised', { status: 401 });
      const payload = (await req.json().catch(() => undefined)) as AdoPayload | undefined;
      if (!payload) return new Response('bad json', { status: 400 });
      if (payload.id && o.seen.has(payload.id)) return new Response('duplicate');
      try {
        for (const event of parsePayload(payload)) {
          const out = await intake.handle(event);
          log(`ado ${payload.eventType} ${event.bug.type} ${out.bug}: ${out.action} (${out.reason})${out.taskId ? ` task ${out.taskId}` : ''}`);
          stats.record(out.action);
          o.activity.add({ source: 'ado', kind: payload.eventType ?? 'event', subject: `${event.bug.type} ${out.bug}`, action: out.action, reason: out.reason, taskId: out.taskId, link: ado.bugUrl(out.bug) });
        }
        if (payload.id) o.seen.add(payload.id);
        return new Response('ok');
      } catch (err) {
        // A 5xx makes ADO retry the delivery.
        log(`ado failed on ${payload.eventType} ${payload.id}: ${errText(err)}`);
        stats.record('error');
        o.activity.add({ source: 'ado', kind: payload.eventType ?? 'event', subject: `Work item ${payload.resource?.workItemId ?? payload.resource?.id ?? '?'}`, action: 'error', reason: errText(err) });
        return new Response('error', { status: 500 });
      }
    },

    /**
     * Every open work item assigned to me (any type) — new ones become tasks, and
     * tasks whose item was closed or reassigned are closed. Runs on start and on
     * the dashboard's Refresh. Open = ADO state category Proposed / InProgress.
     */
    async catchUp() {
      const ids = await ado.wiql(
        "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Removed', 'Cancelled') ORDER BY [System.ChangedDate] DESC",
      );
      const mine = (await ado.bugs(ids)).filter((b) => isOpen(b.type, b.state) && b.assignedTo?.email === me.email);
      let created = 0;
      for (const item of mine) {
        const out = await intake.track(item, 'assigned');
        if (out.action === 'created') {
          created++;
          stats.record('created', false);
          log(`ado catch-up: ${item.type} ${item.id} → task ${out.taskId}`);
          o.activity.add({ source: 'ado', kind: 'catch-up', subject: `${item.type} ${item.id}`, action: 'created', reason: 'assigned', taskId: out.taskId, link: ado.bugUrl(item.id) });
        }
      }
      const closed = await intake.reconcile(new Set(mine.map((b) => b.id)), (gone) => ado.bugs(gone));
      for (const c of closed) {
        log(`ado sync: closed task ${c.taskId} — work item ${c.bug} ${c.reason}`);
        o.activity.add({ source: 'ado', kind: 'sync', subject: `Work item ${c.bug}`, action: 'done', reason: `task closed: ${c.reason}`, taskId: c.taskId, link: ado.bugUrl(c.bug) });
      }
      const summary = `${created} new, ${closed.length} closed`;
      log(`ado catch-up done: ${summary}`);
      stats.caughtUp(summary);
      return summary;
    },

    async addWorkItem(id, assignToMe) {
      let [item] = await ado.bugs([id]).catch(() => []);
      if (!item) throw new Error(`work item ${id} was not found in Azure DevOps`);
      if (!isOpen(item.type, item.state)) throw new Error(`${item.type} ${id} is ${item.state} in Azure DevOps — only open items go on the board`);
      if (o.isIgnored(id)) throw new Error(`${item.type} ${id} is on your ignore list — restore it from Ignored items first`);
      const existing = await intake.find(id);
      if (existing && !existing.closed) throw new Error(`${item.type} ${id} is already on the board (task #${existing.item.id})`);

      const alreadyMine = item.assignedTo?.email === me.email;
      if (assignToMe && !alreadyMine) {
        await ado.updateWorkItem(id, [{ op: 'add', path: '/fields/System.AssignedTo', value: me.email }]);
        item = { ...item, assignedTo: { name: me.email, email: me.email } };
      }
      const mine = assignToMe || alreadyMine;
      let taskId: string;
      let reopened = false;
      if (existing) {
        // Done or synced away earlier: bring the same task back.
        await o.store.reopen(existing.item.id);
        const labels = existing.item.labels.filter((l) => l !== ADDED);
        await o.store.update(existing.item.id, { labels: mine ? labels : [...labels, ADDED] });
        await o.store.comment(existing.item.id, `Added back from the dashboard${assignToMe && !alreadyMine ? ', and assigned to you in Azure DevOps' : ''}.`);
        taskId = existing.item.id;
        reopened = true;
      } else {
        const out = await intake.track(item, mine ? 'assigned' : ADDED);
        if (!out.taskId) throw new Error(`${item.type} ${id}: ${out.reason}`);
        taskId = out.taskId;
      }
      const how = assignToMe && !alreadyMine ? 'added and assigned to you in Azure DevOps' : mine ? 'added (already yours)' : 'added without changing the assignee';
      log(`ado: ${item.type} ${id} ${how} → task ${taskId}`);
      o.activity.add({ source: 'dashboard', kind: 'add', subject: `${item.type} ${id}`, action: reopened ? 'reopened' : 'created', reason: how, taskId, link: ado.bugUrl(id) });
      return { taskId, title: `${item.type} ${id}: ${item.title}`, assigned: mine, reopened };
    },

    async status() {
      return { account: me.email, ...stats.toJSON() };
    },
  };
}
