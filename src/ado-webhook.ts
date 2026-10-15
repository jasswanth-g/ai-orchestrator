#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { AdoClient, adoConfig } from './ado/client.ts';
import { type AdoPayload, OPEN_STATES, parsePayload } from './ado/events.ts';
import { BugIntake } from './ado/intake.ts';
import { dbPath, log, pickStore } from './config.ts';

/**
 * Receives Azure DevOps service-hook events for Bugs and turns them into
 * todo-brain tasks (see src/ado/intake.ts). Bound to 127.0.0.1; a tunnel
 * gives ADO the public HTTPS URL. On start it runs one catch-up query for
 * whatever happened while the Mac was off — there is no polling.
 *
 * Env: ADO_HOOK_SECRET (required, the service hook's basic-auth password),
 * ADO_HOOK_PORT (4320), ADO_MY_APPS (comma list of Custom.Application values),
 * ADO_ORG, ADO_PROJECT.
 */

const secret = process.env.ADO_HOOK_SECRET;
if (!secret) {
  log('ADO_HOOK_SECRET is not set — refusing to start an unauthenticated webhook');
  process.exit(1);
}
const port = Number(process.env.ADO_HOOK_PORT ?? 4320);
const myApps = (process.env.ADO_MY_APPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const ado = new AdoClient(adoConfig());
const me = await ado.me();
const intake = new BugIntake({ store: pickStore(), me, myApps, bugUrl: ado.bugUrl });
log(`ado-webhook: ${me.email}, ${me.groupIds.length} groups, my apps: ${myApps.join(', ') || 'none'}`);

/** Event ids already handled — ADO retries a delivery it thinks failed. */
const seenFile = join(dirname(dbPath), 'ado-events-seen.json');
const seen: string[] = existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, 'utf8')) : [];
const remember = (id: string) => {
  seen.push(id);
  if (seen.length > 1000) seen.splice(0, seen.length - 1000);
  mkdirSync(dirname(seenFile), { recursive: true });
  writeFileSync(seenFile, JSON.stringify(seen));
};

function authorised(req: Request): boolean {
  const m = /^Basic (.+)$/.exec(req.headers.get('authorization') ?? '');
  if (!m) return false;
  const password = Buffer.from(m[1]!, 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(password);
  const b = Buffer.from(secret!);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One query on start: open bugs assigned to me, mentioning me, or new in my apps this week. */
async function catchUp() {
  const open = OPEN_STATES.map((s) => `'${s}'`).join(',');
  const base = `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Bug' AND [System.State] IN (${open})`;
  const sets: Array<[string, string]> = [
    ['assigned', `${base} AND [System.AssignedTo] = @Me`],
    ['mentioned', `${base} AND [System.Id] IN (@RecentMentions)`],
  ];
  if (myApps.length) {
    const apps = myApps.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
    sets.push(['my-area', `${base} AND [Custom.Application] IN (${apps}) AND [System.CreatedDate] >= @Today - 7`]);
  }
  let created = 0;
  for (const [reason, query] of sets) {
    const ids = await ado.wiql(query);
    for (const bug of await ado.bugs(ids)) {
      const out = await intake.track(bug, reason);
      if (out.action === 'created') {
        created++;
        log(`catch-up: Bug ${bug.id} → task ${out.taskId} (${reason})`);
      }
    }
  }
  log(`catch-up done: ${created} new task(s)`);
}

Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname !== '/hooks/ado' || req.method !== 'POST') return new Response('not found', { status: 404 });
    if (!authorised(req)) return new Response('unauthorised', { status: 401 });

    const payload = (await req.json().catch(() => undefined)) as AdoPayload | undefined;
    if (!payload) return new Response('bad json', { status: 400 });
    if (payload.id && seen.includes(payload.id)) return new Response('duplicate');
    try {
      for (const event of parsePayload(payload)) {
        const out = await intake.handle(event);
        log(`${payload.eventType} Bug ${out.bug}: ${out.action} (${out.reason})${out.taskId ? ` task ${out.taskId}` : ''}`);
      }
      if (payload.id) remember(payload.id);
      return new Response('ok');
    } catch (err) {
      // A 5xx makes ADO retry the delivery.
      log(`failed on ${payload.eventType} ${payload.id}: ${err instanceof Error ? err.message : err}`);
      return new Response('error', { status: 500 });
    }
  },
});
log(`ado-webhook listening on http://127.0.0.1:${port}/hooks/ado`);

await catchUp().catch((err) => log(`catch-up failed: ${err instanceof Error ? err.message : err}`));
