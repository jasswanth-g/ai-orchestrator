#!/usr/bin/env bun
import { dirname, join } from 'node:path';
import { adoReceiver } from './ado/receiver.ts';
import { dbPath, log, pickStore } from './config.ts';
import { errText, type Receiver } from './events/receiver.ts';
import { SeenIds } from './events/seen.ts';
import { resolvePath } from './tools/files.ts';
import { BridgeSupervisor, bridgeSecret } from './whatsapp/bridge.ts';
import { whatsappReceiver } from './whatsapp/receiver.ts';
import { whatsappUi } from './whatsapp/ui.ts';

/**
 * One process for every agent input: a local event server with a route per
 * source, plus the WhatsApp bridge as a child process.
 *
 *   /hooks/ado        Azure DevOps service hooks (via a tunnel)   — on when ADO_HOOK_SECRET is set
 *   /hooks/whatsapp   bridges/whatsapp, spawned here              — off with WHATSAPP_BRIDGE=off
 *   /whatsapp         connection page: status, pairing QR, unlink
 *
 * Env: AGENTS_PORT (4320), ADO_HOOK_SECRET, ADO_MY_APPS, WHATSAPP_WATCH_CHATS,
 * WHATSAPP_KEYWORDS, WHATSAPP_STORE_DIR (bridge session + messages.db).
 */

const port = Number(process.env.AGENTS_PORT ?? 4320);
const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const stateDir = dirname(dbPath);
const store = pickStore();
const receivers: Receiver[] = [];

const adoSecret = process.env.ADO_HOOK_SECRET;
if (adoSecret) {
  receivers.push(
    await adoReceiver({ store, secret: adoSecret, myApps: list(process.env.ADO_MY_APPS), seen: new SeenIds(join(stateDir, 'ado-events-seen.json')) }),
  );
} else log('ado: off (ADO_HOOK_SECRET not set)');

const bridgeOn = process.env.WHATSAPP_BRIDGE !== 'off';
const waStoreDir = resolvePath(process.env.WHATSAPP_STORE_DIR ?? '~/Documents/GitHub/whatsapp-mcp/whatsapp-bridge/store');
const waWatch = list(process.env.WHATSAPP_WATCH_CHATS);
// Shared with the bridge and the WhatsApp MCP server via <store>/bridge-secret.
const waSecret = bridgeOn ? bridgeSecret(waStoreDir) : '';
if (bridgeOn) {
  if (!waWatch.length) log('whatsapp: WHATSAPP_WATCH_CHATS is empty — every chat counts, 1:1 chats included');
  receivers.push(
    whatsappReceiver({
      store,
      secret: waSecret,
      storeDir: waStoreDir,
      watch: waWatch,
      keywords: list(process.env.WHATSAPP_KEYWORDS),
      seen: new SeenIds(join(stateDir, 'whatsapp-seen.json')),
      checkpointFile: join(stateDir, 'whatsapp-checkpoint.txt'),
    }),
  );
} else log('whatsapp: off (WHATSAPP_BRIDGE=off)');

const bridge = bridgeOn
  ? new BridgeSupervisor({ storeDir: waStoreDir, eventUrl: `http://127.0.0.1:${port}/hooks/whatsapp`, secret: waSecret, watch: waWatch })
  : undefined;
const whatsappPage = whatsappUi({ bridge, watch: waWatch, port });

Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const ui = await whatsappPage(req);
    if (ui) return ui;
    if (url.pathname === '/health') return Response.json({ ok: true, receivers: receivers.map((r) => r.name) });
    const r = receivers.find((x) => x.path === url.pathname);
    if (!r || req.method !== 'POST') return new Response('not found', { status: 404 });
    return r.handle(req);
  },
});
log(`agents listening on http://127.0.0.1:${port} — ${receivers.map((r) => r.path).join(', ') || 'no receivers'}`);
if (bridge) log(`WhatsApp connection page: http://127.0.0.1:${port}/whatsapp`);

for (const r of receivers) await r.catchUp().catch((err) => log(`${r.name} catch-up failed: ${errText(err)}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    bridge?.stop();
    log('agents stopping');
    setTimeout(() => process.exit(0), 1500);
  });
}

if (bridge) void bridge.start();
