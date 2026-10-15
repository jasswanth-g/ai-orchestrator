import { expect, test } from 'bun:test';
import { parseQuickAdd } from '../src/dashboard/quick-add.ts';

const now = new Date(2026, 9, 15); // Thu 15 Oct 2026

test('pulls priority, due, estimate and labels out of the title', () => {
  expect(parseQuickAdd('Reply to Moris p2 tomorrow 30m #hul #P2P', now)).toEqual({
    title: 'Reply to Moris',
    priority: 2,
    due: '2026-10-16',
    estimate: 30,
    labels: ['hul', 'p2p'],
  });
});

test('understands multi-word due phrases and long estimates', () => {
  expect(parseQuickAdd('Load test next week 1h30m', now)).toMatchObject({ title: 'Load test', due: '2026-10-19', estimate: 90 });
  expect(parseQuickAdd('Ping Rahul in 3 days', now)).toMatchObject({ title: 'Ping Rahul', due: '2026-10-18' });
  expect(parseQuickAdd('Deploy fri 2h', now)).toMatchObject({ title: 'Deploy', due: '2026-10-16', estimate: 120 });
  expect(parseQuickAdd('Release 2026-10-20', now)).toMatchObject({ title: 'Release', due: '2026-10-20' });
});

test('leaves plain words and numbers in the title', () => {
  expect(parseQuickAdd('Check 13 questions in section 8', now)).toEqual({
    title: 'Check 13 questions in section 8',
    priority: undefined,
    due: undefined,
    estimate: undefined,
    labels: undefined,
  });
});

test('rejects a line with no title', () => {
  expect(() => parseQuickAdd('p1 today #hul', now)).toThrow(/title/);
});
