import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AdoClient } from '../ado/client.ts';
import { planTransition } from '../ado/transitions.ts';
import type { BugNotes } from '../agents-settings.ts';
import type { ActivityLog } from '../events/activity.ts';
import { type Terminal, rulePath, sh, TODO_BRAIN_ENTRY } from '../investigator/service.ts';
import * as iterm from '../investigator/iterm.ts';
import { workRepos } from '../investigator/repos.ts';
import type { Investigations } from '../investigator/state.ts';
import type { Report, ReportsDb } from '../store/reports.ts';
import type { Store } from '../store/store.ts';

/**
 * The Developer: implements an approved Investigator report in its own iTerm
 * Claude Code session. Each repo the fix touches gets a git worktree on
 * `fix/bug-<id>`, branched from the commit the developer's checkout is on, so
 * their checkout and its uncommitted work are never touched. Nothing is
 * committed: on approve the changes stay in the worktree for the developer.
 *
 * Safety: edits only inside the worktrees (the original checkouts are denied);
 * no commit / push / checkout / reset / rebase / merge / stash / clean /
 * worktree / branch deletion; no web; MCP limited to the report + dev-result
 * tools. Anything else not on the allow list asks the developer in the terminal.
 */

export type DevStatus = 'running' | 'ready-for-review' | 'changes-requested' | 'approved' | 'discarded';

export interface Worktree {
  repo: string;
  /** The developer's checkout. */
  source: string;
  /** Where the Developer edits. */
  path: string;
  branch: string;
  /** Branch the checkout was on (or "detached"), and its commit. */
  base: string;
  baseSha: string;
  /** The checkout had uncommitted changes, which the worktree doesn't include. */
  sourceDirty: boolean;
}

export interface DevSession {
  bugId: number;
  title: string;
  sessionId: string;
  itermSession?: string;
  status: DevStatus;
  startedAt: string;
  updatedAt: string;
  resultVersion?: number;
  worktrees: Worktree[];
  /** What the start did in Azure DevOps (e.g. "Bug 21524 → Active"), or why it didn't. */
  ado?: string;
}

const STATUS_LABELS: Record<DevStatus, string | undefined> = {
  running: 'in-development',
  'ready-for-review': 'dev-review',
  'changes-requested': 'in-development',
  approved: 'dev-approved',
  discarded: undefined,
};
const FLOW_LABELS = ['in-development', 'dev-review', 'dev-approved'];
const PROMPT_FILE = new URL('../../prompts/developer.md', import.meta.url).pathname;
const MCP_NAME = 'reports';
const TOOL_NAMES = ['get_report', 'get_dev_result', 'save_dev_result'];
const MAX_DIFF = 200_000;

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stderr: 'pipe' });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString().trim() };
}

class Sessions {
  private items: Record<string, DevSession>;
  constructor(private readonly file: string) {
    this.items = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  }
  get(bugId: number) {
    return this.items[bugId];
  }
  all() {
    return Object.values(this.items).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  put(s: DevSession): DevSession {
    this.items[s.bugId] = { ...s, updatedAt: new Date().toISOString() };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.items, null, 2));
    return this.items[s.bugId]!;
  }
}

export class Developer {
  readonly sessions: Sessions;
  private readonly root: string;
  private readonly term: Terminal;

  constructor(
    private readonly o: {
      stateDir: string;
      reposRoot: string;
      repoRemote: string;
      store: Store;
      reports: ReportsDb;
      reportsPath: string;
      investigations: Investigations;
      bugNotes: BugNotes;
      activity: ActivityLog;
      ado?: AdoClient;
      /** Where the Investigator keeps REPOS.md — readable reference. */
      knowledgeDir: string;
      terminal?: Terminal;
    },
  ) {
    this.root = join(o.stateDir, 'developer');
    this.sessions = new Sessions(join(this.root, 'sessions.json'));
    this.term = o.terminal ?? iterm;
  }

  folder = (bugId: number) => join(this.root, `bug-${bugId}`);

  /** Repos the approved report's fix touches, that are known work repos. */
  private reposFor(report: Report): string[] {
    const names = new Set([...report.fix.changes.map((c) => c.repo), ...report.files.map((f) => f.repo)]);
    const known = new Set(workRepos(this.o.reposRoot, this.o.repoRemote).map((r) => r.name));
    return [...names].filter((n) => known.has(n));
  }

  private makeWorktree(bugId: number, repo: string): Worktree {
    const source = join(this.o.reposRoot, repo);
    const path = join(this.folder(bugId), repo);
    const branch = `fix/bug-${bugId}`;
    const base = git(source, ['branch', '--show-current']).out.trim() || 'detached';
    const baseSha = git(source, ['rev-parse', 'HEAD']).out.trim();
    const sourceDirty = git(source, ['status', '--porcelain']).out.trim().length > 0;
    if (!existsSync(path)) {
      const exists = git(source, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
      const add = exists ? git(source, ['worktree', 'add', path, branch]) : git(source, ['worktree', 'add', '-b', branch, path, baseSha]);
      if (!add.ok) throw new Error(`${repo}: could not create the worktree — ${add.err}`);
    }
    return { repo, source, path, branch, base, baseSha, sourceDirty };
  }

  private brief(bugId: number, report: Report, worktrees: Worktree[]): string {
    const reviews = this.o.reports.reviews(bugId).filter((r) => r.feedback);
    const notes = this.o.bugNotes.for(bugId);
    const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '_none_');
    return `# Implement the approved fix for bug ${bugId}

## Approved report (v${report.version})

**Verdict:** ${report.verdict} · **Confidence:** ${report.confidence}

${report.summary}

**Requirement:** ${report.requirement.note}

**Root cause:** ${report.rootCause}

**Fix:** ${report.fix.approach}

${report.fix.changes.map((c) => `### ${c.repo}/${c.path}\n\nBefore:\n\n\`\`\`\n${c.before}\n\`\`\`\n\nAfter:\n\n\`\`\`\n${c.after}\n\`\`\``).join('\n\n')}

**Files involved:** ${report.files.map((f) => `\`${f.repo}/${f.path}${f.lines ? `:${f.lines}` : ''}\``).join(', ') || '_none listed_'}

**Checks to run:**
${list(report.tests)}

**Open questions from the report:**
${list(report.openQuestions)}

## The developer's review notes and comments

${list([...reviews.map((r) => `${r.decision} (v${r.version}): ${r.feedback}`), ...notes.map((n) => `${n.type}: ${n.text}`)])}

## Your worktrees (edit only these)

| Repo | Worktree (this folder) | Branch | From |
|---|---|---|---|
${worktrees.map((w) => `| ${w.repo} | \`./${w.repo}\` | \`${w.branch}\` | \`${w.base}\` @ ${w.baseSha.slice(0, 8)}${w.sourceDirty ? ' — the developer has uncommitted changes there that are **not** in your worktree' : ''} |`).join('\n')}
`;
  }

  private writeSettings(folder: string, worktrees: Worktree[]): void {
    // Only test / type-check / lint run without asking. `npm run …` (scripts can deploy)
    // and installs (dependency install scripts) ask the developer in the terminal.
    const pkg = ['npm test', 'npx tsc', 'npx jest', 'npx vitest', 'npx eslint', 'bun test', 'bunx tsc', 'pnpm test', 'yarn test'];
    const gitRead = ['status', 'diff', 'log', 'show', 'blame', 'grep', 'ls-files'];
    const gitDeny = ['commit', 'push', 'checkout', 'switch', 'reset', 'rebase', 'merge', 'stash', 'clean', 'worktree', 'branch -D', 'branch -d', 'restore --source', 'cherry-pick', 'revert', 'tag', 'remote', 'config', 'update-ref', 'filter-branch'];
    const settings = {
      disableAllHooks: true,
      permissions: {
        // Not dontAsk: the developer watches this terminal and can approve a
        // command that isn't listed (e.g. a repo-specific script).
        defaultMode: 'default',
        allow: [
          `Read(${rulePath(this.o.reposRoot)}/**)`,
          `Read(${rulePath(folder)}/**)`,
          `Read(${rulePath(this.o.knowledgeDir)}/**)`,
          ...worktrees.map((w) => `Edit(${rulePath(w.path)}/**)`),
          'Grep',
          'Glob',
          'Bash(cd *)',
          'Bash(ls *)',
          ...gitRead.map((c) => `Bash(git ${c} *)`),
          ...pkg.map((c) => `Bash(${c} *)`),
          ...TOOL_NAMES.map((t) => `mcp__${MCP_NAME}__${t}`),
        ],
        deny: [
          `Edit(${rulePath(this.o.reposRoot)}/**)`,
          `Edit(${rulePath(folder)}/DEV-BRIEF.md)`,
          `Edit(${rulePath(folder)}/settings.json)`,
          `Edit(${rulePath(folder)}/mcp.json)`,
          ...gitDeny.flatMap((c) => [`Bash(git ${c} *)`, `Bash(git ${c})`]),
          'Bash(git * --output*)',
          'Bash(rm -rf *)',
          'WebFetch',
          'WebSearch',
        ],
      },
    };
    writeFileSync(join(folder, 'settings.json'), JSON.stringify(settings, null, 2));
    const mcp = { mcpServers: { [MCP_NAME]: { command: process.execPath, args: ['run', TODO_BRAIN_ENTRY], env: { TODO_BRAIN_DB: this.o.reportsPath, TODO_BRAIN_ONLY: TOOL_NAMES.join(',') } } } };
    writeFileSync(join(folder, 'mcp.json'), JSON.stringify(mcp, null, 2));
  }

  private command(folder: string, s: DevSession, mode: 'new' | 'resume', prompt?: string): string {
    const flags = [
      mode === 'new' ? `--session-id ${s.sessionId}` : `--resume ${s.sessionId}`,
      `--name ${sh(`Dev bug ${s.bugId}`)}`,
      `--settings ${sh(join(folder, 'settings.json'))}`,
      `--append-system-prompt-file ${sh(PROMPT_FILE)}`,
      `--strict-mcp-config --mcp-config ${sh(join(folder, 'mcp.json'))}`,
      `--add-dir ${sh(this.o.reposRoot)} ${sh(this.o.knowledgeDir)}`,
    ];
    return `cd ${sh(folder)} && claude ${prompt ? `${sh(prompt)} ` : ''}${flags.join(' ')}`;
  }

  private launch(s: DevSession, mode: 'new' | 'resume', prompt?: string): string {
    const folder = this.folder(s.bugId);
    const script = join(folder, mode === 'new' ? 'run.sh' : 'resume.sh');
    writeFileSync(script, `#!/bin/zsh\n# Developer — bug ${s.bugId}: ${s.title.replace(/\n/g, ' ')}\n${this.command(folder, s, mode, prompt)}\n`);
    chmodSync(script, 0o755);
    return this.term.openWindow(`clear; ${sh(script)}`);
  }

  private async syncLabels(bugId: number, status: DevStatus): Promise<void> {
    const task = (await this.o.store.list('work')).find((t) => t.labels.includes(`ado-${bugId}`));
    if (!task) return;
    const next = STATUS_LABELS[status];
    await this.o.store.update(task.id, { labels: [...task.labels.filter((l) => !FLOW_LABELS.includes(l)), ...(next ? [next] : [])] });
  }

  /** "Developer starts" in Azure DevOps (Bug/Task → Active, Story/Issue → In Development). Never blocks the start. */
  private async adoStart(bugId: number): Promise<string> {
    if (!this.o.ado) return 'Azure DevOps not connected — state unchanged';
    try {
      const item = await this.o.ado.workItem(bugId);
      const type = item.fields['System.WorkItemType'];
      const plan = planTransition('start', { type, fields: item.fields });
      if (!plan) return `${type} ${bugId}: no start state for this type`;
      if (plan.ops.find((p) => p.path === '/fields/System.State')?.value === item.fields['System.State']) return `${type} ${bugId} already ${plan.label}`;
      await this.o.ado.updateWorkItem(bugId, plan.ops);
      return `${type} ${bugId} → ${plan.label}`;
    } catch (err) {
      return `Azure DevOps refused the start state: ${err instanceof Error ? err.message.replace(/^ADO \S+ \S+ → /, '') : err}`;
    }
  }

  /** Starts development of an approved report, or brings its terminal back. */
  async start(bugId: number): Promise<DevSession> {
    const existing = this.sessions.get(bugId);
    if (existing && existing.status !== 'discarded') {
      await this.openTerminal(bugId);
      return this.sessions.get(bugId)!;
    }
    const inv = this.o.investigations.get(bugId);
    const report = this.o.reports.get(bugId);
    if (!report || inv?.status !== 'approved') throw new Error(`bug ${bugId} has no approved report — approve the Investigator's report first`);
    const repos = this.reposFor(report);
    if (!repos.length) throw new Error(`the report for bug ${bugId} names no known work repo`);

    const folder = this.folder(bugId);
    mkdirSync(folder, { recursive: true });
    const worktrees = repos.map((r) => this.makeWorktree(bugId, r));
    writeFileSync(join(folder, 'DEV-BRIEF.md'), this.brief(bugId, report, worktrees));
    this.writeSettings(folder, worktrees);

    const now = new Date().toISOString();
    let s: DevSession = { bugId, title: inv.title, sessionId: randomUUID(), status: 'running', startedAt: now, updatedAt: now, worktrees };
    s.ado = await this.adoStart(bugId);
    const prompt = `Implement the approved fix for bug ${bugId} (session ${s.sessionId}). Read DEV-BRIEF.md in this folder first; your worktrees are the subfolders ${worktrees.map((w) => w.repo).join(', ')}. When done and tested, save the result with save_dev_result.`;
    s = this.sessions.put({ ...s, itermSession: this.launch(s, 'new', prompt) });
    await this.syncLabels(bugId, 'running');
    this.o.activity.add({ source: 'developer', kind: 'start', subject: `Bug ${bugId}`, action: 'created', reason: `development started in iTerm · ${s.ado}`, link: this.o.ado?.bugUrl(bugId) });
    return s;
  }

  async openTerminal(bugId: number, prompt?: string): Promise<'focused' | 'resumed'> {
    const s = this.sessions.get(bugId);
    if (!s) throw new Error(`no development session for bug ${bugId}`);
    if (s.itermSession && this.term.sessionAlive(s.itermSession)) {
      if (prompt) this.term.type(s.itermSession, prompt);
      this.term.focus(s.itermSession);
      return 'focused';
    }
    this.writeSettings(this.folder(bugId), s.worktrees);
    this.sessions.put({ ...s, itermSession: this.launch(s, 'resume', prompt) });
    return 'resumed';
  }

  /** Notices new dev results; call before showing sessions. */
  async refresh(): Promise<DevSession[]> {
    for (const s of this.sessions.all()) {
      const latest = this.o.reports.devResult(s.bugId);
      if (!latest || latest.version === s.resultVersion) continue;
      const fresh = s.status === 'running' || s.status === 'changes-requested';
      this.sessions.put({ ...s, status: fresh ? 'ready-for-review' : s.status, resultVersion: latest.version });
      if (fresh) {
        await this.syncLabels(s.bugId, 'ready-for-review');
        this.o.activity.add({ source: 'developer', kind: 'result', subject: `Bug ${s.bugId}`, action: 'annotated', reason: `changes v${latest.version} ready for review` });
      }
    }
    return this.sessions.all();
  }

  /** The dev result, reviews, and the actual uncommitted diff per worktree. */
  changes(bugId: number) {
    const s = this.sessions.get(bugId);
    const diffs = (s?.worktrees ?? []).map((w) => {
      if (!existsSync(w.path)) return { repo: w.repo, path: w.path, branch: w.branch, base: w.base, missing: true, status: '', diff: '' };
      const status = git(w.path, ['status', '--porcelain']).out;
      let diff = git(w.path, ['diff', w.baseSha]).out;
      for (const line of status.split('\n').filter((l) => l.startsWith('?? '))) {
        const file = line.slice(3);
        diff += git(w.path, ['diff', '--no-index', '/dev/null', file]).out;
      }
      return { repo: w.repo, path: w.path, branch: w.branch, base: w.base, sourceDirty: w.sourceDirty, status, diff: diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff truncated)` : diff };
    });
    return { session: s ?? null, result: this.o.reports.devResult(bugId) ?? null, reviews: this.o.reports.devReviews(bugId), diffs };
  }

  /** approve: keep the changes in the worktree (nothing committed). changes: back to the session. discard: remove worktrees and branch. */
  async review(bugId: number, decision: 'approve' | 'changes' | 'discard', feedback?: string): Promise<DevSession> {
    const s = this.sessions.get(bugId);
    if (!s) throw new Error(`no development session for bug ${bugId}`);
    const text = feedback?.trim();
    if (decision === 'changes' && !text) throw new Error('say what should change');
    if (decision !== 'discard' && !this.o.reports.devResult(bugId)) throw new Error('the Developer has not saved a result yet');
    this.o.reports.devReview(bugId, decision, text || undefined);

    if (decision === 'changes') {
      const next = this.sessions.put({ ...s, status: 'changes-requested' });
      await this.syncLabels(bugId, 'changes-requested');
      await this.openTerminal(bugId, `The developer reviewed your changes and asked for more. Call get_dev_result for bug ${bugId} to read the feedback, make the changes, re-run the checks and save_dev_result again.`);
      this.o.activity.add({ source: 'developer', kind: 'review', subject: `Bug ${bugId}`, action: 'annotated', reason: `changes requested: ${text!.slice(0, 100)}` });
      return next;
    }
    if (decision === 'discard') {
      for (const w of s.worktrees) {
        git(w.source, ['worktree', 'remove', '--force', w.path]);
        git(w.source, ['branch', '-D', w.branch]);
      }
      const next = this.sessions.put({ ...s, status: 'discarded' });
      await this.syncLabels(bugId, 'discarded');
      this.o.activity.add({ source: 'developer', kind: 'review', subject: `Bug ${bugId}`, action: 'done', reason: 'changes discarded; worktrees and fix branch removed' });
      return next;
    }
    const next = this.sessions.put({ ...s, status: 'approved' });
    await this.syncLabels(bugId, 'approved');
    this.o.activity.add({ source: 'developer', kind: 'review', subject: `Bug ${bugId}`, action: 'done', reason: `changes approved — kept uncommitted in ${s.worktrees.map((w) => `${w.repo} (${w.branch})`).join(', ')}` });
    return next;
  }
}
