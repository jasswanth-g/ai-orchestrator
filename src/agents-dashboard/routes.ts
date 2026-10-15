import type { ActivityLog } from '../events/activity.ts';
import type { Receiver } from '../events/receiver.ts';
import type { Store } from '../store/store.ts';
import type { BridgeSupervisor } from '../whatsapp/bridge.ts';

/**
 * Agents dashboard: source status, open agent tasks, the activity feed and a
 * few task actions (done, replied, read). Local only: requests need a
 * localhost Host header (no DNS rebinding) and writes must be JSON (no
 * cross-site form posts).
 */

const page = Bun.file(new URL('./page.html', import.meta.url));
const AGENT_SOURCES = ['azure-devops', 'whatsapp'];

export function agentsDashboard(o: {
  port: number;
  store: Store;
  receivers: Receiver[];
  activity: ActivityLog;
  bridge?: BridgeSupervisor;
  adoOn: boolean;
  adoError?: string;
  todoDashboardUrl: string;
}) {
  const localHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`]);

  async function whatsappLink(): Promise<Record<string, unknown>> {
    if (!o.bridge) return { state: 'off' };
    if (o.bridge.state !== 'running') return { state: o.bridge.state };
    try {
      const s = (await (await o.bridge.api('/api/status')).json()) as Record<string, unknown>;
      return { state: s.state, account: s.account, pushName: s.push_name };
    } catch {
      return { state: 'bridge_down' };
    }
  }

  async function overview() {
    const status = async (name: string) => {
      const r = o.receivers.find((x) => x.name === name);
      return r ? { enabled: true, ...(await r.status()) } : { enabled: false };
    };
    const tasks = (await o.store.list('work'))
      .filter((t) => AGENT_SOURCES.includes(t.source))
      .map((t) => ({ id: t.id, title: t.title, source: t.source, labels: t.labels, priority: t.priority, status: t.status, link: t.link?.startsWith('http') ? t.link : undefined, createdAt: t.createdAt }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      now: new Date().toISOString(),
      todoDashboardUrl: o.todoDashboardUrl,
      sources: {
        ado: { ...(await status('ado')), error: o.adoError, hint: o.adoOn ? undefined : 'Started with ADO=off' },
        whatsapp: { ...(await status('whatsapp')), link: await whatsappLink() },
      },
      tasks,
      activity: o.activity.recent(150),
    };
  }

  /** Task actions: what each one changes on the todo-brain item. */
  const ACTIONS: Record<string, (id: string, labels: string[]) => Promise<void>> = {
    done: (id) => o.store.close(id),
    replied: (id, labels) => o.store.update(id, { labels: labels.filter((l) => l !== 'needs-reply') }).then(() => {}),
    read: (id, labels) => o.store.update(id, { labels: labels.filter((l) => l !== 'new-comment') }).then(() => {}),
  };

  async function act(id: string, action: string): Promise<Response> {
    const run = ACTIONS[action];
    if (!run) return new Response('unknown action', { status: 400 });
    const task = (await o.store.list('work')).find((t) => t.id === id && AGENT_SOURCES.includes(t.source));
    if (!task) return new Response('no such agent task', { status: 404 });
    await run(id, task.labels);
    o.activity.add({ source: 'dashboard', kind: action, subject: task.title, action: action === 'done' ? 'done' : 'annotated', reason: `marked ${action} by you`, taskId: id, link: task.link?.startsWith('http') ? task.link : undefined });
    return Response.json({ ok: true });
  }

  return async function handle(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    const task = /^\/api\/tasks\/(\d+)\/(\w+)$/.exec(url.pathname);
    if (url.pathname !== '/' && url.pathname !== '/api/overview' && !task) return undefined;
    if (!localHosts.has(req.headers.get('host') ?? '')) return new Response('forbidden', { status: 403 });
    if (task) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (req.headers.get('content-type') !== 'application/json') return new Response('JSON request required', { status: 415 });
      return act(task[1]!, task[2]!);
    }
    if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
    if (url.pathname === '/') return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    return Response.json(await overview(), { headers: { 'Cache-Control': 'no-store' } });
  };
}
