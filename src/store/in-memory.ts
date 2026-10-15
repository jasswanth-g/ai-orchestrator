import { type Bucket, DEFAULT_PRIORITY, DEFAULT_SOURCE, type Item, type ItemPatch, type NewItem } from '../types.ts';
import type { Store } from './store.ts';

/** A Store held in memory. Used by tests; also handy for a no-token dry run. */
export class InMemoryStore implements Store {
  readonly items = new Map<string, Item>();
  /** id → when it was closed. */
  readonly closed = new Map<string, string>();
  readonly comments = new Map<string, string[]>();
  private seq = 0;

  async list(bucket: Bucket): Promise<Item[]> {
    return [...this.items.values()].filter((i) => i.bucket === bucket && !this.closed.has(i.id));
  }

  async create(bucket: Bucket, item: NewItem): Promise<Item> {
    const id = String(++this.seq);
    const created: Item = {
      id,
      bucket,
      title: item.title,
      notes: item.notes,
      priority: item.priority ?? DEFAULT_PRIORITY,
      due: item.due,
      labels: item.labels ?? [],
      source: item.source ?? DEFAULT_SOURCE,
      link: item.link,
      path: item.path,
      estimate: item.estimate,
      status: 'todo',
      approach: item.approach || undefined,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, this.seq)).toISOString(),
    };
    this.items.set(id, created);
    return created;
  }

  async update(id: string, patch: ItemPatch): Promise<Item> {
    const item = this.must(id);
    const next = { ...item, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    if (patch.due === null) delete next.due;
    if (patch.notes === '') delete next.notes;
    if (patch.approach === '') delete next.approach;
    this.items.set(id, next);
    return next;
  }

  async close(id: string): Promise<void> {
    this.must(id);
    this.closed.set(id, new Date().toISOString());
  }

  async listCompleted(bucket: Bucket, since: string): Promise<Item[]> {
    return [...this.items.values()]
      .filter((i) => i.bucket === bucket && (this.closed.get(i.id) ?? '') >= since)
      .map((i) => ({ ...i, closedAt: this.closed.get(i.id) }))
      .sort((a, b) => b.closedAt!.localeCompare(a.closedAt!));
  }

  async reopen(id: string): Promise<void> {
    this.must(id);
    this.closed.delete(id);
  }

  async remove(id: string): Promise<void> {
    this.must(id);
    this.items.delete(id);
  }

  async comment(id: string, text: string): Promise<void> {
    this.must(id);
    this.comments.set(id, [...(this.comments.get(id) ?? []), text]);
  }

  private must(id: string): Item {
    const item = this.items.get(id);
    if (!item) throw new Error(`No item ${id}`);
    return item;
  }
}
