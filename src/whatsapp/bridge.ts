import { join } from 'node:path';
import { log } from '../config.ts';
import { loadOrCreateSecret } from '../events/receiver.ts';

/**
 * Builds and supervises bridges/whatsapp as a child process. Exit 0 is a
 * deliberate restart (new QR, unlink) and restarts at once; a crash restarts
 * with backoff up to a minute.
 */

const BRIDGE_API = 'http://127.0.0.1:8080';

/**
 * The bridge API secret, shared through <store>/bridge-secret (0600) so local
 * clients like the WhatsApp MCP server can read it too. Created if missing.
 */
export const bridgeSecret = (storeDir: string) => loadOrCreateSecret(join(storeDir, 'bridge-secret'));

export type BridgeProcess = 'off' | 'starting' | 'running' | 'down' | 'other_bridge' | 'build_failed';

export class BridgeSupervisor {
  state: BridgeProcess = 'starting';
  private child?: ReturnType<typeof Bun.spawn>;
  private stopping = false;
  private readonly dir = new URL('../../bridges/whatsapp/', import.meta.url).pathname;

  constructor(private readonly o: { storeDir: string; eventUrl: string; secret: string; watch: string[] }) {}

  /** Calls the bridge's local API with the shared secret. */
  api(path: string, init: { method?: string } = {}): Promise<Response> {
    return fetch(`${BRIDGE_API}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'X-Bridge-Secret': this.o.secret, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
  }

  /** Something other than our child already serves the bridge port. */
  private portTaken = () =>
    fetch(`${BRIDGE_API}/api/status`, { signal: AbortSignal.timeout(1000) }).then(
      () => true,
      () => false,
    );

  async start(delay = 2000): Promise<void> {
    if (this.stopping) return;
    if (await this.portTaken()) {
      this.state = 'other_bridge';
      log('whatsapp bridge NOT started: 127.0.0.1:8080 is taken — stop the other bridge (two clients on one session conflict)');
      return;
    }
    const bin = join(this.dir, 'bin/whatsapp-bridge');
    const build = Bun.spawnSync(['go', 'build', '-o', bin, '.'], { cwd: this.dir, stderr: 'pipe' });
    if (build.exitCode !== 0) {
      this.state = 'build_failed';
      log(`whatsapp bridge build failed: ${build.stderr.toString()}`);
      return;
    }
    log(`whatsapp bridge starting (store ${this.o.storeDir})`);
    this.state = 'running';
    const startedAt = Date.now();
    this.child = Bun.spawn([bin], {
      cwd: this.dir,
      stdout: 'inherit',
      stderr: 'inherit',
      env: {
        ...process.env,
        WHATSAPP_STORE_DIR: this.o.storeDir,
        WHATSAPP_EVENT_URL: this.o.eventUrl,
        WHATSAPP_EVENT_SECRET: this.o.secret,
        WHATSAPP_WATCH_CHATS: this.o.watch.join(','),
      },
    });
    const code = await this.child.exited;
    this.child = undefined;
    if (this.stopping) return;
    this.state = 'down';
    // Deliberate restart, or a crash after a healthy run: start over quickly.
    const next = code === 0 || Date.now() - startedAt > 60_000 ? 1000 : Math.min(delay * 2, 60_000);
    log(`whatsapp bridge exited (${code}); restarting in ${next / 1000}s`);
    setTimeout(() => void this.start(next), next);
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill('SIGINT');
  }
}
