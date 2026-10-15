import type { ActivityLog } from '../events/activity.ts';
import type { Receiver } from '../events/receiver.ts';
import type { Store } from '../store/store.ts';
import type { BridgeSupervisor } from '../whatsapp/bridge.ts';

/**
 * Agents dashboard: source status, open agent tasks and the activity feed.
 * Read-only; local only (localhost Host header, so no DNS rebinding).
 */

const page = Bun.file(new URL('./page.html', import.meta.url));
const AGENT_SOURCES = ['azure-devops', 'whatsapp'];

export function agentsDashboard(o: {
  port: number;
  store: Store;
  receivers: Receiver[];
  activity: ActivityLog;
  bridge?: BridgeSupervisor;
  adoEnabled: boolean;
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
        ado: { ...(await status('ado')), hint: o.adoEnabled ? undefined : 'Set ADO_HOOK_SECRET to turn it on' },
        whatsapp: { ...(await status('whatsapp')), link: await whatsappLink() },
      },
      tasks,
      activity: o.activity.recent(150),
    };
  }

  return async function handle(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (url.pathname !== '/' && url.pathname !== '/api/overview') return undefined;
    if (!localHosts.has(req.headers.get('host') ?? '')) return new Response('forbidden', { status: 403 });
    if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
    if (url.pathname === '/') return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    return Response.json(await overview(), { headers: { 'Cache-Control': 'no-store' } });
  };
}
