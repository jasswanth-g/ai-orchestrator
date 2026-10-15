import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseDue } from '../due.ts';
import {
  type Bucket,
  DEFAULT_PRIORITY,
  DEFAULT_SOURCE,
  type Item,
  type ItemPatch,
  type NewItem,
  type Priority,
  type Status,
} from '../types.ts';
import type { Store } from './store.ts';

/** Bump and add a step in `migrate()` whenever the schema changes. */
const SCHEMA_VERSION = 4;

interface Row {
  id: number;
  bucket: Bucket;
  title: string;
  notes: string | null;
  priority: number;
  due: string | null;
  labels: string;
  source: string;
  link: string | null;
  path: string | null;
  estimate_min: number | null;
  status: Status;
  approach: string | null;
  created_at: string;
  closed_at: string | null;
}

const COLUMNS = 'id, bucket, title, notes, priority, due, labels, source, link, path, estimate_min, status, approach, created_at, closed_at';

export interface SqliteStoreOptions {
  /** File path, or ':memory:' for tests. */
  path: string;
  /** Clock for createdAt and relative due dates — injectable for tests. */
  now?: () => Date;
}

/** Local, private store: one SQLite file, no account, no network. */
export class SqliteStore implements Store {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(opts: SqliteStoreOptions) {
    if (opts.path !== ':memory:') mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new Database(opts.path, { create: true, strict: true });
    this.now = opts.now ?? (() => new Date());
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  async list(bucket: Bucket): Promise<Item[]> {
    const rows = this.db
      .query<Row, { bucket: string }>(`SELECT ${COLUMNS} FROM items WHERE bucket = $bucket AND closed_at IS NULL`)
      .all({ bucket });
    return rows.map(toItem);
  }

  async create(bucket: Bucket, item: NewItem): Promise<Item> {
    const row = this.db
      .query<Row, Record<string, string | number | null>>(
        `INSERT INTO items (bucket, title, notes, priority, due, labels, source, link, path, estimate_min, approach, created_at)
         VALUES ($bucket, $title, $notes, $priority, $due, $labels, $source, $link, $path, $estimate, $approach, $created_at)
         RETURNING ${COLUMNS}`,
      )
      .get({
        bucket,
        title: item.title,
        notes: item.notes ?? null,
        priority: item.priority ?? DEFAULT_PRIORITY,
        due: item.due ? parseDue(item.due, this.now()) : null,
        labels: JSON.stringify(item.labels ?? []),
        source: item.source ?? DEFAULT_SOURCE,
        link: item.link ?? null,
        path: item.path ?? null,
        estimate: item.estimate ?? null,
        approach: item.approach || null,
        created_at: this.now().toISOString(),
      });
    return toItem(row!);
  }

  async update(id: string, patch: ItemPatch): Promise<Item> {
    const row = this.db
      .query<Row, Record<string, string | number | null>>(
        `UPDATE items SET
           title    = COALESCE($title, title),
           notes    = CASE WHEN $set_notes THEN NULLIF($notes, '') ELSE notes END,
           approach = CASE WHEN $set_approach THEN NULLIF($approach, '') ELSE approach END,
           priority = COALESCE($priority, priority),
           due      = CASE WHEN $clear_due THEN NULL ELSE COALESCE($due, due) END,
           estimate_min = COALESCE($estimate, estimate_min),
           status   = COALESCE($status, status),
           labels   = COALESCE($labels, labels),
           bucket   = COALESCE($bucket, bucket)
         WHERE id = $id
         RETURNING ${COLUMNS}`,
      )
      .get({
        id: Number(id),
        title: patch.title ?? null,
        notes: patch.notes ?? null,
        set_notes: patch.notes !== undefined ? 1 : 0,
        approach: patch.approach ?? null,
        set_approach: patch.approach !== undefined ? 1 : 0,
        priority: patch.priority ?? null,
        due: patch.due ? parseDue(patch.due, this.now()) : null,
        clear_due: patch.due === null ? 1 : 0,
        estimate: patch.estimate ?? null,
        status: patch.status ?? null,
        labels: patch.labels ? JSON.stringify(patch.labels) : null,
        bucket: patch.bucket ?? null,
      });
    if (!row) throw notFound(id);
    return toItem(row);
  }

  async close(id: string): Promise<void> {
    const { changes } = this.db
      .query('UPDATE items SET closed_at = $at WHERE id = $id AND closed_at IS NULL')
      .run({ id: Number(id), at: this.now().toISOString() });
    if (!changes) throw notFound(id);
  }

  async listCompleted(bucket: Bucket, since: string): Promise<Item[]> {
    return this.db
      .query<Row, { bucket: string; since: string }>(
        `SELECT ${COLUMNS} FROM items WHERE bucket = $bucket AND closed_at >= $since ORDER BY closed_at DESC`,
      )
      .all({ bucket, since })
      .map(toItem);
  }

  async reopen(id: string): Promise<void> {
    const { changes } = this.db.query('UPDATE items SET closed_at = NULL WHERE id = $id').run({ id: Number(id) });
    if (!changes) throw notFound(id);
  }

  async remove(id: string): Promise<void> {
    const { changes } = this.db.query('DELETE FROM items WHERE id = $id').run({ id: Number(id) });
    if (!changes) throw notFound(id);
  }

  async comment(id: string, text: string): Promise<void> {
    if (!this.db.query('SELECT 1 FROM items WHERE id = $id').get({ id: Number(id) })) throw notFound(id);
    this.db
      .query('INSERT INTO comments (item_id, text, created_at) VALUES ($id, $text, $at)')
      .run({ id: Number(id), text, at: this.now().toISOString() });
  }

  /** Comments on an item, oldest first (answers to questions live here). */
  comments(id: string): string[] {
    return this.db
      .query<{ text: string }, { id: number }>('SELECT text FROM comments WHERE item_id = $id ORDER BY id')
      .all({ id: Number(id) })
      .map((r) => r.text);
  }

  /** Releases the database file handle. */
  dispose(): void {
    this.db.close();
  }

  private migrate(): void {
    const { user_version: v } = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!;
    if (v >= SCHEMA_VERSION) return;
    // Step 3 rebuilds the items table; with foreign keys on, dropping it would
    // cascade-delete every comment. The pragma is a no-op inside a transaction.
    this.db.run('PRAGMA foreign_keys = OFF');
    this.db.transaction(() => {
      if (v < 1) {
        this.db.run(`
          CREATE TABLE items (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            bucket     TEXT    NOT NULL CHECK (bucket IN ('work', 'questions', 'memory')),
            title      TEXT    NOT NULL,
            notes      TEXT,
            priority   INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 4),
            due        TEXT,
            labels     TEXT    NOT NULL DEFAULT '[]',
            source     TEXT    NOT NULL,
            link       TEXT,
            path       TEXT,
            created_at TEXT    NOT NULL,
            closed_at  TEXT
          )`);
        this.db.run('CREATE INDEX items_open_bucket ON items (bucket) WHERE closed_at IS NULL');
        this.db.run(`
          CREATE TABLE comments (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id    INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
            text       TEXT    NOT NULL,
            created_at TEXT    NOT NULL
          )`);
      }
      if (v < 2) this.db.run('ALTER TABLE items ADD COLUMN estimate_min INTEGER CHECK (estimate_min > 0)');
      if (v < 3) {
        // New bucket (backlog) means a new CHECK, which SQLite can only get by rebuilding the table.
        this.db.run(`
          CREATE TABLE items_v3 (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            bucket       TEXT    NOT NULL CHECK (bucket IN ('work', 'questions', 'memory', 'backlog')),
            title        TEXT    NOT NULL,
            notes        TEXT,
            priority     INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 4),
            due          TEXT,
            labels       TEXT    NOT NULL DEFAULT '[]',
            source       TEXT    NOT NULL,
            link         TEXT,
            path         TEXT,
            created_at   TEXT    NOT NULL,
            closed_at    TEXT,
            estimate_min INTEGER CHECK (estimate_min > 0),
            status       TEXT    NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in-progress', 'in-review'))
          )`);
        this.db.run(`
          INSERT INTO items_v3 (id, bucket, title, notes, priority, due, labels, source, link, path, created_at, closed_at, estimate_min)
          SELECT id, bucket, title, notes, priority, due, labels, source, link, path, created_at, closed_at, estimate_min FROM items`);
        this.db.run('DROP TABLE items');
        this.db.run('ALTER TABLE items_v3 RENAME TO items');
        this.db.run('CREATE INDEX items_open_bucket ON items (bucket) WHERE closed_at IS NULL');
      }
      if (v < 4) this.db.run('ALTER TABLE items ADD COLUMN approach TEXT');
      const broken = this.db.query('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`Migration left ${broken.length} dangling comment(s); nothing was changed`);
      this.db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    })();
    this.db.run('PRAGMA foreign_keys = ON');
  }
}

const notFound = (id: string) => new Error(`No item ${id}`);

const toItem = (r: Row): Item => ({
  id: String(r.id),
  bucket: r.bucket,
  title: r.title,
  notes: r.notes ?? undefined,
  priority: r.priority as Priority,
  due: r.due ?? undefined,
  labels: JSON.parse(r.labels) as string[],
  source: r.source,
  link: r.link ?? undefined,
  path: r.path ?? undefined,
  estimate: r.estimate_min ?? undefined,
  status: r.status,
  approach: r.approach ?? undefined,
  createdAt: r.created_at,
  ...(r.closed_at ? { closedAt: r.closed_at } : {}),
});
