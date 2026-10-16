import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** One event source mounted on the agents server (src/agents.ts). */
export interface Receiver {
  name: string;
  path: string;
  handle(req: Request): Promise<Response>;
  /** Picks up whatever happened while the server was down (also the dashboard's Refresh). Returns a one-line summary. */
  catchUp(): Promise<string | void>;
  /** For the dashboard's source card. */
  status(): Promise<Record<string, unknown>>;
}

export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Reads a secret kept in a 0600 file, creating it on first use. */
export function loadOrCreateSecret(file: string): string {
  const existing = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  if (existing.length >= 32) return existing;
  const secret = randomBytes(24).toString('hex');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}
