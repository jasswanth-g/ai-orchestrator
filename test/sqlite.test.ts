import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/store/sqlite.ts';

const now = () => new Date(2026, 9, 1, 15, 0);
const stores: SqliteStore[] = [];
const open = (path = ':memory:') => {
  const s = new SqliteStore({ path, now });
  stores.push(s);
  return s;
};
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

describe('SqliteStore', () => {
  test('create → list round-trips every field', async () => {
    const s = open();
    const created = await s.create('work', {
      title: 'Reply to TCP',
      notes: 're PH2',
      priority: 1,
      due: 'tomorrow',
      labels: ['tcp', 'from-mail'],
      source: 'mail',
      link: 'https://outlook/1',
    });
    expect(created).toMatchObject({
      id: '1',
      bucket: 'work',
      priority: 1,
      due: '2026-10-02',
      labels: ['tcp', 'from-mail'],
      source: 'mail',
      link: 'https://outlook/1',
      notes: 're PH2',
    });
    expect(await s.list('work')).toEqual([created]);
    expect(await s.list('memory')).toEqual([]);
  });

  test('defaults: P4, manual source, no labels', async () => {
    const item = await open().create('memory', { title: 'fact', path: '/a/b' });
    expect(item).toMatchObject({ priority: 4, source: 'manual', labels: [], path: '/a/b' });
    expect(item.due).toBeUndefined();
  });

  test('update changes only what is given', async () => {
    const s = open();
    const { id } = await s.create('work', { title: 't', priority: 3, due: '2026-10-09' });
    const updated = await s.update(id, { priority: 1 });
    expect(updated).toMatchObject({ title: 't', priority: 1, due: '2026-10-09' });
    expect((await s.update(id, { due: 'mon' })).due).toBe('2026-10-05');
  });

  test('close hides from list; remove deletes; comments are kept', async () => {
    const s = open();
    const a = await s.create('questions', { title: 'q' });
    const b = await s.create('questions', { title: 'q2' });
    await s.comment(a.id, 'Answer: yes');
    await s.close(a.id);
    await s.remove(b.id);
    expect(await s.list('questions')).toEqual([]);
    expect(s.comments(a.id)).toEqual(['Answer: yes']);
  });

  test('unknown ids and bad due dates fail loudly', async () => {
    const s = open();
    await expect(s.update('99', { priority: 1 })).rejects.toThrow('No item 99');
    await expect(s.close('99')).rejects.toThrow('No item 99');
    await expect(s.remove('99')).rejects.toThrow('No item 99');
    await expect(s.comment('99', 'x')).rejects.toThrow('No item 99');
    await expect(s.create('work', { title: 't', due: 'someday' })).rejects.toThrow("Can't read due date");
  });

  test('stores estimates and updates them', async () => {
    const s = open();
    const { id } = await s.create('work', { title: 't', estimate: 90 });
    expect((await s.list('work'))[0]!.estimate).toBe(90);
    expect((await s.update(id, { estimate: 30 })).estimate).toBe(30);
  });

  test('upgrades a v1 database in place, keeping its rows', async () => {
    const { Database } = await import('bun:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'todo-brain-'));
    try {
      const path = join(dir, 'v1.db');
      const v1 = new Database(path, { create: true });
      v1.run(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, bucket TEXT NOT NULL, title TEXT NOT NULL,
        notes TEXT, priority INTEGER NOT NULL, due TEXT, labels TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL,
        link TEXT, path TEXT, created_at TEXT NOT NULL, closed_at TEXT)`);
      v1.run(`CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)`);
      v1.run(`INSERT INTO items (bucket, title, priority, source, created_at) VALUES ('work', 'old task', 2, 'manual', '2026-10-01')`);
      v1.run('PRAGMA user_version = 1');
      v1.close();

      const s = open(path);
      const [old] = await s.list('work');
      expect(old).toMatchObject({ title: 'old task', priority: 2 });
      expect(old!.estimate).toBeUndefined();
      expect((await s.update(old!.id, { estimate: 45 })).estimate).toBe(45);
    } finally {
      for (const s of stores.splice(0)) s.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('upgrades a v2 database to v3 without losing comments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'todo-brain-'));
    try {
      const path = join(dir, 'v2.db');
      const v2 = open(path);
      const q = await v2.create('questions', { title: 'who owns billing?' });
      await v2.comment(q.id, 'answer: Kranthi');
      v2.dispose();
      stores.pop();
      // Pretend it was written by the v2 schema so the rebuild runs again.
      const { Database } = await import('bun:sqlite');
      const raw = new Database(path);
      raw.run('PRAGMA user_version = 2');
      raw.close();

      const s = open(path);
      expect(s.comments(q.id)).toEqual(['answer: Kranthi']);
      expect((await s.list('questions'))[0]).toMatchObject({ title: 'who owns billing?', status: 'todo' });
      expect((await s.create('backlog', { title: 'parked' })).bucket).toBe('backlog');
    } finally {
      for (const s of stores.splice(0)) s.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('update moves buckets, sets status and labels, and clears the due date', async () => {
    const s = open();
    const { id } = await s.create('backlog', { title: 'gap', labels: ['ondc'] });
    const pulled = await s.update(id, { bucket: 'work', due: 'tomorrow', status: 'in-progress', labels: ['ondc', 'ado-21465'] });
    expect(pulled).toMatchObject({ bucket: 'work', due: '2026-10-02', status: 'in-progress', labels: ['ondc', 'ado-21465'] });
    expect(await s.list('backlog')).toEqual([]);
    const parked = await s.update(id, { bucket: 'backlog', due: null });
    expect(parked.bucket).toBe('backlog');
    expect(parked.due).toBeUndefined();
  });

  test('approach and notes can be set, changed and cleared', async () => {
    const s = open();
    const { id } = await s.create('questions', { title: 'q', notes: 'ctx', approach: 'plan A' });
    expect((await s.list('questions'))[0]).toMatchObject({ notes: 'ctx', approach: 'plan A' });
    expect(await s.update(id, { approach: 'plan B\nstep 2' })).toMatchObject({ notes: 'ctx', approach: 'plan B\nstep 2' });
    const cleared = await s.update(id, { notes: '', approach: '' });
    expect(cleared.notes).toBeUndefined();
    expect(cleared.approach).toBeUndefined();
    expect((await s.update(id, { title: 'q2' })).title).toBe('q2');
  });

  test('listCompleted returns recently closed items newest first; reopen brings one back', async () => {
    let clock = new Date('2026-10-01T09:00:00Z');
    const s = new SqliteStore({ path: ':memory:', now: () => clock });
    stores.push(s);
    const a = await s.create('work', { title: 'a' });
    const b = await s.create('work', { title: 'b' });
    await s.create('work', { title: 'still open' });
    await s.close(a.id);
    clock = new Date('2026-10-01T10:00:00Z');
    await s.close(b.id);

    const done = await s.listCompleted('work', '2026-09-30T00:00:00Z');
    expect(done.map((i) => [i.title, i.closedAt])).toEqual([['b', '2026-10-01T10:00:00.000Z'], ['a', '2026-10-01T09:00:00.000Z']]);
    expect(await s.listCompleted('work', '2026-10-01T09:30:00Z')).toHaveLength(1);
    expect(await s.listCompleted('questions', '2026-09-30T00:00:00Z')).toEqual([]);

    await s.reopen(a.id);
    expect((await s.list('work')).map((i) => i.title).sort()).toEqual(['a', 'still open']);
    expect((await s.list('work'))[0]!.closedAt).toBeUndefined();
    await expect(s.reopen('999')).rejects.toThrow(/No item 999/);
  });

  test('persists to disk across reopen, creating the folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'todo-brain-'));
    try {
      const path = join(dir, 'nested', 'brain.db');
      const first = open(path);
      await first.create('memory', { title: 'kept', labels: ['x'] });
      first.dispose();
      stores.pop();
      expect((await open(path).list('memory')).map((m) => m.title)).toEqual(['kept']);
    } finally {
      for (const s of stores.splice(0)) s.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
