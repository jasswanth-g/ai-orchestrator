import { expect, test } from 'bun:test';
import { z } from 'zod';
import { ReportsDb } from '../src/store/reports.ts';
import { InMemoryStore } from '../src/store/in-memory.ts';
import { reportInput, reportTools } from '../src/tools/reports.ts';

const valid = {
  bugId: 7,
  verdict: 'bug',
  confidence: 'high',
  summary: 'Total ignores the scheme discount.',
  requirement: { covered: 'yes', note: 'AC-2: discount applies' },
  rootCause: 'cart.ts skips schemes when qty > 10',
  files: [{ repo: 'r', path: 'cart.ts', lines: '40-52' }],
  fix: { approach: 'Apply schemes for all quantities', changes: [{ repo: 'r', path: 'cart.ts', before: 'if (qty <= 10)', after: 'always' }] },
  tests: ['qty 12 gets discount'],
};

const call = async (name: string, args: unknown, reports: ReportsDb) => {
  const tool = reportTools.find((t) => t.name === name)!;
  return tool.run({ store: new InMemoryStore(), today: () => '2026-10-15', exists: () => false, reports }, z.object(tool.input).parse(args) as never);
};

test('save_report versions per bug; get_report returns the latest with reviews', async () => {
  const db = new ReportsDb(':memory:');
  expect(await call('save_report', { ...valid, investigationId: 'sess-1' }, db)).toEqual({ bugId: 7, version: 1, saved: true });
  expect(await call('save_report', { ...valid, confidence: 'medium' }, db)).toMatchObject({ version: 2 });
  db.review(7, 'changes', 'cover qty 0');
  const got = (await call('get_report', { bugId: 7 }, db)) as any;
  expect(got.report).toMatchObject({ version: 2, confidence: 'medium', openQuestions: [] });
  expect(got.reviews).toMatchObject([{ version: 2, decision: 'changes', feedback: 'cover qty 0' }]);
  expect(((await call('get_report', { bugId: 7, version: 1 }, db)) as any).report.investigationId).toBe('sess-1');
  expect(await call('list_reports', {}, db)).toMatchObject([{ bugId: 7, version: 2 }]);
  expect(await call('get_report', { bugId: 99 }, db)).toEqual({ bugId: 99, report: null });
});

test('limits keep reports short', () => {
  const schema = z.object(reportInput);
  expect(schema.safeParse(valid).success).toBe(true);
  expect(schema.safeParse({ ...valid, summary: 'x'.repeat(401) }).success).toBe(false);
  expect(schema.safeParse({ ...valid, files: Array(7).fill(valid.files[0]) }).success).toBe(false);
  expect(schema.safeParse({ ...valid, tests: Array(5).fill('t') }).success).toBe(false);
  expect(schema.safeParse({ ...valid, verdict: 'maybe' }).success).toBe(false);
});
