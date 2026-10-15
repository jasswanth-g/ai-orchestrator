import {
  BUCKETS,
  type Bucket,
  DEFAULT_PRIORITY,
  DEFAULT_SOURCE,
  type Item,
  type ItemPatch,
  type NewItem,
  type Priority,
  STATUSES,
  type Status,
} from '../types.ts';
import { decodeDescription, encodeDescription } from './meta.ts';
import type { Store } from './store.ts';

const API = 'https://api.todoist.com/api/v1';

interface TodoistTask {
  id: string;
  content: string;
  description: string;
  priority: number;
  due: { date: string } | null;
  labels: string[];
  project_id: string;
  added_at?: string;
  created_at?: string;
}

interface TodoistProject {
  id: string;
  name: string;
}

interface Page<T> {
  results: T[];
  next_cursor: string | null;
}

export class TodoistError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Todoist API ${status}: ${body.slice(0, 300)}`);
  }
}

/** Todoist's API scale is inverted: API 4 = P1 (urgent), API 1 = P4. */
export const toApiPriority = (p: Priority): number => 5 - p;
export const fromApiPriority = (n: number): Priority => (5 - Math.min(4, Math.max(1, n))) as Priority;

export interface TodoistStoreOptions {
  token: string;
  fetch?: typeof fetch;
}

export class TodoistStore implements Store {
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  /** bucket → project id, resolved once (projects are created if missing). */
  private projects?: Promise<Record<Bucket, string>>;

  constructor(opts: TodoistStoreOptions) {
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? fetch;
  }

  async list(bucket: Bucket): Promise<Item[]> {
    const projectId = (await this.projectIds())[bucket];
    const tasks = await this.getAll<TodoistTask>('/tasks', { project_id: projectId });
    return tasks.map((t) => this.toItem(t, bucket));
  }

  async create(bucket: Bucket, item: NewItem): Promise<Item> {
    const projectId = (await this.projectIds())[bucket];
    const task = await this.call<TodoistTask>('POST', '/tasks', {
      content: item.title,
      description: encodeDescription(item.notes, {
        source: item.source ?? DEFAULT_SOURCE,
        link: item.link,
        path: item.path,
        estimate: item.estimate?.toString(),
        approach: item.approach,
      }),
      project_id: projectId,
      priority: toApiPriority(item.priority ?? DEFAULT_PRIORITY),
      labels: item.labels ?? [],
      ...(item.due ? { due_string: item.due } : {}),
    });
    return this.toItem(task, bucket);
  }

  async update(id: string, patch: ItemPatch): Promise<Item> {
    // Estimate and status live in the description footer, so changing them means re-encoding the description.
    let description: string | undefined;
    if (patch.estimate !== undefined || patch.status !== undefined || patch.notes !== undefined || patch.approach !== undefined) {
      const current = await this.call<TodoistTask>('GET', `/tasks/${id}`);
      const { notes, meta } = decodeDescription(current.description ?? '');
      description = encodeDescription(patch.notes !== undefined ? patch.notes || undefined : notes, {
        ...meta,
        ...(patch.approach !== undefined ? { approach: patch.approach || undefined } : {}),
        ...(patch.estimate !== undefined ? { estimate: patch.estimate.toString() } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      });
    }
    if (patch.bucket) await this.call('POST', `/tasks/${id}/move`, { project_id: (await this.projectIds())[patch.bucket] });
    const task = await this.call<TodoistTask>('POST', `/tasks/${id}`, {
      ...(description !== undefined ? { description } : {}),
      ...(patch.title ? { content: patch.title } : {}),
      ...(patch.priority ? { priority: toApiPriority(patch.priority) } : {}),
      ...(patch.due ? { due_string: patch.due } : patch.due === null ? { due_string: 'no date' } : {}),
      ...(patch.labels ? { labels: patch.labels } : {}),
    });
    return this.toItem(task, await this.bucketOf(task.project_id));
  }

  async close(id: string): Promise<void> {
    await this.call('POST', `/tasks/${id}/close`);
  }

  async listCompleted(bucket: Bucket, since: string): Promise<Item[]> {
    const projectId = (await this.projectIds())[bucket];
    const out: Item[] = [];
    let cursor: string | null = null;
    do {
      const qs = new URLSearchParams({ since, until: new Date().toISOString(), project_id: projectId, limit: '200', ...(cursor ? { cursor } : {}) });
      const page: { items: (TodoistTask & { completed_at?: string })[]; next_cursor: string | null } = await this.call(
        'GET',
        `/tasks/completed/by_completion_date?${qs}`,
      );
      out.push(...page.items.map((t) => ({ ...this.toItem(t, bucket), closedAt: t.completed_at })));
      cursor = page.next_cursor;
    } while (cursor);
    return out.sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
  }

  async reopen(id: string): Promise<void> {
    await this.call('POST', `/tasks/${id}/reopen`);
  }

  async remove(id: string): Promise<void> {
    await this.call('DELETE', `/tasks/${id}`);
  }

  async comment(id: string, text: string): Promise<void> {
    await this.call('POST', '/comments', { task_id: id, content: text });
  }

  // ── internals ──────────────────────────────────────────────

  private projectIds(): Promise<Record<Bucket, string>> {
    this.projects ??= this.ensureProjects().catch((err) => {
      this.projects = undefined; // let the next call retry
      throw err;
    });
    return this.projects;
  }

  /** Finds the three bucket projects by name; creates any that are missing. */
  private async ensureProjects(): Promise<Record<Bucket, string>> {
    const existing = await this.getAll<TodoistProject>('/projects');
    const ids = {} as Record<Bucket, string>;
    for (const [bucket, name] of Object.entries(BUCKETS) as [Bucket, string][]) {
      const found = existing.find((p) => p.name === name);
      ids[bucket] = found ? found.id : (await this.call<TodoistProject>('POST', '/projects', { name })).id;
    }
    return ids;
  }

  private async bucketOf(projectId: string): Promise<Bucket> {
    const ids = await this.projectIds();
    const hit = (Object.keys(ids) as Bucket[]).find((b) => ids[b] === projectId);
    return hit ?? 'work';
  }

  private toItem(t: TodoistTask, bucket: Bucket): Item {
    const { notes, meta } = decodeDescription(t.description ?? '');
    return {
      id: t.id,
      bucket,
      title: t.content,
      notes,
      priority: fromApiPriority(t.priority),
      due: t.due?.date,
      labels: t.labels ?? [],
      source: meta.source ?? DEFAULT_SOURCE,
      link: meta.link,
      path: meta.path,
      estimate: meta.estimate ? Number(meta.estimate) : undefined,
      approach: meta.approach,
      status: STATUSES.includes(meta.status as Status) ? (meta.status as Status) : 'todo',
      createdAt: t.added_at ?? t.created_at ?? '',
    };
  }

  private async getAll<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    do {
      const qs = new URLSearchParams({ ...params, limit: '200', ...(cursor ? { cursor } : {}) });
      const page: Page<T> = await this.call<Page<T>>('GET', `${path}?${qs}`);
      out.push(...page.results);
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  }

  private async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new TodoistError(res.status, await res.text());
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
