import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AdoClient } from '../ado/client.ts';
import type { BugNotes } from '../agents-settings.ts';
import type { ActivityLog } from '../events/activity.ts';
import type { ReportBody, ReportsDb } from '../store/reports.ts';
import type { Store } from '../store/store.ts';
import { buildBrief } from './brief.ts';
import * as iterm from './iterm.ts';
import { repoIndexSeed, workRepos } from './repos.ts';
import { type Investigation, Investigations, type InvestigationStatus, type Review } from './state.ts';

/**
 * The Investigator: one interactive Claude Code session per bug, in its own
 * iTerm window the developer can watch and talk to. Each bug gets a folder with
 * BRIEF.md (gathered from ADO), a locked-down settings.json, mcp.json and run.sh.
 * The report is not a file: Claude saves it to todo-brain with `save_report`
 * (versioned, tagged to the bug and this investigation) and reads the
 * developer's review with `get_report`. Sessions stay resumable until resolved.
 *
 * Safety: the session runs in `dontAsk` mode — anything not on the allow list
 * is refused without prompting. It can read the work repos and run read-only
 * git; it can edit only the repo knowledge file; its only MCP server is
 * todo-brain, limited to the three report tools; no web.
 */

export interface Terminal {
  openWindow(command: string): string;
  sessionAlive(id: string): boolean;
  focus(id: string): boolean;
  type(id: string, line: string): boolean;
}

const PROMPT_FILE = new URL('../../prompts/investigator.md', import.meta.url).pathname;
const TODO_BRAIN_ENTRY = new URL('../index.ts', import.meta.url).pathname;
const REPORT_TOOL_NAMES = ['save_report', 'get_report', 'list_reports'];
/**
 * The session's MCP server is todo-brain under another name and with only the
 * report tools: a user-level allow rule like `mcp__todo-brain` would otherwise
 * approve every todo-brain tool (add_task, remember, …) in this session.
 */
const MCP_NAME = 'reports';
const REPORT_TOOLS = REPORT_TOOL_NAMES.map((t) => `mcp__${MCP_NAME}__${t}`);
const STATUS_LABELS: Record<InvestigationStatus, string> = {
  running: 'investigating',
  'report-ready': 'report-ready',
  'changes-requested': 'changes-requested',
  approved: 'approved',
  rejected: 'rejected',
};
const FLOW_LABELS = ['to-investigate', ...Object.values(STATUS_LABELS)];

/** Absolute path in permission-rule form: `//abs/path`. */
const rulePath = (p: string) => `/${p}`;
/** Single-quoted for zsh. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class Investigator {
  readonly investigations: Investigations;
  private readonly root: string;
  readonly knowledgeFile: string;
  private readonly term: Terminal;

  constructor(
    private readonly o: {
      stateDir: string;
      /** Folder holding the git clones. */
      reposRoot: string;
      /** Only clones whose origin contains this are work repos. */
      repoRemote: string;
      store: Store;
      /** Where reports are saved and reviewed; the session's todo-brain uses the same file. */
      reports: ReportsDb;
      reportsPath: string;
      bugNotes: BugNotes;
      activity: ActivityLog;
      ado: AdoClient;
      /** iTerm by default; swapped out in tests. */
      terminal?: Terminal;
    },
  ) {
    this.term = o.terminal ?? iterm;
    this.root = join(o.stateDir, 'investigations');
    this.investigations = new Investigations(join(this.root, 'investigations.json'));
    this.knowledgeFile = join(o.stateDir, 'investigator', 'REPOS.md');
  }

  workspace = (bugId: number) => join(this.root, `bug-${bugId}`);
  bugUrl = (bugId: number) => this.o.ado.bugUrl(bugId);

  /** REPOS.md is seeded once; after that the Investigator and the developer own it. */
  private ensureKnowledge(): void {
    if (existsSync(this.knowledgeFile)) return;
    mkdirSync(dirname(this.knowledgeFile), { recursive: true });
    writeFileSync(this.knowledgeFile, repoIndexSeed(workRepos(this.o.reposRoot, this.o.repoRemote)));
  }

  private writeSettings(ws: string): string {
    const knowledgeDir = dirname(this.knowledgeFile);
    // Only `git <subcommand> *`: a wildcard before the subcommand (`git -C * log *`) would
    // also approve `git -c …` / `--exec-path`, which can run arbitrary commands.
    const gitReadOnly = ['log', 'show', 'blame', 'diff', 'grep', 'ls-files'].map((c) => `Bash(git ${c} *)`);
    const settings = {
      // My own hooks (SessionStart briefs etc.) are not for this session.
      disableAllHooks: true,
      permissions: {
        defaultMode: 'dontAsk',
        allow: [
          `Read(${rulePath(this.o.reposRoot)}/**)`,
          `Read(${rulePath(ws)}/**)`,
          `Read(${rulePath(knowledgeDir)}/**)`,
          `Edit(${rulePath(knowledgeDir)}/**)`,
          ...REPORT_TOOLS,
          'Grep',
          'Glob',
          ...gitReadOnly,
          // So git can run from inside a repo: `cd <repo>`, then `git log …` as a separate call.
          'Bash(cd *)',
          'Bash(ls *)',
          'Bash(az boards work-item show *)',
        ],
        // No MCP deny here: deny beats allow, and the report tools must stay usable.
        // --strict-mcp-config + mcp.json make the reports-only server the only MCP server.
        deny: [`Edit(${rulePath(this.o.reposRoot)}/**)`, `Edit(${rulePath(ws)}/**)`, 'Bash(git * --output*)', 'WebFetch', 'WebSearch'],
      },
    };
    const file = join(ws, 'settings.json');
    writeFileSync(file, JSON.stringify(settings, null, 2));
    // The only MCP server: this repo's todo-brain, on the same DB the dashboard reads.
    const mcp = {
      mcpServers: {
        [MCP_NAME]: { command: process.execPath, args: ['run', TODO_BRAIN_ENTRY], env: { TODO_BRAIN_DB: this.o.reportsPath, TODO_BRAIN_ONLY: REPORT_TOOL_NAMES.join(',') } },
      },
    };
    writeFileSync(join(ws, 'mcp.json'), JSON.stringify(mcp, null, 2));
    return file;
  }

  /** The claude command line. The prompt goes first: the variadic flags after it would swallow it. */
  private command(ws: string, inv: Investigation, mode: 'new' | 'resume', prompt?: string): string {
    const flags = [
      mode === 'new' ? `--session-id ${inv.sessionId}` : `--resume ${inv.sessionId}`,
      `--name ${sh(`Bug ${inv.bugId}`)}`,
      `--settings ${sh(join(ws, 'settings.json'))}`,
      `--append-system-prompt-file ${sh(PROMPT_FILE)}`,
      `--strict-mcp-config --mcp-config ${sh(join(ws, 'mcp.json'))}`,
      `--add-dir ${sh(this.o.reposRoot)} ${sh(dirname(this.knowledgeFile))}`,
    ];
    return `cd ${sh(ws)} && claude ${prompt ? `${sh(prompt)} ` : ''}${flags.join(' ')}`;
  }

  /** Writes run.sh (so the window shows one short command) and opens it in iTerm. */
  private launch(inv: Investigation, mode: 'new' | 'resume', prompt?: string): string {
    const ws = this.workspace(inv.bugId);
    const script = join(ws, mode === 'new' ? 'run.sh' : 'resume.sh');
    writeFileSync(script, `#!/bin/zsh\n# Bug ${inv.bugId}: ${inv.title.replace(/\n/g, ' ')}\n${this.command(ws, inv, mode, prompt)}\n`);
    chmodSync(script, 0o755);
    return this.term.openWindow(`clear; ${sh(script)}`);
  }

  private async syncLabels(bugId: number, status: InvestigationStatus): Promise<void> {
    const task = (await this.o.store.list('work')).find((t) => t.labels.includes(`ado-${bugId}`));
    if (!task) return;
    const labels = [...task.labels.filter((l) => !FLOW_LABELS.includes(l)), STATUS_LABELS[status]];
    await this.o.store.update(task.id, { labels });
  }

  private async setStatus(inv: Investigation, status: InvestigationStatus, extra: Partial<Investigation> = {}): Promise<Investigation> {
    const next = this.investigations.put({ ...inv, ...extra, status });
    if (status !== inv.status) await this.syncLabels(inv.bugId, status);
    return next;
  }

  /** Starts a bug's investigation, or brings its terminal back if one exists. */
  async start(bugId: number): Promise<Investigation> {
    const existing = this.investigations.get(bugId);
    if (existing) {
      await this.openTerminal(bugId);
      return this.investigations.get(bugId)!;
    }
    this.ensureKnowledge();
    const ws = this.workspace(bugId);
    mkdirSync(ws, { recursive: true });
    const brief = await buildBrief(this.o.ado, bugId, this.o.bugNotes.for(bugId));
    writeFileSync(join(ws, 'BRIEF.md'), brief.markdown);
    this.writeSettings(ws);

    const now = new Date().toISOString();
    let inv: Investigation = { bugId, title: brief.title, sessionId: randomUUID(), status: 'running', startedAt: now, updatedAt: now, reviews: [] };
    const prompt = `Investigate bug ${bugId} (investigation ${inv.sessionId}). Read BRIEF.md in this folder first. The repo knowledge file is ${this.knowledgeFile}. The work repos are under ${this.o.reposRoot}. When done, save the report with save_report.`;
    inv = { ...inv, itermSession: this.launch(inv, 'new', prompt) };
    inv = this.investigations.put(inv);
    await this.syncLabels(bugId, 'running');
    this.o.activity.add({ source: 'investigator', kind: 'start', subject: `Bug ${bugId}`, action: 'created', reason: 'investigation started in iTerm', link: this.o.ado.bugUrl(bugId) });
    return inv;
  }

  /** Brings the open window forward, or resumes the session in a new one. */
  async openTerminal(bugId: number, prompt?: string): Promise<'focused' | 'resumed'> {
    const inv = this.investigations.get(bugId);
    if (!inv) throw new Error(`no investigation for bug ${bugId}`);
    if (inv.itermSession && this.term.sessionAlive(inv.itermSession)) {
      // Same session in two windows would interleave one transcript — reuse the window.
      if (prompt) this.term.type(inv.itermSession, prompt);
      this.term.focus(inv.itermSession);
      return 'focused';
    }
    this.writeSettings(this.workspace(bugId));
    this.investigations.put({ ...inv, itermSession: this.launch(inv, 'resume', prompt) });
    return 'resumed';
  }

  /** The latest report and every review, from todo-brain. */
  report(bugId: number) {
    const report = this.o.reports.get(bugId);
    return { report: report ?? null, reviews: this.o.reports.reviews(bugId) };
  }

  /**
   * Reports written as files by the first version of the Investigator move into
   * todo-brain once, so nothing is lost.
   */
  private importFileReport(inv: Investigation): void {
    const js = join(this.workspace(inv.bugId), 'report.json');
    if (!existsSync(js) || this.o.reports.get(inv.bugId)) return;
    try {
      const j = JSON.parse(readFileSync(js, 'utf8'));
      const body: ReportBody = {
        verdict: j.verdict,
        confidence: j.confidence,
        summary: j.summary ?? '',
        requirement: { covered: j.requirement?.covered ?? 'unclear', note: j.requirement?.note ?? j.requirement?.evidence ?? '' },
        rootCause: j.rootCause ?? '',
        files: (j.files ?? []).map((f: any) => ({ repo: f.repo, path: f.path, lines: f.lines })),
        fix: { approach: j.fix?.approach ?? '', changes: j.fix?.changes ?? [] },
        tests: j.tests ?? [],
        openQuestions: j.openQuestions ?? [],
      };
      this.o.reports.save(inv.bugId, body, inv.sessionId);
    } catch {
      // unreadable: leave it in the folder
    }
  }

  /** Notices new or revised reports; call before showing investigations. */
  async refresh(): Promise<Investigation[]> {
    for (const inv of this.investigations.all()) {
      this.importFileReport(inv);
      const latest = this.o.reports.get(inv.bugId);
      if (!latest || latest.version === inv.reportVersion) continue;
      const fresh = inv.status === 'running' || inv.status === 'changes-requested';
      await this.setStatus(inv, fresh ? 'report-ready' : inv.status, { reportVersion: latest.version, reportAt: latest.createdAt });
      if (fresh) this.o.activity.add({ source: 'investigator', kind: 'report', subject: `Bug ${inv.bugId}`, action: 'annotated', reason: `report v${latest.version} ready for review`, link: this.o.ado.bugUrl(inv.bugId) });
    }
    return this.investigations.all();
  }

  /** Approve, reject, or ask for changes. The review is stored with the report; changes go to the session. */
  async review(bugId: number, decision: Review['decision'], feedback?: string): Promise<Investigation> {
    const inv = this.investigations.get(bugId);
    if (!inv) throw new Error(`no investigation for bug ${bugId}`);
    const text = feedback?.trim();
    if (decision === 'changes' && !text) throw new Error('say what should change');
    const stored = this.o.reports.review(bugId, decision, text || undefined);
    const reviews = [...inv.reviews, { at: stored.createdAt, decision, feedback: text || undefined }];

    if (decision === 'changes') {
      const next = await this.setStatus(inv, 'changes-requested', { reviews });
      await this.openTerminal(
        bugId,
        `The developer reviewed report v${stored.version} and asked for changes. Call get_report for bug ${bugId} to read the feedback, then save_report a revised version.`,
      );
      this.o.activity.add({ source: 'investigator', kind: 'review', subject: `Bug ${bugId}`, action: 'annotated', reason: `changes requested on v${stored.version}: ${text!.slice(0, 100)}` });
      return next;
    }
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const next = await this.setStatus(inv, status, { reviews });
    this.o.activity.add({ source: 'investigator', kind: 'review', subject: `Bug ${bugId}`, action: decision === 'approve' ? 'done' : 'annotated', reason: `report v${stored.version} ${status}${text ? `: ${text.slice(0, 100)}` : ''}` });
    return next;
  }
}
