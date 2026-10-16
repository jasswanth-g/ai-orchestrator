import type { AdoClient } from '../ado/client.ts';
import type { AdoReceiver } from '../ado/receiver.ts';
import { doneLabel, planTransition } from '../ado/transitions.ts';
import type { BugNotes, NoteType, Settings } from '../agents-settings.ts';
import type { ActivityLog } from '../events/activity.ts';
import type { Receiver } from '../events/receiver.ts';
import type { ReportsDb } from '../store/reports.ts';
import type { Store } from '../store/store.ts';
import type { Item } from '../types.ts';
import type { Developer } from '../developer/service.ts';
import type { Investigator } from '../investigator/service.ts';
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
/** Shared UI shell (sidebar, top bar, tokens), also used by the WhatsApp page. */
const ASSETS: Record<string, { file: ReturnType<typeof Bun.file>; type: string }> = {
  '/assets/shell.css': { file: Bun.file(new URL('./shell.css', import.meta.url)), type: 'text/css; charset=utf-8' },
  '/assets/shell.js': { file: Bun.file(new URL('./shell.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
};
const AGENT_SOURCES = ['azure-devops', 'whatsapp'];
/** One page, three views: the client shows the sections for its path. */
const PAGES = new Set(['/', '/messenger', '/investigator', '/developer', '/activity']);
const TRACKED_DAYS = 90;
/** Work item type labels the intake adds (toLabel of System.WorkItemType). */
const TYPE_LABELS = ['bug', 'task', 'story', 'issue', 'feature', 'epic'];

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
  /** Unset when ADO is off or failed to start. */
  investigator?: Investigator;
  /** Unset when ADO is off. */
  developer?: Developer;
  /** Which commit the server runs vs. what's on disk (stale = restart needed). */
  codeStatus?: () => { running: string; current: string; stale: boolean };
  /** For Done → Azure DevOps state changes; unset when ADO is off. */
  ado?: AdoClient;
  reports?: ReportsDb;
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
    const investigations = new Map((await o.investigator?.refresh())?.map((i) => [i.bugId, i]) ?? []);
    const devSessions = new Map((await o.developer?.refresh())?.map((d) => [d.bugId, d]) ?? []);
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
          // What Done does in Azure DevOps (undefined = nothing is sent).
          donePlan: bugId && o.ado ? doneLabel(TYPE_LABELS.find((l) => t.labels.includes(l)), o.reports?.get(bugId)?.verdict) : undefined,
          investigation: bugId ? investigations.get(bugId) : undefined,
          development: bugId ? devSessions.get(bugId) : undefined,
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
      investigatorOn: !!o.investigator,
      developerOn: !!o.developer,
      code: o.codeStatus?.(),
      developments: [...devSessions.values()].map((d) => {
        const r = o.reports?.devResult(d.bugId);
        return {
          ...d,
          link: o.investigator?.bugUrl(d.bugId),
          result: r ? { version: r.version, passed: r.tests.filter((t) => t.result === 'passed').length, failed: r.tests.filter((t) => t.result === 'failed').length, files: r.changes.reduce((n, c) => n + c.files.length, 0) } : undefined,
        };
      }),
      knowledgeFile: o.investigator?.knowledgeFile,
      investigations: [...investigations.values()].map((i) => {
        const r = o.investigator!.report(i.bugId).report;
        return { ...i, link: o.investigator!.bugUrl(i.bugId), report: r ? { version: r.version, verdict: r.verdict, confidence: r.confidence } : undefined };
      }),
      ignoredBugs: [...o.settings.ignoredBugs].reverse(),
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

  /**
   * Done on an Azure DevOps task moves the work item per transitions.ts and
   * adds its comment. Returns what happened, or undefined when nothing is sent.
   * Throws (task stays open) if ADO refuses the change.
   */
  async function doneInAdo(task: Item): Promise<string | undefined> {
    const bugId = bugIdOf(task);
    if (!bugId || !o.ado) return undefined;
    const item = await o.ado.workItem(bugId);
    const type = item.fields['System.WorkItemType'];
    const plan = planTransition('done', { type, fields: item.fields }, o.reports?.get(bugId));
    if (!plan) return undefined;
    const target = plan.ops.find((p) => p.path === '/fields/System.State')?.value;
    if (target === item.fields['System.State'] && !plan.comment) return `already ${target}`;
    try {
      await o.ado.updateWorkItem(bugId, plan.ops);
      if (plan.comment) await o.ado.addComment(bugId, plan.comment);
    } catch (err) {
      const why = `Azure DevOps refused ${type} ${bugId} → ${plan.label}: ${err instanceof Error ? err.message.replace(/^ADO \S+ \S+ → /, '') : err}`;
      o.activity.add({ source: 'dashboard', kind: 'done', subject: task.title, action: 'error', reason: why.slice(0, 300), taskId: task.id });
      throw new HttpError(502, why);
    }
    return `${type} ${bugId} → ${plan.label}${plan.comment ? ' + comment' : ''}`;
  }

  /** Activity search: every word must appear in the event (subject, reason, kind, source, task); newest first. */
  function searchActivity(params: URLSearchParams) {
    const words = (params.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const source = params.get('source');
    const items = o.activity
      .recent(500)
      .filter((a) => !source || source === 'all' || a.source === source)
      .filter((a) => {
        const text = [a.subject, a.reason, a.kind, a.source, a.action, a.detail, a.taskId && `#${a.taskId}`].join(' ').toLowerCase();
        return words.every((w) => text.includes(w));
      });
    return { total: items.length, items: items.slice(0, 200) };
  }

  /** Refresh: run every source's catch-up now. One at a time — a second click waits for the first. */
  let syncing: Promise<unknown> | undefined;
  async function sync() {
    syncing ??= (async () => {
      const results: Array<{ source: string; summary?: string; error?: string }> = [];
      for (const r of o.receivers) {
        try {
          results.push({ source: r.name, summary: (await r.catchUp()) || 'done' });
        } catch (err) {
          results.push({ source: r.name, error: err instanceof Error ? err.message : String(err) });
        }
      }
      o.activity.add({ source: 'dashboard', kind: 'refresh', subject: 'Refresh', action: results.some((x) => x.error) ? 'error' : 'annotated', reason: results.map((x) => `${x.source}: ${x.error ?? x.summary}`).join(' · ') });
      return { results };
    })().finally(() => (syncing = undefined));
    return syncing;
  }

  /** Writes, by path. Each returns the JSON body to send. */
  async function write(path: string, body: Record<string, unknown>): Promise<unknown> {
    let m: RegExpExecArray | null;

    if (path === '/api/sync') return sync();

    if (path === '/api/workitems') {
      const ado = o.receivers.find((r) => r.name === 'ado') as AdoReceiver | undefined;
      if (!ado?.addWorkItem) throw new HttpError(409, 'Azure DevOps is not connected');
      const id = Number(String(body.id ?? '').replace(/^#/, '').trim());
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'enter a work item number, e.g. 21582');
      try {
        return await ado.addWorkItem(id, body.assignToMe === true);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message.replace(/^ADO \S+ \S+ → /, 'Azure DevOps: ') : String(err));
      }
    }

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
      let adoResult: string | undefined;
      if (action === 'done') {
        adoResult = await doneInAdo(task);
        await o.store.close(id);
      }
      if (action === 'replied') await o.store.update(id, { labels: task.labels.filter((l) => l !== 'needs-reply') });
      if (action === 'read') await o.store.update(id, { labels: task.labels.filter((l) => l !== 'new-comment') });
      if (action === 'ignore') {
        const bugId = bugIdOf(task);
        if (!bugId) throw new HttpError(400, 'only bug tasks can be ignored');
        o.settings.ignoreBug(bugId, task.title.replace(/^Bug \d+: /, ''));
        await o.store.comment(id, 'Ignored from the agents dashboard: not working on this bug.');
        await o.store.close(id);
      }
      o.activity.add({ source: 'dashboard', kind: action, subject: task.title, action: action === 'done' || action === 'ignore' ? 'done' : 'annotated', reason: adoResult ? `marked done by you · Azure DevOps: ${adoResult}` : `marked ${action} by you`, taskId: id, link });
      return { ok: true, ado: adoResult };
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

    if ((m = /^\/api\/bugs\/(\d+)\/(investigate|terminal|review)$/.exec(path))) {
      if (!o.investigator) throw new HttpError(409, 'Investigator is off — Azure DevOps is not connected');
      const bugId = Number(m[1]);
      try {
        if (m[2] === 'investigate') {
          const task = (await o.store.list('work')).find((t) => bugIdOf(t) === bugId);
          if (task && !task.labels.includes('bug')) throw new HttpError(400, 'only Bugs can be investigated');
          return await o.investigator.start(bugId);
        }
        if (m[2] === 'terminal') return { result: await o.investigator.openTerminal(bugId) };
        const decision = body.decision;
        if (decision !== 'approve' && decision !== 'reject' && decision !== 'changes') throw new HttpError(400, 'decision: approve | reject | changes');
        return await o.investigator.review(bugId, decision, typeof body.feedback === 'string' ? body.feedback : undefined);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }

    if ((m = /^\/api\/bugs\/(\d+)\/(develop|dev-terminal|dev-review)$/.exec(path))) {
      if (!o.developer) throw new HttpError(409, 'Developer is off — Azure DevOps is not connected');
      const bugId = Number(m[1]);
      try {
        if (m[2] === 'develop') return await o.developer.start(bugId);
        if (m[2] === 'dev-terminal') return { result: await o.developer.openTerminal(bugId) };
        const decision = body.decision;
        if (decision !== 'approve' && decision !== 'changes' && decision !== 'discard') throw new HttpError(400, 'decision: approve | changes | discard');
        return await o.developer.review(bugId, decision, typeof body.feedback === 'string' ? body.feedback : undefined);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }

    if ((m = /^\/api\/bugs\/(\d+)\/notes\/(\d+)\/delete$/.exec(path))) {
      if (!o.bugNotes.remove(Number(m[1]), Number(m[2]))) throw new HttpError(404, 'no such note');
      return { ok: true };
    }

    throw new HttpError(404, 'not found');
  }

  return async function handle(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    const asset = ASSETS[url.pathname];
    if (asset) return new Response(asset.file, { headers: { 'Content-Type': asset.type, 'Cache-Control': 'no-cache' } });
    if (!PAGES.has(url.pathname) && !url.pathname.startsWith('/api/')) return undefined;
    if (!localHosts.has(req.headers.get('host') ?? '')) return new Response('forbidden', { status: 403 });

    try {
      if (req.method === 'GET') {
        if (PAGES.has(url.pathname)) return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        if (url.pathname === '/api/overview') return Response.json(await overview(), { headers: { 'Cache-Control': 'no-store' } });
        if (url.pathname === '/api/whatsapp/chats') return Response.json(chats(), { headers: { 'Cache-Control': 'no-store' } });
        if (url.pathname === '/api/activity') return Response.json(searchActivity(url.searchParams), { headers: { 'Cache-Control': 'no-store' } });
        const dev = /^\/api\/bugs\/(\d+)\/dev$/.exec(url.pathname);
        if (dev && o.developer) return Response.json(o.developer.changes(Number(dev[1])), { headers: { 'Cache-Control': 'no-store' } });
        const rep = /^\/api\/bugs\/(\d+)\/report$/.exec(url.pathname);
        if (rep && o.investigator) return Response.json(o.investigator.report(Number(rep[1])), { headers: { 'Cache-Control': 'no-store' } });
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
