import { describe, expect, test } from 'bun:test';
import { fromApiPriority, toApiPriority, TodoistError, TodoistStore } from '../src/store/todoist.ts';

type Call = { method: string; url: string; body?: any };

/** Minimal fake of the Todoist v1 API: routes by method + path prefix. */
function fakeApi(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const call: Call = { method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const path = new URL(url).pathname.replace('/api/v1', '');
    const key = Object.keys(routes).find((k) => `${call.method} ${path}`.startsWith(k));
    if (!key) return new Response('not found', { status: 404 });
    const out = routes[key]!(call);
    return out === undefined ? new Response(null, { status: 204 }) : Response.json(out);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('priority mapping', () => {
  test('P1 ↔ API 4, P4 ↔ API 1', () => {
    expect(toApiPriority(1)).toBe(4);
    expect(toApiPriority(4)).toBe(1);
    expect(fromApiPriority(4)).toBe(1);
    expect(fromApiPriority(1)).toBe(4);
  });
});

describe('TodoistStore', () => {
  test('creates missing projects once, reuses existing ones', async () => {
    let created = 0;
    const { fetchFn, calls } = fakeApi({
      'GET /projects': () => ({ results: [{ id: 'p-work', name: 'Work' }], next_cursor: null }),
      'POST /projects': (c) => ({ id: `p-${++created}`, name: c.body.name }),
      'GET /tasks': () => ({ results: [], next_cursor: null }),
    });
    const store = new TodoistStore({ token: 't', fetch: fetchFn });
    await store.list('work');
    await store.list('memory');
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body.name)).toEqual(['Questions', 'Memory Bank', 'Backlog']);
    expect(calls.filter((c) => c.url.includes('/projects') && c.method === 'GET')).toHaveLength(1);
    expect(calls.at(-1)!.url).toContain('project_id=p-2'); // Memory Bank
  });

  test('follows next_cursor and maps tasks to items', async () => {
    const { fetchFn } = fakeApi({
      'GET /projects': () => ({
        results: [{ id: 'w', name: 'Work' }, { id: 'q', name: 'Questions' }, { id: 'm', name: 'Memory Bank' }, { id: 'b', name: 'Backlog' }],
        next_cursor: null,
      }),
      'GET /tasks': (c) =>
        c.url.includes('cursor=c2')
          ? { results: [task('2', 1)], next_cursor: null }
          : { results: [task('1', 4)], next_cursor: 'c2' },
    });
    const items = await new TodoistStore({ token: 't', fetch: fetchFn }).list('work');
    expect(items.map((i) => [i.id, i.priority])).toEqual([['1', 1], ['2', 4]]);
    expect(items[0]).toMatchObject({ source: 'mail', link: 'https://m/1', notes: 'ctx', due: '2026-10-02' });
  });

  test('create sends API priority, encoded description and due_string', async () => {
    const { fetchFn, calls } = fakeApi({
      'GET /projects': () => ({
        results: [{ id: 'w', name: 'Work' }, { id: 'q', name: 'Questions' }, { id: 'm', name: 'Memory Bank' }, { id: 'b', name: 'Backlog' }],
        next_cursor: null,
      }),
      'POST /tasks': (c) => ({ ...task('9', c.body.priority), content: c.body.content, description: c.body.description }),
    });
    const item = await new TodoistStore({ token: 't', fetch: fetchFn }).create('work', {
      title: 'Reply to TCP',
      priority: 1,
      due: 'tomorrow',
      source: 'mail',
    });
    const body = calls.at(-1)!.body;
    expect(body).toMatchObject({ content: 'Reply to TCP', project_id: 'w', priority: 4, due_string: 'tomorrow' });
    expect(body.description).toBe('---\nsource: mail');
    expect(item.priority).toBe(1);
  });

  test('API errors surface status and body', async () => {
    const fetchFn = (async () => new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch;
    const err = await new TodoistStore({ token: 'bad', fetch: fetchFn }).list('work').catch((e) => e);
    expect(err).toBeInstanceOf(TodoistError);
    expect(err.message).toContain('401');
  });

  test('listCompleted reads the completed-by-date endpoint; reopen posts to /reopen', async () => {
    const { fetchFn, calls } = fakeApi({
      'GET /projects': () => ({
        results: [{ id: 'w', name: 'Work' }, { id: 'q', name: 'Questions' }, { id: 'm', name: 'Memory Bank' }, { id: 'b', name: 'Backlog' }],
        next_cursor: null,
      }),
      'GET /tasks/completed/by_completion_date': () => ({
        items: [
          { ...task('1', 1), completed_at: '2026-10-01T09:00:00Z' },
          { ...task('2', 2), completed_at: '2026-10-02T09:00:00Z' },
        ],
        next_cursor: null,
      }),
      'POST /tasks/7/reopen': () => undefined,
    });
    const store = new TodoistStore({ token: 't', fetch: fetchFn });
    const done = await store.listCompleted('work', '2026-09-20T00:00:00Z');
    expect(done.map((i) => [i.id, i.closedAt])).toEqual([['2', '2026-10-02T09:00:00Z'], ['1', '2026-10-01T09:00:00Z']]);
    const url = new URL(calls.find((c) => c.url.includes('/completed/'))!.url);
    expect(url.searchParams.get('project_id')).toBe('w');
    expect(url.searchParams.get('since')).toBe('2026-09-20T00:00:00Z');
    await store.reopen('7');
    expect(calls.at(-1)).toMatchObject({ method: 'POST' });
    expect(calls.at(-1)!.url).toEndWith('/tasks/7/reopen');
  });
});

function task(id: string, priority: number) {
  return {
    id,
    content: `task ${id}`,
    description: 'ctx\n---\nsource: mail\nlink: https://m/1',
    priority,
    due: { date: '2026-10-02' },
    labels: [],
    project_id: 'w',
    added_at: '2026-10-01T00:00:00Z',
  };
}
