import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BugNotes } from '../src/agents-settings.ts';
import { Developer } from '../src/developer/service.ts';
import { ActivityLog } from '../src/events/activity.ts';
import type { Terminal } from '../src/investigator/service.ts';
import { Investigations } from '../src/investigator/state.ts';
import { InMemoryStore } from '../src/store/in-memory.ts';
import { type ReportBody, ReportsDb } from '../src/store/reports.ts';

const tmp = () => `${process.env.TMPDIR ?? '/tmp'}/dev-${Date.now()}-${Math.random().toString(36).slice(2)}`.replace(/\/\//g, '/');
const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(args, { cwd, stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

const report: ReportBody = {
  verdict: 'bug',
  confidence: 'high',
  summary: 'Total uses floor.',
  requirement: { covered: 'yes', note: 'AC-1' },
  rootCause: 'Math.floor in cart.ts',
  files: [{ repo: 'shop', path: 'cart.ts', lines: '1' }],
  fix: { approach: 'Use Math.round', changes: [{ repo: 'shop', path: 'cart.ts', before: 'Math.floor(x)', after: 'Math.round(x)' }] },
  tests: ['total 10.5 rounds to 11'],
  openQuestions: [],
};

describe('Developer', () => {
  let state: string;
  let repos: string;
  let repo: string;
  let reports: ReportsDb;
  let investigations: Investigations;
  let store: InMemoryStore;
  let term: Terminal & { opened: string[]; typed: string[] };
  let adoCalls: any[];
  let dev: Developer;

  beforeEach(async () => {
    state = tmp();
    repos = tmp();
    repo = join(repos, 'shop');
    mkdirSync(repo, { recursive: true });
    sh(repo, 'git', 'init', '-q', '-b', 'main');
    sh(repo, 'git', 'remote', 'add', 'origin', 'https://dev.azure.com/xavica/Qwipo%20B2B/_git/shop');
    writeFileSync(join(repo, 'cart.ts'), 'export const total = (x: number) => Math.floor(x);\n');
    sh(repo, 'git', 'add', '.');
    sh(repo, 'git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    sh(repo, 'git', 'checkout', '-qb', 'dev');
    writeFileSync(join(repo, 'wip.txt'), 'my uncommitted work\n'); // the developer's own WIP

    reports = new ReportsDb(':memory:');
    investigations = new Investigations(join(state, 'inv.json'));
    store = new InMemoryStore();
    term = {
      opened: [],
      typed: [],
      openWindow(c) { this.opened.push(c); return `it-${this.opened.length}`; },
      sessionAlive: () => true,
      focus: () => true,
      type(_i, l) { this.typed.push(l); return true; },
    };
    adoCalls = [];
    const ado: any = {
      bugUrl: (id: number) => `https://ado/${id}`,
      async workItem(id: number) { return { id, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'New' }, relations: [] }; },
      async updateWorkItem(id: number, ops: any[]) { adoCalls.push({ id, ops }); return { id, rev: 2, fields: {} }; },
    };
    dev = new Developer({ stateDir: state, reposRoot: repos, repoRemote: 'dev.azure.com/xavica', store, reports, reportsPath: '/tmp/b.db', investigations, bugNotes: new BugNotes(join(state, 'n.json')), activity: new ActivityLog(join(state, 'a.jsonl')), ado, knowledgeDir: join(state, 'investigator'), terminal: term });
    await store.create('work', { title: 'Bug 9: total', source: 'azure-devops', labels: ['ado-9', 'bug', 'approved'] });
  });

  const approve = () => {
    reports.save(9, report, 'inv-1');
    investigations.put({ bugId: 9, title: 'total', sessionId: 'inv-1', status: 'approved', startedAt: '', updatedAt: '', reviews: [] });
  };

  test('needs an approved report', async () => {
    await expect(dev.start(9)).rejects.toThrow(/approved report/);
  });

  test('start: worktree on fix/bug-9 from the current branch; checkout untouched; locked settings; ADO → Active', async () => {
    approve();
    const s = await dev.start(9);
    const wt = s.worktrees[0]!;
    expect(wt).toMatchObject({ repo: 'shop', branch: 'fix/bug-9', base: 'dev', sourceDirty: true });
    expect(existsSync(join(wt.path, 'cart.ts'))).toBe(true);
    expect(existsSync(join(wt.path, 'wip.txt'))).toBe(false); // my WIP stays in my checkout only
    expect(sh(repo, 'git', 'branch', '--show-current')).toBe('dev');
    expect(readFileSync(join(repo, 'wip.txt'), 'utf8')).toBe('my uncommitted work\n');

    const brief = readFileSync(join(dev.folder(9), 'DEV-BRIEF.md'), 'utf8');
    expect(brief).toContain('Math.round(x)');
    expect(brief).toContain('not** in your worktree');

    const p = JSON.parse(readFileSync(join(dev.folder(9), 'settings.json'), 'utf8')).permissions;
    expect(p.deny).toContain(`Edit(/${repos}/**)`);
    expect(p.allow).toContain(`Edit(/${wt.path}/**)`);
    expect(p.deny).toContain('Bash(git commit *)');
    expect(p.deny).toContain('Bash(git push *)');
    expect(p.allow.some((r: string) => /npm run|bun run|install/.test(r))).toBe(false);
    const mcp = JSON.parse(readFileSync(join(dev.folder(9), 'mcp.json'), 'utf8')).mcpServers.reports.env.TODO_BRAIN_ONLY;
    expect(mcp).toBe('get_report,get_dev_result,save_dev_result');

    expect(adoCalls[0].ops.find((o: any) => o.path === '/fields/System.State').value).toBe('Active');
    expect(s.ado).toBe('Bug 9 → Active');
    expect((await store.list('work'))[0]?.labels).toContain('in-development');
    expect(term.opened).toHaveLength(1);
  });

  test('result → review; diff includes edits and new files; approve keeps it uncommitted', async () => {
    approve();
    const s = await dev.start(9);
    const wt = s.worktrees[0]!.path;
    writeFileSync(join(wt, 'cart.ts'), 'export const total = (x: number) => Math.round(x);\n');
    writeFileSync(join(wt, 'cart.test.ts'), 'test\n');
    reports.saveDevResult(9, { summary: 'Round instead of floor.', changes: [{ repo: 'shop', files: ['cart.ts', 'cart.test.ts'] }], tests: [{ command: 'bun test', result: 'passed' }], notes: [] }, s.sessionId);
    expect((await dev.refresh())[0]?.status).toBe('ready-for-review');

    const c = dev.changes(9);
    expect(c.diffs[0]!.diff).toContain('+export const total = (x: number) => Math.round(x);');
    expect(c.diffs[0]!.diff).toContain('cart.test.ts');

    await dev.review(9, 'changes', 'also handle negatives');
    expect(term.typed[0]).toContain('get_dev_result for bug 9');
    const ok = await dev.review(9, 'approve');
    expect(ok.status).toBe('approved');
    expect(sh(wt, 'git', 'status', '--porcelain')).toContain('cart.ts'); // still uncommitted
    expect(sh(wt, 'git', 'log', '--oneline')).toBe(sh(repo, 'git', 'log', '--oneline', '-1', 'main')); // no new commit
    expect((await store.list('work'))[0]?.labels).toContain('dev-approved');
  });

  test('discard removes the worktree and the fix branch, leaving my checkout alone', async () => {
    approve();
    const s = await dev.start(9);
    await dev.review(9, 'discard');
    expect(existsSync(s.worktrees[0]!.path)).toBe(false);
    expect(sh(repo, 'git', 'branch', '--list', 'fix/bug-9')).toBe('');
    expect(readFileSync(join(repo, 'wip.txt'), 'utf8')).toBe('my uncommitted work\n');
    expect(dev.sessions.get(9)?.status).toBe('discarded');
  });
});
