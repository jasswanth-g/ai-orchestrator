import { describe, expect, test } from 'bun:test';
import { EstimateParseError, formatEstimate, parseEstimate } from '../src/estimate.ts';
import { planDay, rank, scoreTask } from '../src/prioritize.ts';
import type { Item, Priority } from '../src/types.ts';

const TODAY = '2026-10-05';
let seq = 0;
const task = (title: string, priority: Priority, due?: string, estimate?: number): Item => ({
  id: String(++seq),
  bucket: 'work',
  title,
  priority,
  due,
  estimate,
  labels: [],
  source: 'manual',
  createdAt: `2026-10-01T00:00:${String(seq).padStart(2, '0')}Z`,
});

describe('estimates', () => {
  test.each([
    ['30m', 30],
    ['2h', 120],
    ['1h30m', 90],
    ['1.5h', 90],
    ['90', 90],
    ['45 min', 45],
    ['1h 15m', 75],
  ])('%s → %d min', (input, minutes) => {
    expect(parseEstimate(input)).toBe(minutes);
  });

  test.each(['', 'soon', '0m', '-1h', 'h', '200h'])('rejects %p', (input) => {
    expect(() => parseEstimate(input)).toThrow(EstimateParseError);
  });

  test('formats back', () => {
    expect([30, 60, 90, 125].map(formatEstimate)).toEqual(['30m', '1h', '1h30m', '2h5m']);
  });
});

describe('scoreTask', () => {
  test('adds priority, deadline and quick-win points with reasons', () => {
    expect(scoreTask(task('a', 1, '2026-10-06', 20), TODAY)).toMatchObject({
      score: 40 + 30 + 5,
      reasons: ['P1', 'due tomorrow', 'quick (20m)'],
      daysLeft: 1,
    });
    expect(scoreTask(task('b', 3, '2026-10-02'), TODAY)).toMatchObject({ score: 70, reasons: ['P3', 'overdue 3d'] });
    expect(scoreTask(task('c', 4, '2026-10-20T10:00:00'), TODAY)).toMatchObject({
      score: 10,
      reasons: ['P4', 'due 2026-10-20'],
    });
    expect(scoreTask(task('d', 2), TODAY)).toMatchObject({ score: 30, reasons: ['P2'], daysLeft: undefined });
  });

  test('deadline bands', () => {
    const pts = (due: string) => scoreTask(task('x', 4, due), TODAY).score - 10;
    expect([pts('2026-10-05'), pts('2026-10-08'), pts('2026-10-12'), pts('2026-10-13')]).toEqual([40, 20, 10, 0]);
  });
});

describe('rank', () => {
  test('a P3 due today outranks a P1 with no deadline', () => {
    const order = rank([task('p1 someday', 1), task('p3 today', 3, TODAY)], TODAY).map((r) => r.item.title);
    expect(order).toEqual(['p3 today', 'p1 someday']);
  });

  test('ties break by earlier due, then oldest', () => {
    const a = task('later due', 2, '2026-10-07'); // 30 + 20
    const b = task('earlier due', 2, '2026-10-06'); // 30 + 30 → wins outright
    const c = task('old undated', 1); // 40
    const d = task('new undated', 1); // 40
    expect(rank([d, c, a, b], TODAY).map((r) => r.item.title)).toEqual([
      'earlier due',
      'later due',
      'old undated',
      'new undated',
    ]);
  });
});

describe('planDay', () => {
  test('fills capacity by rank and skips what no longer fits', () => {
    const p = planDay(
      [
        task('big P1', 1, undefined, 240), // 40
        task('medium P2', 2, undefined, 180), // 30
        task('small P3', 3, undefined, 60), // 20
      ],
      TODAY,
      360,
    );
    expect(p.plan.map((r) => r.item.title)).toEqual(['big P1', 'small P3']);
    expect(p.didNotFit.map((r) => r.item.title)).toEqual(['medium P2']);
    expect(p).toMatchObject({ plannedMinutes: 300, overCapacity: false, unestimated: 0 });
  });

  test('overdue and due-today always go in, even past capacity', () => {
    const p = planDay([task('overdue', 4, '2026-10-01', 300), task('today', 4, TODAY, 120), task('P1', 1, undefined, 30)], TODAY, 360);
    expect(p.plan.map((r) => [r.item.title, r.mustDo])).toEqual([
      ['overdue', true],
      ['today', true],
    ]);
    expect(p).toMatchObject({ plannedMinutes: 420, overCapacity: true });
    expect(p.didNotFit.map((r) => r.item.title)).toEqual(['P1']);
  });

  test('unestimated tasks count as 1h and are flagged', () => {
    const p = planDay([task('no estimate', 1)], TODAY, 120);
    expect(p.plan[0]).toMatchObject({ minutes: 60, estimateAssumed: true });
    expect(p.unestimated).toBe(1);
  });
});
