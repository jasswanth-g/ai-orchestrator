import { parseDue } from '../due.ts';
import { parseEstimate } from '../estimate.ts';
import { toLabel } from '../tools/define.ts';
import type { NewItem, Priority } from '../types.ts';

/**
 * One-line task entry for the dashboard:
 *
 *   "Reply to Moris p2 tomorrow 30m #hul #p2p"
 *   → { title: 'Reply to Moris', priority: 2, due: <tomorrow>, estimate: 30, labels: ['hul', 'p2p'] }
 *
 * Recognised anywhere in the line: p1–p4, #label, an estimate (30m, 2h, 1h30m,
 * 1.5h) and a due phrase parseDue understands (today, fri, next week, in 3 days,
 * 2026-10-20). Everything else is the title.
 */
export function parseQuickAdd(text: string, now: Date = new Date()): NewItem {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const title: string[] = [];
  const labels: string[] = [];
  let priority: Priority | undefined;
  let due: string | undefined;
  let estimate: number | undefined;

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const lower = w.toLowerCase();
    const next = words[i + 1]?.toLowerCase();

    if (/^p[1-4]$/.test(lower)) {
      priority = Number(lower[1]) as Priority;
    } else if (/^#[^#\s]+$/.test(w) && toLabel(w.slice(1))) {
      labels.push(toLabel(w.slice(1)));
    } else if (/^(\d+(\.\d+)?h(\d+m)?|\d+m(in)?)$/.test(lower)) {
      estimate = parseEstimate(lower);
    } else if (lower === 'next' && next === 'week') {
      due = parseDue('next week', now);
      i++;
    } else if (lower === 'in' && /^\d+$/.test(next ?? '') && /^(day|days|week|weeks)$/.test(words[i + 2]?.toLowerCase() ?? '')) {
      due = parseDue(`in ${next} ${words[i + 2]}`, now);
      i += 2;
    } else if (tryDue(lower, now)) {
      due = tryDue(lower, now);
    } else {
      title.push(w);
    }
  }

  if (!title.length) throw new Error('Give the task a title, e.g. "Reply to Moris p2 tomorrow 30m #hul".');
  return { title: title.join(' '), priority, due, estimate, labels: labels.length ? labels : undefined };
}

function tryDue(word: string, now: Date): string | undefined {
  try {
    return parseDue(word, now);
  } catch {
    return undefined;
  }
}
