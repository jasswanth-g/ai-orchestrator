import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Investigation reports, versioned, with the developer's reviews. Lives in the
 * same SQLite file as the items (one file to back up) but in its own tables, so
 * it doesn't depend on which item store (SQLite or Todoist) is in use.
 *
 * A report belongs to a bug (`bugId`) and to the investigation that wrote it
 * (`investigationId`, the Claude Code session id). Every save is a new version;
 * nothing is overwritten.
 */

export const VERDICTS = ['bug', 'works-as-designed', 'requirement-gap', 'cannot-reproduce', 'needs-info'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const CONFIDENCE = ['high', 'medium', 'low'] as const;
export const COVERED = ['yes', 'no', 'unclear'] as const;
export const DECISIONS = ['approve', 'reject', 'changes', 'discard'] as const;
export type Decision = (typeof DECISIONS)[number];

/** What the Investigator writes. Kept deliberately short — limits are enforced by save_report. */
export interface ReportBody {
  verdict: Verdict;
  confidence: (typeof CONFIDENCE)[number];
  summary: string;
  requirement: { covered: (typeof COVERED)[number]; note: string };
  rootCause: string;
  files: Array<{ repo: string; path: string; lines?: string }>;
  fix: { approach: string; changes: Array<{ repo: string; path: string; before: string; after: string }> };
  tests: string[];
  openQuestions: string[];
}

export interface Report extends ReportBody {
  id: number;
  bugId: number;
  investigationId?: string;
  version: number;
  createdAt: string;
}

export interface ReportReview {
  id: number;
  bugId: number;
  /** The version reviewed. */
  version: number;
  decision: Decision;
  feedback?: string;
  createdAt: string;
}

/** What the Developer agent reports after implementing an approved fix. Kept short, like reports. */
export interface DevResultBody {
  summary: string;
  changes: Array<{ repo: string; files: string[] }>;
  tests: Array<{ command: string; result: 'passed' | 'failed' | 'not-run'; note?: string }>;
  notes: string[];
}

export interface DevResult extends DevResultBody {
  id: number;
  bugId: number;
  sessionId?: string;
  version: number;
  createdAt: string;
}

interface DevRow {
  id: number;
  bug_id: number;
  session_id: string | null;
  version: number;
  body: string;
  created_at: string;
}

interface ReportRow {
  id: number;
  bug_id: number;
  investigation_id: string | null;
  version: number;
  body: string;
  created_at: string;
}

interface ReviewRow {
  id: number;
  bug_id: number;
  version: number;
  decision: Decision;
  feedback: string | null;
  created_at: string;
}

export class ReportsDb {
  private readonly db: Database;

  constructor(path: string, private readonly now: () => Date = () => new Date()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run(`CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bug_id INTEGER NOT NULL,
      investigation_id TEXT,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (bug_id, version)
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS dev_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bug_id INTEGER NOT NULL,
      session_id TEXT,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (bug_id, version)
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS dev_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bug_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      decision TEXT NOT NULL,
      feedback TEXT,
      created_at TEXT NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS report_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bug_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      decision TEXT NOT NULL,
      feedback TEXT,
      created_at TEXT NOT NULL
    )`);
  }

  private toReport(r: ReportRow): Report {
    return { ...(JSON.parse(r.body) as ReportBody), id: r.id, bugId: r.bug_id, investigationId: r.investigation_id ?? undefined, version: r.version, createdAt: r.created_at };
  }

  private toReview(r: ReviewRow): ReportReview {
    return { id: r.id, bugId: r.bug_id, version: r.version, decision: r.decision, feedback: r.feedback ?? undefined, createdAt: r.created_at };
  }

  /** Saves a new version for the bug. */
  save(bugId: number, body: ReportBody, investigationId?: string): Report {
    const tx = this.db.transaction(() => {
      const last = this.db.query<{ v: number | null }, { bug: number }>('SELECT MAX(version) AS v FROM reports WHERE bug_id = $bug').get({ bug: bugId });
      return this.db
        .query<ReportRow, Record<string, string | number | null>>(
          `INSERT INTO reports (bug_id, investigation_id, version, body, created_at)
           VALUES ($bug, $inv, $version, $body, $at) RETURNING *`,
        )
        .get({ bug: bugId, inv: investigationId ?? null, version: (last?.v ?? 0) + 1, body: JSON.stringify(body), at: this.now().toISOString() })!;
    });
    return this.toReport(tx());
  }

  /** Latest version, or a specific one. */
  get(bugId: number, version?: number): Report | undefined {
    const row = version
      ? this.db.query<ReportRow, { bug: number; v: number }>('SELECT * FROM reports WHERE bug_id = $bug AND version = $v').get({ bug: bugId, v: version })
      : this.db.query<ReportRow, { bug: number }>('SELECT * FROM reports WHERE bug_id = $bug ORDER BY version DESC LIMIT 1').get({ bug: bugId });
    return row ? this.toReport(row) : undefined;
  }

  /** Latest version of every report (or of one bug's), newest first. */
  list(bugId?: number): Array<Pick<Report, 'bugId' | 'version' | 'verdict' | 'confidence' | 'summary' | 'createdAt' | 'investigationId'>> {
    const rows = this.db
      .query<ReportRow, Record<string, number>>(
        `SELECT r.* FROM reports r
         JOIN (SELECT bug_id, MAX(version) AS v FROM reports GROUP BY bug_id) m ON m.bug_id = r.bug_id AND m.v = r.version
         ${bugId ? 'WHERE r.bug_id = $bug' : ''} ORDER BY r.created_at DESC`,
      )
      .all(bugId ? { bug: bugId } : {});
    return rows.map((r) => {
      const { bugId: b, version, verdict, confidence, summary, createdAt, investigationId } = this.toReport(r);
      return { bugId: b, version, verdict, confidence, summary, createdAt, investigationId };
    });
  }

  review(bugId: number, decision: Decision, feedback?: string): ReportReview {
    const latest = this.get(bugId);
    if (!latest) throw new Error(`no report for bug ${bugId}`);
    const row = this.db
      .query<ReviewRow, Record<string, string | number | null>>(
        'INSERT INTO report_reviews (bug_id, version, decision, feedback, created_at) VALUES ($bug, $v, $d, $f, $at) RETURNING *',
      )
      .get({ bug: bugId, v: latest.version, d: decision, f: feedback ?? null, at: this.now().toISOString() })!;
    return this.toReview(row);
  }

  reviews(bugId: number): ReportReview[] {
    return this.db
      .query<ReviewRow, { bug: number }>('SELECT * FROM report_reviews WHERE bug_id = $bug ORDER BY id')
      .all({ bug: bugId })
      .map((r) => this.toReview(r));
  }

  // ── Developer results ────────────────────────────────────────────────

  saveDevResult(bugId: number, body: DevResultBody, sessionId?: string): DevResult {
    const tx = this.db.transaction(() => {
      const last = this.db.query<{ v: number | null }, { bug: number }>('SELECT MAX(version) AS v FROM dev_results WHERE bug_id = $bug').get({ bug: bugId });
      return this.db
        .query<DevRow, Record<string, string | number | null>>(
          'INSERT INTO dev_results (bug_id, session_id, version, body, created_at) VALUES ($bug, $s, $v, $body, $at) RETURNING *',
        )
        .get({ bug: bugId, s: sessionId ?? null, v: (last?.v ?? 0) + 1, body: JSON.stringify(body), at: this.now().toISOString() })!;
    });
    return this.toDev(tx());
  }

  devResult(bugId: number): DevResult | undefined {
    const row = this.db.query<DevRow, { bug: number }>('SELECT * FROM dev_results WHERE bug_id = $bug ORDER BY version DESC LIMIT 1').get({ bug: bugId });
    return row ? this.toDev(row) : undefined;
  }

  devReview(bugId: number, decision: 'approve' | 'changes' | 'discard', feedback?: string): ReportReview {
    const version = this.devResult(bugId)?.version ?? 0;
    const row = this.db
      .query<ReviewRow, Record<string, string | number | null>>(
        'INSERT INTO dev_reviews (bug_id, version, decision, feedback, created_at) VALUES ($bug, $v, $d, $f, $at) RETURNING *',
      )
      .get({ bug: bugId, v: version, d: decision, f: feedback ?? null, at: this.now().toISOString() })!;
    return this.toReview(row);
  }

  devReviews(bugId: number): ReportReview[] {
    return this.db
      .query<ReviewRow, { bug: number }>('SELECT * FROM dev_reviews WHERE bug_id = $bug ORDER BY id')
      .all({ bug: bugId })
      .map((r) => this.toReview(r));
  }

  private toDev(r: DevRow): DevResult {
    return { ...(JSON.parse(r.body) as DevResultBody), id: r.id, bugId: r.bug_id, sessionId: r.session_id ?? undefined, version: r.version, createdAt: r.created_at };
  }

  close(): void {
    this.db.close();
  }
}
