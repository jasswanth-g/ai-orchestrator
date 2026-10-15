import { z } from 'zod';
import { CONFIDENCE, COVERED, type ReportsDb, VERDICTS } from '../store/reports.ts';
import { defineTool, type ToolContext } from './define.ts';

/**
 * Investigation reports: the Investigator saves them here (each save is a new
 * version tagged to the bug and its investigation), the developer reviews them
 * on the agents dashboard, and any Claude session can read them back.
 *
 * The limits are the point: a report is a decision aid, not a dump of context.
 */

const short = (max: number, what: string) => z.string().trim().min(1).max(max).describe(`${what} (max ${max} characters)`);

export const reportInput = {
  bugId: z.number().int().positive().describe('Azure DevOps bug id'),
  investigationId: z.string().optional().describe('Investigation (Claude Code session) id, if known'),
  verdict: z.enum(VERDICTS),
  confidence: z.enum(CONFIDENCE),
  summary: short(400, 'What is wrong and what to do, in 2-3 plain sentences'),
  requirement: z.object({
    covered: z.enum(COVERED).describe('Is the expected behaviour in the Story / acceptance criteria?'),
    note: short(250, 'The deciding line from the requirement, or why it is unclear'),
  }),
  rootCause: short(500, 'The condition that produces the wrong result, and where'),
  files: z
    .array(z.object({ repo: z.string().min(1), path: z.string().min(1), lines: z.string().optional() }))
    .max(6)
    .describe('Only the files the fix touches or that prove the cause (max 6)'),
  fix: z.object({
    approach: short(300, 'The change in 1-2 sentences'),
    changes: z
      .array(
        z.object({
          repo: z.string().min(1),
          path: z.string().min(1),
          before: short(800, 'Current code or behaviour, just the relevant lines'),
          after: short(800, 'New code or behaviour'),
        }),
      )
      .max(5),
  }),
  tests: z.array(short(160, 'One check')).max(4).describe('How to verify the fix (max 4)'),
  openQuestions: z.array(short(200, 'One question')).max(4).default([]).describe('Only questions that block or change the fix (max 4)'),
};

const reportsOf = (ctx: ToolContext): ReportsDb => {
  if (!ctx.reports) throw new Error('reports are not available in this store setup');
  return ctx.reports;
};

export const reportTools = [
  defineTool({
    name: 'save_report',
    description:
      'Save an investigation report for an Azure DevOps bug. Each call adds a new version (earlier versions are kept). ' +
      'Be concise: only what the developer needs to decide and act — no restated bug text, no exploration log.',
    input: reportInput,
    async run(ctx, a) {
      const { bugId, investigationId, ...body } = a;
      const saved = reportsOf(ctx).save(bugId, body, investigationId);
      return { bugId, version: saved.version, saved: true };
    },
  }),
  defineTool({
    name: 'get_report',
    description: 'Read the latest (or a given) version of a bug\'s investigation report, with the developer\'s reviews and feedback.',
    input: {
      bugId: z.number().int().positive(),
      version: z.number().int().positive().optional(),
    },
    async run(ctx, a) {
      const db = reportsOf(ctx);
      const report = db.get(a.bugId, a.version);
      if (!report) return { bugId: a.bugId, report: null };
      return { report, reviews: db.reviews(a.bugId) };
    },
  }),
  defineTool({
    name: 'list_reports',
    description: 'List investigation reports (latest version of each), newest first, optionally for one bug.',
    input: { bugId: z.number().int().positive().optional() },
    async run(ctx, a) {
      return reportsOf(ctx).list(a.bugId);
    },
  }),
];
