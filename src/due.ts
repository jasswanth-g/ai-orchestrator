/**
 * Turns the due phrases people actually type into YYYY-MM-DD.
 * Todoist did this server-side; our own store needs it locally.
 *
 *   2026-10-09 · today · tomorrow · mon…sun / monday…sunday (next occurrence)
 *   next week (next Monday) · in 3 days · in 2 weeks
 */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export class DueParseError extends Error {
  constructor(input: string) {
    super(`Can't read due date "${input}". Use YYYY-MM-DD, today, tomorrow, a weekday, "next week" or "in N days/weeks".`);
  }
}

export function parseDue(input: string, now: Date = new Date()): string {
  const s = input.trim().toLowerCase();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    const date = new Date(y, m - 1, d);
    if (date.getMonth() !== m - 1) throw new DueParseError(input); // 2026-02-31
    return s;
  }
  if (s === 'today') return ymd(now);
  if (s === 'tomorrow') return ymd(addDays(now, 1));
  if (s === 'next week') return ymd(addDays(now, ((8 - now.getDay()) % 7) || 7));

  const rel = /^in (\d+) (day|days|week|weeks)$/.exec(s);
  if (rel) return ymd(addDays(now, Number(rel[1]) * (rel[2]!.startsWith('week') ? 7 : 1)));

  const wd = WEEKDAYS.findIndex((w) => s === w || (s.length > 3 && w === s.slice(0, 3) && /^[a-z]+day$/.test(s)));
  if (wd !== -1) return ymd(addDays(now, ((wd - now.getDay() + 7) % 7) || 7));

  throw new DueParseError(input);
}
