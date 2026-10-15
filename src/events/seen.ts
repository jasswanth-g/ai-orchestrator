import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Ids of events already handled, kept in a small JSON file so a retried or
 * replayed delivery (webhook retry, startup catch-up) is not applied twice.
 */
export class SeenIds {
  private readonly ids: string[];
  private readonly set: Set<string>;

  constructor(private readonly file: string, private readonly max = 2000) {
    this.ids = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    this.set = new Set(this.ids);
  }

  has(id: string): boolean {
    return this.set.has(id);
  }

  add(id: string): void {
    if (this.set.has(id)) return;
    this.ids.push(id);
    this.set.add(id);
    while (this.ids.length > this.max) this.set.delete(this.ids.shift()!);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.ids));
  }
}
