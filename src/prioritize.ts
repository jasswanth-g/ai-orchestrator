import { formatEstimate } from './estimate.ts';
import type { Item } from './types.ts';

/**
 * Ranking for Work tasks. Additive and explainable on purpose: every point
 * comes with a reason string, so "why is this first?" always has an answer.
 */

const PRIORITY_POINTS = { 1: 40, 2: 30, 3: 20, 4: 10 } as const;
export const QUICK_WIN_MINUTES = 30;
/** Used by plan_day for tasks nobody has estimated yet. */
export const DEFAULT_ESTIMATE_MINUTES = 60;

export interface Ranked {
  item: Item;
  score: number;
  reasons: string[];
  /** Days until due (negative = overdue); undefined when undated. */
  daysLeft?: number;
}

/** Whole days from `today` to the item's due date, both YYYY-MM-DD. */
export const daysBetween = (today: string, due: string) =>
  Math.round((Date.parse(due.slice(0, 10)) - Date.parse(today)) / 86_400_000);

export function scoreTask(item: Item, today: string): Ranked {
  const reasons = [`P${item.priority}`];
  let score: number = PRIORITY_POINTS[item.priority];

  let daysLeft: number | undefined;
  if (item.due) {
    daysLeft = daysBetween(today, item.due);
    const [points, why] =
      daysLeft < 0
        ? [50, `overdue ${-daysLeft}d`]
        : daysLeft === 0
          ? [40, 'due today']
          : daysLeft === 1
            ? [30, 'due tomorrow']
            : daysLeft <= 3
              ? [20, `due in ${daysLeft}d`]
              : daysLeft <= 7
                ? [10, `due in ${daysLeft}d`]
                : [0, `due ${item.due.slice(0, 10)}`];
    score += points;
    reasons.push(why);
  }

  if (item.estimate !== undefined && item.estimate <= QUICK_WIN_MINUTES) {
    score += 5;
    reasons.push(`quick (${formatEstimate(item.estimate)})`);
  }
  return { item, score, reasons, daysLeft };
}

/** Highest score first; ties → earlier due, then oldest. */
export function rank(items: Item[], today: string): Ranked[] {
  return items
    .map((i) => scoreTask(i, today))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.item.due ?? '￿').localeCompare(b.item.due ?? '￿') ||
        a.item.createdAt.localeCompare(b.item.createdAt),
    );
}

export interface DayPlan {
  capacityMinutes: number;
  plannedMinutes: number;
  /** True when must-do work alone exceeds the day. */
  overCapacity: boolean;
  plan: (Ranked & { minutes: number; estimateAssumed: boolean; mustDo: boolean })[];
  /** Highest-ranked tasks that did not fit, for "what's next after this". */
  didNotFit: Ranked[];
  unestimated: number;
}

/**
 * Fills `capacityMinutes` by rank. Overdue and due-today tasks always go in
 * first, even past capacity (overCapacity flags it); the rest go in greedily,
 * skipping any task that no longer fits so smaller ones can still use the time.
 */
export function planDay(items: Item[], today: string, capacityMinutes: number): DayPlan {
  const ranked = rank(items, today);
  const minutesOf = (r: Ranked) => r.item.estimate ?? DEFAULT_ESTIMATE_MINUTES;
  const isMustDo = (r: Ranked) => r.daysLeft !== undefined && r.daysLeft <= 0;

  const plan: DayPlan['plan'] = [];
  const didNotFit: Ranked[] = [];
  let used = 0;

  for (const r of ranked.filter(isMustDo)) {
    plan.push({ ...r, minutes: minutesOf(r), estimateAssumed: r.item.estimate === undefined, mustDo: true });
    used += minutesOf(r);
  }
  for (const r of ranked.filter((x) => !isMustDo(x))) {
    if (used + minutesOf(r) <= capacityMinutes) {
      plan.push({ ...r, minutes: minutesOf(r), estimateAssumed: r.item.estimate === undefined, mustDo: false });
      used += minutesOf(r);
    } else didNotFit.push(r);
  }

  return {
    capacityMinutes,
    plannedMinutes: used,
    overCapacity: used > capacityMinutes,
    plan,
    didNotFit: didNotFit.slice(0, 5),
    unestimated: items.filter((i) => i.estimate === undefined).length,
  };
}
