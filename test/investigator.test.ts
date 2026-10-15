import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdoClient } from '../src/ado/client.ts';
import { BugNotes } from '../src/agents-settings.ts';
import { ActivityLog } from '../src/events/activity.ts';
import { Investigator, type Terminal } from '../src/investigator/service.ts';
import { InMemoryStore } from '../src/store/in-memory.ts';
import { type ReportBody, ReportsDb } from '../src/store/reports.ts';

const tmp = () => `${process.env.TMPDIR ?? '/tmp'}/inv-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Bug 9 → Story 8 → Feature 7, one comment. */
const fakeAdo = {
  bugUrl: (id: number) => `https://ado/${id}`,
  async workItem(id: number) {
    const items: Record<number, any> = {
      9: { fields: { 'System.Title': 'Total wrong', 'System.State': 'Active', 'System.WorkItemType': 'Bug', 'Microsoft.VSTS.TCM.ReproSteps': '<div>1) add to cart</div>', 'System.CreatedBy': 'QA <qa@x.com>', 'System.CreatedDate': '2026-10-14T10:00:00Z', 'System.IterationPath': 'S77' }, relations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://x/_apis/wit/workItems/8' }] },
      8: { fields: { 'System.Title': 'Cart story', 'System.WorkItemType': 'Story', 'System.State': 'Active', 'Microsoft.VSTS.Common.AcceptanceCriteria': '<div>AC-1: total = sum</div>' }, relations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://x/_apis/wit/workItems/7' }] },
      7: { fields: { 'System.Title': 'Cart feature', 'System.WorkItemType': 'Feature' }, relations: [] },
    };
    return { id, ...items[id] };
  },
  async commentThread() {
    return [{ by: 'Dev', at: '2026-10-14T11:00:00Z', html: '<div>Looks like rounding</div>' }];
  },
} as unknown as AdoClient;

describe('Investigator', () => {
  let state: string;
  let repos: string;
  let store: InMemoryStore;
  let term: Terminal & { opened: string[]; typed: string[]; alive: boolean };
  let inv: Investigator;
  let reports: ReportsDb;

  beforeEach(async () => {
    state = tmp();
    repos = join(tmp(), 'GitHub');
    mkdirSync(repos, { recursive: true });
    store = new InMemoryStore();
    term = {
      opened: [],
      typed: [],
      alive: true,
      openWindow(cmd) {
        this.opened.push(cmd);
        return `iterm-${this.opened.length}`;
      },
      sessionAlive() {
        return this.alive;
      },
      focus: () => true,
      type(_id, line) {
        this.typed.push(line);
        return true;
      },
    };
    const notes = new BugNotes(join(state, 'notes.json'));
    notes.add(9, 'recommendation', 'check rounding in cart total');
    reports = new ReportsDb(':memory:');
    inv = new Investigator({ stateDir: state, reposRoot: repos, repoRemote: 'dev.azure.com/xavica', store, reports, reportsPath: '/tmp/brain.db', bugNotes: notes, activity: new ActivityLog(join(state, 'a.jsonl')), ado: fakeAdo, terminal: term });
    await store.create('work', { title: 'Bug 9: Total wrong', source: 'azure-devops', labels: ['ado-9', 'bug', 'to-investigate'] });
  });

  test('start writes the brief, locked settings and run.sh, and opens one window', async () => {
    const i = await inv.start(9);
    const ws = inv.workspace(9);
    const brief = readFileSync(join(ws, 'BRIEF.md'), 'utf8');
    expect(brief).toContain('# Bug 9: Total wrong');
    expect(brief).toContain('1) add to cart');
    expect(brief).toContain('Looks like rounding');
    expect(brief).toContain('Story 8: Cart story');
    expect(brief).toContain('AC-1: total = sum');
    expect(brief).toContain('Feature 7: Cart feature');
    expect(brief).toContain('check rounding in cart total');

    const settings = JSON.parse(readFileSync(join(ws, 'settings.json'), 'utf8')).permissions;
    expect(settings.defaultMode).toBe('dontAsk');
    expect(settings.deny).toContain(`Edit(/${repos}/**)`);
    expect(settings.deny).toContain(`Edit(/${ws}/**)`);
    expect(settings.allow.filter((r: string) => r.startsWith("Edit("))).toEqual([`Edit(/${join(state, "investigator")}/**)`]);
    expect(settings.allow).toContain('mcp__reports__save_report');
    expect(settings.allow.some((r: string) => r.startsWith('mcp__') && !/report/.test(r))).toBe(false);
    const mcp = JSON.parse(readFileSync(join(ws, 'mcp.json'), 'utf8')).mcpServers;
    expect(Object.keys(mcp)).toEqual(['reports']);
    expect(mcp.reports.env).toEqual({ TODO_BRAIN_DB: '/tmp/brain.db', TODO_BRAIN_ONLY: 'save_report,get_report,list_reports' });

    const run = readFileSync(join(ws, 'run.sh'), 'utf8');
    expect(run).toContain(`--session-id ${i.sessionId}`);
    expect(run).toContain('--strict-mcp-config --mcp-config');
    expect(run).toContain(i.sessionId); // the prompt carries the investigation id for save_report
    expect(run.indexOf("claude 'Investigate bug 9")).toBeGreaterThan(0); // prompt before the variadic flags
    expect(term.opened).toHaveLength(1);
    expect(existsSync(inv.knowledgeFile)).toBe(true);
    expect((await store.list('work'))[0]?.labels).toEqual(['ado-9', 'bug', 'investigating']);
  });

  test('starting again reuses the open window instead of a second session', async () => {
    await inv.start(9);
    await inv.start(9);
    expect(term.opened).toHaveLength(1);
    term.alive = false;
    expect(await inv.openTerminal(9)).toBe('resumed');
    expect(term.opened[1]).toContain('resume.sh');
    expect(readFileSync(join(inv.workspace(9), 'resume.sh'), 'utf8')).toContain('--resume ');
  });

  const body = (extra: Partial<ReportBody> = {}): ReportBody => ({
    verdict: 'bug',
    confidence: 'high',
    summary: 'Rounding drops paise.',
    requirement: { covered: 'yes', note: 'AC-1: total = sum' },
    rootCause: 'Math.floor in cart total',
    files: [{ repo: 'r', path: 'cart.ts', lines: '10' }],
    fix: { approach: 'Use round', changes: [{ repo: 'r', path: 'cart.ts', before: 'floor', after: 'round' }] },
    tests: ['total 10.5'],
    openQuestions: [],
    ...extra,
  });

  test('a saved report makes it report-ready; a review goes to todo-brain and the live session', async () => {
    const started = await inv.start(9);
    reports.save(9, body(), started.sessionId);
    const [i] = await inv.refresh();
    expect(i?.status).toBe('report-ready');
    expect(i?.reportVersion).toBe(1);
    expect((await store.list('work'))[0]?.labels).toContain('report-ready');
    expect(inv.report(9).report?.verdict).toBe('bug');

    await inv.review(9, 'changes', 'also cover the\nzero-quantity case');
    expect(reports.reviews(9)).toMatchObject([{ version: 1, decision: 'changes', feedback: 'also cover the\nzero-quantity case' }]);
    expect(term.typed[0]).toContain('get_report for bug 9');
    expect(inv.investigations.get(9)?.status).toBe('changes-requested');

    reports.save(9, body({ confidence: 'medium' }), started.sessionId);
    expect((await inv.refresh())[0]?.status).toBe('report-ready');
    const approved = await inv.review(9, 'approve');
    expect(approved.status).toBe('approved');
    expect(reports.reviews(9).at(-1)).toMatchObject({ version: 2, decision: 'approve' });
    expect((await store.list('work'))[0]?.labels).toContain('approved');
  });

  test('changes need feedback; reviewing before any report fails', async () => {
    await inv.start(9);
    await expect(inv.review(9, 'approve')).rejects.toThrow(/no report/);
    reports.save(9, body());
    await expect(inv.review(9, 'changes', ' ')).rejects.toThrow();
  });

  test('a report.json left by the first version is imported into todo-brain once', async () => {
    await inv.start(9);
    writeFileSync(join(inv.workspace(9), 'report.json'), JSON.stringify({ verdict: 'requirement-gap', confidence: 'medium', summary: 's', requirement: { covered: 'no', evidence: 'e' }, files: [{ repo: 'r', path: 'p', why: 'w' }], fix: { approach: 'a', changes: [] }, risks: ['x'] }));
    await inv.refresh();
    await inv.refresh();
    expect(reports.list(9)).toHaveLength(1);
    expect(reports.get(9)).toMatchObject({ verdict: 'requirement-gap', requirement: { covered: 'no', note: 'e' }, version: 1 });
    expect(inv.investigations.get(9)?.status).toBe('report-ready');
  });
});
