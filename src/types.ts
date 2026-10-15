/**
 * Domain vocabulary shared by every store adapter and every tool.
 * Nothing here knows about Todoist.
 */

/** The three buckets an item can live in, and their display names in the backing store. */
export const BUCKETS = {
  work: 'Work',
  questions: 'Questions',
  memory: 'Memory Bank',
  /** Work that should be handled some day but isn't committed: no deadline, never ranked or planned. */
  backlog: 'Backlog',
} as const;
export type Bucket = keyof typeof BUCKETS;

/** Maps the `kind` a caller speaks in (capture) to the bucket it lands in. */
export const KIND_TO_BUCKET = {
  task: 'work',
  question: 'questions',
  memory: 'memory',
  backlog: 'backlog',
} as const satisfies Record<string, Bucket>;
export type Kind = keyof typeof KIND_TO_BUCKET;

/**
 * Where an item came from. Deliberately an open string, not an enum: a new
 * channel (a new MCP server Claude reads from) needs no code change here.
 * These are the suggested values only.
 */
export const KNOWN_SOURCES = ['manual', 'mail', 'whatsapp', 'teams'] as const;
export const DEFAULT_SOURCE = 'manual';

/** 1 = P1 (most urgent) … 4 = P4. Adapters translate to their own scale. */
export type Priority = 1 | 2 | 3 | 4;
export const DEFAULT_PRIORITY: Priority = 4;

/** Where an open task or backlog item stands. Done = closed, so it isn't a status. */
export const STATUSES = ['todo', 'in-progress', 'in-review'] as const;
export type Status = (typeof STATUSES)[number];
export const DEFAULT_STATUS: Status = 'todo';

/**
 * Backlog items rank by impact, not urgency. Impact reuses the priority
 * field: P1 = high, P2 = medium, P3 / P4 = low.
 */
export const IMPACT = { high: 1, medium: 2, low: 3 } as const satisfies Record<string, Priority>;
export type Impact = keyof typeof IMPACT;
export const impactOf = (p: Priority): Impact => (p === 1 ? 'high' : p === 2 ? 'medium' : 'low');

export interface Item {
  id: string;
  bucket: Bucket;
  title: string;
  notes?: string;
  priority: Priority;
  /** YYYY-MM-DD, or a full ISO datetime when the item has a time. */
  due?: string;
  labels: string[];
  source: string;
  link?: string;
  /** Local filesystem path, set on `location` memories. */
  path?: string;
  /** Effort estimate in minutes (tasks). */
  estimate?: number;
  /** Tasks and backlog items; absent means todo. */
  status?: Status;
  /** Questions: the recommended approach or proposed solution. */
  approach?: string;
  createdAt: string;
  /** Set on items from listCompleted. */
  closedAt?: string;
}

export interface NewItem {
  title: string;
  notes?: string;
  priority?: Priority;
  /** YYYY-MM-DD, today, tomorrow, a weekday, "next week" or "in N days/weeks" (see due.ts). */
  due?: string;
  labels?: string[];
  source?: string;
  link?: string;
  path?: string;
  /** Minutes. */
  estimate?: number;
  approach?: string;
}

/** Label every remembered file location carries. */
export const LOCATION_LABEL = 'location';

export interface ItemPatch {
  title?: string;
  /** Replaces the notes; '' clears them. */
  notes?: string;
  /** Replaces the approach; '' clears it. */
  approach?: string;
  priority?: Priority;
  /** A due phrase; null clears the due date. */
  due?: string | null;
  /** Minutes. */
  estimate?: number;
  status?: Status;
  /** Replaces all labels. */
  labels?: string[];
  /** Moves the item, e.g. backlog → work when it is pulled in. */
  bucket?: Bucket;
}
