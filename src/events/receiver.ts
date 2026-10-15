import { timingSafeEqual } from 'node:crypto';

/** One event source mounted on the agents server (src/agents.ts). */
export interface Receiver {
  name: string;
  path: string;
  handle(req: Request): Promise<Response>;
  /** Picks up whatever happened while the server was down. */
  catchUp(): Promise<void>;
}

export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
