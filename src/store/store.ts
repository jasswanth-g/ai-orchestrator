import type { Bucket, Item, ItemPatch, NewItem } from '../types.ts';

/**
 * The only seam between tools and storage. Todoist is the first adapter;
 * moving to ADO / Notion / a local DB means one new file implementing this.
 */
export interface Store {
  /** Open (not completed) items in a bucket. */
  list(bucket: Bucket): Promise<Item[]>;
  create(bucket: Bucket, item: NewItem): Promise<Item>;
  update(id: string, patch: ItemPatch): Promise<Item>;
  /** Complete / close — the item stays in history. */
  close(id: string): Promise<void>;
  /** Items in a bucket completed since `since` (ISO datetime), newest first. */
  listCompleted(bucket: Bucket, since: string): Promise<Item[]>;
  /** Undo a close: the item is open again. */
  reopen(id: string): Promise<void>;
  /** Permanently delete. */
  remove(id: string): Promise<void>;
  comment(id: string, text: string): Promise<void>;
}
