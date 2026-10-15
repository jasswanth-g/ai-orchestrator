import { log } from '../config.ts';
import { errText, type Receiver, sameSecret } from '../events/receiver.ts';
import { type ActivityLog, SourceStats } from '../events/activity.ts';
import type { SeenIds } from '../events/seen.ts';
import type { Store } from '../store/store.ts';
import { AdoClient, adoConfig } from './client.ts';
import { type AdoPayload, OPEN_STATES, parsePayload } from './events.ts';
import { BugIntake } from './intake.ts';

/**
 * Azure DevOps service-hook events for Bugs → todo-brain tasks (intake.ts).
 * ADO reaches it through a tunnel; the service hook authenticates with basic
 * auth whose password is `secret`. catchUp() runs one query instead of polling.
 */
export async function adoReceiver(o: { store: Store; secret: string; myApps: string[]; seen: SeenIds; activity: ActivityLog }): Promise<Receiver> {
  const ado = new AdoClient(adoConfig());
  const me = await ado.me();
  const intake = new BugIntake({ store: o.store, me, myApps: o.myApps, bugUrl: ado.bugUrl });
  log(`ado: ${me.email}, ${me.groupIds.length} groups, my apps: ${o.myApps.join(', ') || 'none'}`);
  const stats = new SourceStats();

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
          log(`ado ${payload.eventType} Bug ${out.bug}: ${out.action} (${out.reason})${out.taskId ? ` task ${out.taskId}` : ''}`);
          stats.record(out.action);
          o.activity.add({ source: 'ado', kind: payload.eventType ?? 'event', subject: `Bug ${out.bug}`, action: out.action, reason: out.reason, taskId: out.taskId, link: ado.bugUrl(out.bug) });
        }
        if (payload.id) o.seen.add(payload.id);
        return new Response('ok');
      } catch (err) {
        // A 5xx makes ADO retry the delivery.
        log(`ado failed on ${payload.eventType} ${payload.id}: ${errText(err)}`);
        stats.record('error');
        o.activity.add({ source: 'ado', kind: payload.eventType ?? 'event', subject: `Bug ${payload.resource?.workItemId ?? payload.resource?.id ?? '?'}`, action: 'error', reason: errText(err) });
        return new Response('error', { status: 500 });
      }
    },

    /** Open bugs assigned to me, mentioning me, or new in my apps this week. */
    async catchUp() {
      const open = OPEN_STATES.map((s) => `'${s}'`).join(',');
      const base = `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Bug' AND [System.State] IN (${open})`;
      const sets: Array<[string, string]> = [
        ['assigned', `${base} AND [System.AssignedTo] = @Me`],
        ['mentioned', `${base} AND [System.Id] IN (@RecentMentions)`],
      ];
      if (o.myApps.length) {
        const apps = o.myApps.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
        sets.push(['my-area', `${base} AND [Custom.Application] IN (${apps}) AND [System.CreatedDate] >= @Today - 7`]);
      }
      let created = 0;
      for (const [reason, query] of sets) {
        for (const bug of await ado.bugs(await ado.wiql(query))) {
          const out = await intake.track(bug, reason);
          if (out.action === 'created') {
            created++;
            log(`ado catch-up: Bug ${bug.id} → task ${out.taskId} (${reason})`);
            o.activity.add({ source: 'ado', kind: 'catch-up', subject: `Bug ${bug.id}`, action: 'created', reason, taskId: out.taskId, link: ado.bugUrl(bug.id) });
          }
        }
      }
      log(`ado catch-up done: ${created} new task(s)`);
      stats.caughtUp(`${created} new task(s)`);
    },

    async status() {
      return { account: me.email, groups: me.groupIds.length, myApps: o.myApps, ...stats };
    },
  };
}
