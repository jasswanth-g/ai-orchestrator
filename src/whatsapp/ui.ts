import type { BridgeSupervisor } from './bridge.ts';

/**
 * Connection page for the WhatsApp bridge, served by the agents server:
 * status, pairing QR, new-QR and unlink. Local only — requests must carry a
 * localhost Host header (no DNS rebinding) and writes must be JSON (no
 * cross-site form posts).
 */

const page = Bun.file(new URL('./page.html', import.meta.url));

export function whatsappUi(o: { bridge?: BridgeSupervisor; watch: string[]; port: number }) {
  const localHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`]);

  async function status() {
    const base = { watch: o.watch };
    if (!o.bridge) return { ...base, state: 'off' };
    if (o.bridge.state === 'other_bridge') return { ...base, state: 'other_bridge' };
    if (o.bridge.state === 'build_failed') return { ...base, state: 'error', error: 'Bridge build failed — see the agents log.' };
    try {
      const res = await o.bridge.api('/api/status');
      return { ...base, ...((await res.json()) as Record<string, unknown>) };
    } catch {
      return { ...base, state: 'bridge_down' };
    }
  }

  /** Response for a /whatsapp route, or undefined when the path isn't ours. */
  return async function handle(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (url.pathname !== '/whatsapp' && !url.pathname.startsWith('/whatsapp/')) return undefined;
    if (!localHosts.has(req.headers.get('host') ?? '')) return new Response('forbidden', { status: 403 });

    if (req.method === 'GET') {
      if (url.pathname === '/whatsapp') return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (url.pathname === '/whatsapp/status') return Response.json(await status(), { headers: { 'Cache-Control': 'no-store' } });
      if (url.pathname === '/whatsapp/qr.png' && o.bridge) {
        const res = await o.bridge.api('/api/qr.png').catch(() => undefined);
        return res ? new Response(res.body, { status: res.status, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } }) : new Response('bridge down', { status: 502 });
      }
    }

    if (req.method === 'POST' && (url.pathname === '/whatsapp/pair' || url.pathname === '/whatsapp/logout')) {
      if (req.headers.get('content-type') !== 'application/json') return new Response('JSON request required', { status: 415 });
      if (!o.bridge) return new Response('bridge off', { status: 409 });
      const res = await o.bridge.api(`/api/${url.pathname.split('/').pop()}`, { method: 'POST' }).catch(() => undefined);
      return res ? new Response(await res.text(), { status: res.status }) : new Response('bridge down', { status: 502 });
    }
    return new Response('not found', { status: 404 });
  };
}
