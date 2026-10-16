/**
 * Azure DevOps service-hook payloads → one normalised BugEvent.
 * Pure: no network, no store. Handles resourceVersion 1.0 payloads, where
 * identity fields are "Display Name <email>" strings, and newer ones where
 * they are { displayName, uniqueName } objects.
 */

export type AdoEventType = 'workitem.created' | 'workitem.updated' | 'workitem.commented';

export interface AdoPayload {
  id?: string;
  eventType?: string;
  resource?: Record<string, any>;
}

export interface Person {
  name: string;
  email: string;
}

/** A work item (Bug, Task, Story, …). Named Bug for history; `type` says which. */
export interface Bug {
  id: number;
  /** System.WorkItemType, e.g. Bug, Task, Story. */
  type: string;
  title: string;
  state: string;
  application?: string;
  priority?: number;
  severity?: string;
  assignedTo?: Person;
  createdBy?: Person;
}

export type BugEvent =
  | { kind: 'created'; bug: Bug }
  | { kind: 'assigned'; bug: Bug; by?: Person }
  | { kind: 'state'; bug: Bug; from?: string; by?: Person }
  | { kind: 'comment'; bug: Bug; by?: Person; html: string; mentionIds: string[] };

/**
 * Fallback for Bug states that still need work, used when the per-type state
 * categories from ADO aren't available (tests, offline).
 */
export const OPEN_STATES = ['New', 'Active', 'Reopen'];

/** "Name <email>" | { displayName, uniqueName } → Person. */
export function toPerson(v: unknown): Person | undefined {
  if (!v) return undefined;
  if (typeof v === 'object') {
    const o = v as { displayName?: string; uniqueName?: string };
    return { name: o.displayName ?? '', email: (o.uniqueName ?? '').toLowerCase() };
  }
  const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(String(v));
  return m ? { name: m[1]!, email: m[2]!.toLowerCase() } : { name: String(v), email: '' };
}

/** Identity ids in `data-vss-mention="version:2.0,<id>"` anchors. */
export function mentionIds(html: string): string[] {
  return [...html.matchAll(/data-vss-mention="version:[\d.]+,([0-9a-f-]{36})"/gi)].map((m) => m[1]!.toLowerCase());
}

/** Comment HTML → plain text for a task note. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/(div|p|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Work item fields → Bug. */
export function bugFrom(id: number, f: Record<string, any>): Bug {
  return {
    id,
    type: f['System.WorkItemType'] ?? 'Bug',
    title: f['System.Title'] ?? '',
    state: f['System.State'] ?? '',
    application: f['Custom.Application'] || undefined,
    priority: f['Microsoft.VSTS.Common.Priority'],
    severity: f['Microsoft.VSTS.Common.Severity'],
    assignedTo: toPerson(f['System.AssignedTo']),
    createdBy: toPerson(f['System.CreatedBy']),
  };
}

/** Field value or, on an updated event, its { oldValue, newValue } change. */
const change = (fields: Record<string, any> | undefined, key: string) =>
  fields?.[key] && typeof fields[key] === 'object' && 'newValue' in fields[key]
    ? (fields[key] as { oldValue?: unknown; newValue?: unknown })
    : undefined;

/** Payload → events for one work item (any type). Irrelevant updates give []. */
export function parsePayload(p: AdoPayload): BugEvent[] {
  const r = p.resource;
  if (!r) return [];

  if (p.eventType === 'workitem.updated') {
    const fields = r.revision?.fields as Record<string, any> | undefined;
    if (!fields) return [];
    const bug = bugFrom(Number(r.workItemId ?? r.revision?.id), fields);
    const by = toPerson(fields['System.ChangedBy']);
    const events: BugEvent[] = [];
    if (change(r.fields, 'System.AssignedTo')) events.push({ kind: 'assigned', bug, by });
    const state = change(r.fields, 'System.State');
    if (state) events.push({ kind: 'state', bug, from: state.oldValue as string | undefined, by });
    return events;
  }

  const fields = r.fields as Record<string, any> | undefined;
  if (!fields) return [];
  const bug = bugFrom(Number(r.id), fields);

  if (p.eventType === 'workitem.created') return [{ kind: 'created', bug }];
  if (p.eventType === 'workitem.commented') {
    const html = String(fields['System.History'] ?? '');
    return [{ kind: 'comment', bug, by: toPerson(fields['System.ChangedBy']), html, mentionIds: mentionIds(html) }];
  }
  return [];
}
