#!/usr/bin/env bun
import { dirname, join } from 'node:path';
import { AdoClient, adoConfig } from './ado/client.ts';
import { adoHookSecret, adoReceiver } from './ado/receiver.ts';
import { Developer } from './developer/service.ts';
import { Investigator } from './investigator/service.ts';
import { agentsDashboard } from './agents-dashboard/routes.ts';
import { BugNotes, Settings } from './agents-settings.ts';
import { dbPath, log, pickStore, reportsPath } from './config.ts';
import { ReportsDb } from './store/reports.ts';
import { ActivityLog } from './events/activity.ts';
import { errText, type Receiver } from './events/receiver.ts';
import { SeenIds } from './events/seen.ts';
import { resolvePath } from './tools/files.ts';
import { BridgeSupervisor, bridgeSecret } from './whatsapp/bridge.ts';
import { listChats, whatsappReceiver } from './whatsapp/receiver.ts';
import { Drafts, DRAFT_SCHEMA, type DraftOut } from './whatsapp/drafts.ts';
import { claudeAsk, claudeJson } from './whatsapp/triage.ts';
import { whatsappUi } from './whatsapp/ui.ts';

/**
 * One process for every agent input: a local event server with a route per
 * source, plus the WhatsApp bridge as a child process.
 *
 *   /hooks/ado        Azure DevOps service hooks (via a tunnel)   — off with ADO=off
 *   /hooks/whatsapp   bridges/whatsapp, spawned here              — off with WHATSAPP_BRIDGE=off
 *   /                 agents dashboard: sources, agent tasks, activity feed
 *   /whatsapp         connection page: status, pairing QR, unlink
 *
 * Env: AGENTS_PORT (4320), ADO (off), ADO_HOOK_SECRET (default: stored secret),
 * WHATSAPP_WATCH_CHATS / WHATSAPP_KEYWORDS (first-run defaults; then the dashboard), WHATSAPP_STORE_DIR (bridge session + messages.db).
 */

const port = Number(process.env.AGENTS_PORT ?? 4320);

/**
 * The code this process started with. Page files are read from disk on every
 * request but routes load once, so after a pull/commit the two can disagree —
 * the dashboard warns until the server is restarted.
 */
const repoRoot = new URL('..', import.meta.url).pathname;
const headCommit = () => Bun.spawnSync(['git', '-C', repoRoot, 'rev-parse', '--short', 'HEAD']).stdout.toString().trim();
const startedCommit = headCommit();
const codeStatus = () => {
  const current = headCommit();
  return { running: startedCommit, current, stale: !!startedCommit && !!current && current !== startedCommit };
};
const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const stateDir = dirname(dbPath);
const store = pickStore();
const receivers: Receiver[] = [];
const activity = new ActivityLog(join(stateDir, 'agents-activity.jsonl'));
// Watched chats, keywords and ignored bugs — edited on the dashboard; env vars only seed the first run.
const settings = new Settings(join(stateDir, 'agents-settings.json'), {
  watch: list(process.env.WHATSAPP_WATCH_CHATS),
  keywords: list(process.env.WHATSAPP_KEYWORDS),
});
const bugNotes = new BugNotes(join(stateDir, 'bug-notes.json'));

// ADO is on unless ADO=off. Without a tunnel it still runs the startup catch-up.
const adoOn = process.env.ADO !== 'off';
let adoError: string | undefined;
if (adoOn) {
  try {
    receivers.push(
      await adoReceiver({
        store,
        secret: adoHookSecret(),
        isIgnored: settings.isIgnored,
        seen: new SeenIds(join(stateDir, 'ado-events-seen.json')),
        activity,
        statsFile: join(stateDir, 'ado-stats.json'),
      }),
    );
  } catch (err) {
    // e.g. `az login` expired — keep WhatsApp running and show the error on the dashboard.
    adoError = errText(err);
    log(`ado: failed to start — ${adoError}`);
  }
} else log('ado: off (ADO=off)');

// One ADO client for the Investigator and the dashboard's Done → ADO state changes.
const adoClient = adoOn && !adoError ? new AdoClient(adoConfig()) : undefined;
const reportsDb = new ReportsDb(reportsPath());

// Investigator: one iTerm + Claude Code session per bug, started from the dashboard.
const investigator =
  adoOn && !adoError
    ? new Investigator({
        stateDir,
        reposRoot: resolvePath(process.env.INVESTIGATOR_REPOS ?? '~/Documents/GitHub'),
        repoRemote: process.env.INVESTIGATOR_REPO_REMOTE ?? 'dev.azure.com/xavica',
        store,
        reports: reportsDb,
        reportsPath: reportsPath(),
        bugNotes,
        activity,
        ado: adoClient!,
      })
    : undefined;

// Developer: implements an approved report in git worktrees, in its own iTerm session.
const developer = investigator
  ? new Developer({
      stateDir,
      reposRoot: resolvePath(process.env.INVESTIGATOR_REPOS ?? '~/Documents/GitHub'),
      repoRemote: process.env.INVESTIGATOR_REPO_REMOTE ?? 'dev.azure.com/xavica',
      store,
      reports: reportsDb,
      reportsPath: reportsPath(),
      investigations: investigator.investigations,
      bugNotes,
      activity,
      ado: adoClient,
      knowledgeDir: dirname(investigator.knowledgeFile),
    })
  : undefined;

const bridgeOn = process.env.WHATSAPP_BRIDGE !== 'off';
const waDrafts = new Drafts(join(stateDir, 'whatsapp-drafts.json'));
const waStoreDir = resolvePath(process.env.WHATSAPP_STORE_DIR ?? '~/Documents/GitHub/whatsapp-mcp/whatsapp-bridge/store');
// Shared with the bridge and the WhatsApp MCP server via <store>/bridge-secret.
const waSecret = bridgeOn ? bridgeSecret(waStoreDir) : '';
if (bridgeOn) {
  if (!settings.whatsapp.watch.length) log('whatsapp: no chats watched yet — pick them on the dashboard');
  receivers.push(
    whatsappReceiver({
      store,
      secret: waSecret,
      storeDir: waStoreDir,
      settings: () => settings.whatsapp,
      seen: new SeenIds(join(stateDir, 'whatsapp-seen.json')),
      checkpointFile: join(stateDir, 'whatsapp-checkpoint.txt'),
      activity,
      skipped: new ActivityLog(join(stateDir, 'whatsapp-skipped.jsonl'), 100),
      statsFile: join(stateDir, 'whatsapp-stats.json'),
      // AI reading of group context (off with WHATSAPP_AI=off; WHATSAPP_AI_MODEL picks the model).
      ai:
        process.env.WHATSAPP_AI === 'off'
          ? undefined
          : { ask: claudeAsk({ model: process.env.WHATSAPP_AI_MODEL || undefined }), names: () => settings.whatsapp.keywords, purpose: settings.purposeOf },
      team: () => settings.team,
      // Draft replies for 1:1 chats — the agents never send WhatsApp messages.
      drafts:
        process.env.WHATSAPP_AI === 'off'
          ? undefined
          : { store: waDrafts, write: claudeJson<DraftOut>(DRAFT_SCHEMA, { model: process.env.WHATSAPP_AI_MODEL || undefined }), names: () => settings.whatsapp.keywords },
    }),
  );
} else log('whatsapp: off (WHATSAPP_BRIDGE=off)');

const bridge = bridgeOn
  ? // The bridge forwards every chat; the intake filters by the (editable) watch list.
    new BridgeSupervisor({ storeDir: waStoreDir, eventUrl: `http://127.0.0.1:${port}/hooks/whatsapp`, secret: waSecret, watch: [] })
  : undefined;
const whatsappPage = whatsappUi({
  bridge,
  port,
  // Watched chats by name for the connection page (stored as JIDs).
  watch: () => {
    const chats = listChats(waStoreDir);
    return settings.whatsapp.watch.map((w) => chats.find((c) => c.jid === w)?.name ?? w);
  },
});
const dashboard = agentsDashboard({
  port,
  store,
  receivers,
  activity,
  bridge,
  adoOn,
  adoError,
  settings,
  bugNotes,
  investigator,
  developer,
  codeStatus,
  drafts: waDrafts,
  ado: adoClient,
  reports: reportsDb,
  waStoreDir: bridgeOn ? waStoreDir : undefined,
  todoDashboardUrl: `http://127.0.0.1:${process.env.TODO_BRAIN_DASHBOARD_PORT ?? 4319}`,
});

Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const ui = (await dashboard(req)) ?? (await whatsappPage(req));
    if (ui) return ui;
    if (url.pathname === '/health') return Response.json({ ok: true, receivers: receivers.map((r) => r.name) });
    const r = receivers.find((x) => x.path === url.pathname);
    if (!r || req.method !== 'POST') return new Response('not found', { status: 404 });
    return r.handle(req);
  },
});
log(`agents listening on http://127.0.0.1:${port} — ${receivers.map((r) => r.path).join(', ') || 'no receivers'}`);
log(`agents dashboard: http://127.0.0.1:${port}/${bridge ? ` · WhatsApp connection: http://127.0.0.1:${port}/whatsapp` : ''}`);

for (const r of receivers) await r.catchUp().catch((err) => log(`${r.name} catch-up failed: ${errText(err)}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    bridge?.stop();
    log('agents stopping');
    setTimeout(() => process.exit(0), 1500);
  });
}

if (bridge) void bridge.start();
