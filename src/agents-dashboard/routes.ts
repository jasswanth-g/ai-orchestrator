import type { BugNotes, NoteType, Settings } from '../agents-settings.ts';
import type { ActivityLog } from '../events/activity.ts';
import type { Receiver } from '../events/receiver.ts';
import type { Store } from '../store/store.ts';
import type { Item } from '../types.ts';
import type { BridgeSupervisor } from '../whatsapp/bridge.ts';
import { listChats } from '../whatsapp/receiver.ts';

/**
 * Agents dashboard: source status, open agent tasks, the activity feed, and
 * the controls — task actions (done, replied, read, ignore), bug notes for the
 * Investigator, ignored bugs, and the WhatsApp chat picker. Local only:
 * requests need a localhost Host header (no DNS rebinding) and writes must be
 * JSON (no cross-site form posts).
 */

const page = Bun.file(new URL('./page.html', import.meta.url));
const AGENT_SOURCES = ['azure-devops', 'whatsapp'];
const TRACKED_DAYS = 90;

/** Bug id from a task's ado-<id> label. */
const bugIdOf = (t: Pick<Item, 'labels'>) => {
  const l = t.labels.find((x) => /^ado-\d+$/.test(x));
  return l ? Number(l.slice(4)) : undefined;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function agentsDashboard(o: {
  port: number;
  store: Store;
  receivers: Receiver[];
  activity: ActivityLog;
  bridge?: BridgeSupervisor;
  adoOn: boolean;
  adoError?: string;
  settings: Settings;
  bugNotes: BugNotes;
  /** Bridge store dir, for the chat list; unset when the bridge is off. */
  waStoreDir?: string;
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

  async function agentTask(id: string): Promise<Item> {
    const task = (await o.store.list('work')).find((t) => t.id === id && AGENT_SOURCES.includes(t.source));
    if (!task) throw new HttpError(404, 'no such agent task');
    return task;
  }

  async function overview() {
    const status = async (name: string) => {
      const r = o.receivers.find((x) => x.name === name);
      return r ? { enabled: true, ...(await r.status()) } : { enabled: false };
    };
    const tasks = (await o.store.list('work'))
      .filter((t) => AGENT_SOURCES.includes(t.source))
      .map((t) => {
        const bugId = bugIdOf(t);
        return {
          id: t.id,
          title: t.title,
          source: t.source,
          labels: t.labels,
          priority: t.priority,
          status: t.status,
          link: t.link?.startsWith('http') ? t.link : undefined,
          createdAt: t.createdAt,
          bugId,
          notes: bugId ? o.bugNotes.for(bugId) : undefined,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      now: new Date().toISOString(),
      todoDashboardUrl: o.todoDashboardUrl,
      sources: {
        ado: { ...(await status('ado')), error: o.adoError, hint: o.adoOn ? undefined : 'Started with ADO=off' },
        whatsapp: { ...(await status('whatsapp')), link: await whatsappLink() },
      },
      tasks,
      ignoredBugs: [...o.settings.ignoredBugs].reverse(),
      activity: o.activity.recent(150),
    };
  }

  function chats() {
    const { watch, keywords } = o.settings.whatsapp;
    const known = o.waStoreDir ? listChats(o.waStoreDir) : [];
    const list = known.map((c) => ({ ...c, watched: watch.includes(c.jid) || watch.includes(c.name) }));
    // Watched entries the bridge hasn't seen (e.g. a name from the old env var) stay visible.
    const missing = watch.filter((w) => !known.some((c) => c.jid === w || c.name === w));
    return { chats: list, missing, keywords };
  }

  /** Writes, by path. Each returns the JSON body to send. */
  async function write(path: string, body: Record<string, unknown>): Promise<unknown> {
    let m: RegExpExecArray | null;

    if (path === '/api/settings/whatsapp') {
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      o.settings.setWhatsApp({ watch: strings(body.watch), keywords: strings(body.keywords) });
      const w = o.settings.whatsapp;
      o.activity.add({ source: 'dashboard', kind: 'settings', subject: 'WhatsApp', action: 'annotated', reason: `watching ${w.watch.length} chat(s), ${w.keywords.length} keyword(s)` });
      return w;
    }

    if ((m = /^\/api\/tasks\/(\d+)\/(done|replied|read|ignore)$/.exec(path))) {
      const id = m[1]!;
      const action = m[2]!;
      const task = await agentTask(id);
      const link = task.link?.startsWith('http') ? task.link : undefined;
      if (action === 'done') await o.store.close(id);
      if (action === 'replied') await o.store.update(id, { labels: task.labels.filter((l) => l !== 'needs-reply') });
      if (action === 'read') await o.store.update(id, { labels: task.labels.filter((l) => l !== 'new-comment') });
      if (action === 'ignore') {
        const bugId = bugIdOf(task);
        if (!bugId) throw new HttpError(400, 'only bug tasks can be ignored');
        o.settings.ignoreBug(bugId, task.title.replace(/^Bug \d+: /, ''));
        await o.store.comment(id, 'Ignored from the agents dashboard: not working on this bug.');
        await o.store.close(id);
      }
      o.activity.add({ source: 'dashboard', kind: action, subject: task.title, action: action === 'done' || action === 'ignore' ? 'done' : 'annotated', reason: `marked ${action} by you`, taskId: id, link });
      return { ok: true };
    }

    if ((m = /^\/api\/bugs\/(\d+)\/restore$/.exec(path))) {
      const bugId = Number(m[1]);
      if (!o.settings.restoreBug(bugId)) throw new HttpError(404, 'bug is not ignored');
      // Bring back its task if Ignore closed it.
      const since = new Date(Date.now() - TRACKED_DAYS * 86_400_000).toISOString();
      const task = (await o.store.listCompleted('work', since)).find((t) => bugIdOf(t) === bugId);
      if (task) await o.store.reopen(task.id);
      o.activity.add({ source: 'dashboard', kind: 'restore', subject: `Bug ${bugId}`, action: 'reopened', reason: 'restored by you', taskId: task?.id });
      return { ok: true, taskId: task?.id };
    }

    if ((m = /^\/api\/bugs\/(\d+)\/notes$/.exec(path))) {
      const bugId = Number(m[1]);
      const type: NoteType | undefined = body.type === 'recommendation' || body.type === 'comment' ? body.type : undefined;
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!type || !text) throw new HttpError(400, 'type (comment | recommendation) and text required');
      const note = o.bugNotes.add(bugId, type, text);
      const task = (await o.store.list('work')).find((t) => bugIdOf(t) === bugId);
      if (task) await o.store.comment(task.id, `Your ${type}: ${text}`);
      o.activity.add({ source: 'dashboard', kind: `note:${type}`, subject: `Bug ${bugId}`, action: 'annotated', reason: text.slice(0, 120), taskId: task?.id });
      return note;
    }

    if ((m = /^\/api\/bugs\/(\d+)\/notes\/(\d+)\/delete$/.exec(path))) {
      if (!o.bugNotes.remove(Number(m[1]), Number(m[2]))) throw new HttpError(404, 'no such note');
      return { ok: true };
    }

    throw new HttpError(404, 'not found');
  }

  return async function handle(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (url.pathname !== '/' && !url.pathname.startsWith('/api/')) return undefined;
    if (!localHosts.has(req.headers.get('host') ?? '')) return new Response('forbidden', { status: 403 });

    try {
      if (req.method === 'GET') {
        if (url.pathname === '/') return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        if (url.pathname === '/api/overview') return Response.json(await overview(), { headers: { 'Cache-Control': 'no-store' } });
        if (url.pathname === '/api/whatsapp/chats') return Response.json(chats(), { headers: { 'Cache-Control': 'no-store' } });
        throw new HttpError(404, 'not found');
      }
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      if (req.headers.get('content-type') !== 'application/json') throw new HttpError(415, 'JSON request required');
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      return Response.json(await write(url.pathname, body ?? {}));
    } catch (err) {
      if (err instanceof HttpError) return new Response(err.message, { status: err.status });
      throw err;
    }
  };
}
