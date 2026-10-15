import { InMemoryStore } from './store/in-memory.ts';
import { SqliteStore } from './store/sqlite.ts';
import type { Store } from './store/store.ts';
import { TodoistStore } from './store/todoist.ts';
import { resolvePath } from './tools/files.ts';

/**
 * Environment → store. Shared by the MCP server and the dashboard so both
 * always open the same data.
 */

// stdout is the MCP channel — every log line goes to stderr.
export const log = (msg: string) => console.error(`[todo-brain] ${msg}`);

const token = process.env.TODOIST_API_TOKEN;
const dryRun = process.env.TODO_BRAIN_DRY_RUN === '1';
export const filesRoot = process.env.TODO_BRAIN_FILES_ROOT ? resolvePath(process.env.TODO_BRAIN_FILES_ROOT) : undefined;
/** Default: <files root>/.todo-brain/brain.db, else ~/.todo-brain/brain.db. */
export const dbPath = resolvePath(
  process.env.TODO_BRAIN_DB ?? (filesRoot ? `${filesRoot}/.todo-brain/brain.db` : '~/.todo-brain/brain.db'),
);

/** Store selection: dry run → memory; Todoist token → Todoist; otherwise the local SQLite file. */
export function pickStore(): Store {
  if (dryRun) {
    log('dry run: using an in-memory store, nothing is saved');
    return new InMemoryStore();
  }
  if (token) {
    log('store: Todoist');
    return new TodoistStore({ token });
  }
  log(`store: local SQLite at ${dbPath}`);
  return new SqliteStore({ path: dbPath });
}

export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
