import { describe, expect, test } from 'bun:test';
import { DueParseError, parseDue } from '../src/due.ts';

// Thursday 2026-10-01, local time.
const now = new Date(2026, 9, 1, 15, 0);

describe('parseDue', () => {
  test.each([
    ['2026-10-09', '2026-10-09'],
    ['today', '2026-10-01'],
    ['Tomorrow', '2026-10-02'],
    ['fri', '2026-10-02'],
    ['friday', '2026-10-02'],
    ['thu', '2026-10-08'], // same weekday → next week, never today
    ['mon', '2026-10-05'],
    ['next week', '2026-10-05'],
    ['in 3 days', '2026-10-04'],
    ['in 2 weeks', '2026-10-15'],
    ['in 1 day', '2026-10-02'],
  ])('%s → %s', (input, expected) => {
    expect(parseDue(input, now)).toBe(expected);
  });

  test('crosses month and year ends', () => {
    expect(parseDue('tomorrow', new Date(2026, 11, 31))).toBe('2027-01-01');
  });

  test.each(['someday', '2026-02-31', 'fri 5pm', 'frday'])('rejects %s', (input) => {
    expect(() => parseDue(input, now)).toThrow(DueParseError);
  });
});
