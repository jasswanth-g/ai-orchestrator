import type { Report } from '../store/reports.ts';
import { toPerson } from './events.ts';

/**
 * What "Done" (and later "Developer starts") means in Azure DevOps, per work
 * item type — the team's rules (ado-story/conventions.md):
 *
 *   Bug    done  → Resolved (Fixed), Completed Work, retest-note comment; QA closes it
 *   Bug    done, report says works-as-designed / cannot-reproduce / requirement-gap
 *               → hand back: Active, assigned to the reporter, the finding as a comment
 *   Task   done  → Closed, Completed Work
 *   Story  done  → Ready for QA
 *   Issue  done  → Resolved
 *   start (Developer agent): Bug/Task → Active; Story/Issue → In Development
 *
 * Required fields are filled with 1 when empty ("value 1 is fine"). Pure: it
 * only plans the change; the caller sends it.
 */

export type Kind = 'done' | 'start';

export interface Plan {
  /** Short, for the confirm button: "Resolved", "hand back to Swapna (Active)". */
  label: string;
  /** JSON-patch operations for the work item. */
  ops: Array<{ op: 'add' | 'remove'; path: string; value?: unknown }>;
  /** Plain-text comment to add after the update. */
  comment?: string;
}

const F = {
  state: '/fields/System.State',
  reason: '/fields/System.Reason',
  resolvedReason: '/fields/Microsoft.VSTS.Common.ResolvedReason',
  assignedTo: '/fields/System.AssignedTo',
  completed: '/fields/Microsoft.VSTS.Scheduling.CompletedWork',
  remaining: '/fields/Microsoft.VSTS.Scheduling.RemainingWork',
  original: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate',
};

/** Findings that are not a code fix: the bug goes back to whoever raised it. */
export const HANDBACK_VERDICTS = ['works-as-designed', 'cannot-reproduce', 'requirement-gap'];

const empty = (v: unknown) => v === undefined || v === null || v === '' || v === 0;
const set = (path: string, value: unknown) => ({ op: 'add' as const, path, value });
/** Clears a field that has a value (ADO rejects removing an empty one). */
const clearIfSet = (fields: Record<string, any>, field: string, path: string) => (empty(fields[field]) ? [] : [{ op: 'remove' as const, path }]);

/** Fill an estimate field only when ADO has none. */
function fillIfEmpty(fields: Record<string, any>, field: string, path: string, value = 1) {
  return empty(fields[field]) ? [set(path, value)] : [];
}

const lines = (title: string, items?: string[]) => (items?.length ? `\n${title}\n${items.map((t) => `- ${t}`).join('\n')}` : '');

/** The plan for a work item, or undefined when the type has no mapping (nothing is sent). */
export function planTransition(kind: Kind, item: { type: string; fields: Record<string, any> }, report?: Report | null): Plan | undefined {
  const { type, fields } = item;
  const active = () => [set(F.state, 'Active'), ...fillIfEmpty(fields, 'Microsoft.VSTS.Scheduling.RemainingWork', F.remaining), ...fillIfEmpty(fields, 'Microsoft.VSTS.Scheduling.OriginalEstimate', F.original)];

  if (kind === 'start') {
    if (type === 'Bug' || type === 'Task') return { label: 'Active', ops: active() };
    if (type === 'Story' || type === 'Issue') return { label: 'In Development', ops: [set(F.state, 'In Development')] };
    return undefined;
  }

  switch (type) {
    case 'Bug': {
      if (report && HANDBACK_VERDICTS.includes(report.verdict)) {
        const reporter = toPerson(fields['System.CreatedBy']);
        return {
          label: `hand back to ${reporter?.name ?? 'the reporter'} (Active)`,
          ops: [...active(), ...(reporter?.email ? [set(F.assignedTo, reporter.email)] : [])],
          comment: `Analysis: ${report.verdict.replace(/-/g, ' ')}.\n${report.summary}${report.requirement?.note ? `\nRequirement: ${report.requirement.note}` : ''}${lines('Open questions:', report.openQuestions)}`,
        };
      }
      return {
        label: 'Resolved',
        ops: [
          set(F.state, 'Resolved'),
          set(F.resolvedReason, 'Fixed'),
          ...fillIfEmpty(fields, 'Microsoft.VSTS.Scheduling.CompletedWork', F.completed),
          set(F.remaining, 0),
        ],
        comment: `Fixed — ready for retest.${report ? `\n${report.fix?.approach ?? ''}` : ''}${lines('Please check:', report?.tests)}`,
      };
    }
    case 'Task':
      // A closed Task must have no Remaining Work (rule InvalidNotEmpty).
      return { label: 'Closed', ops: [set(F.state, 'Closed'), ...fillIfEmpty(fields, 'Microsoft.VSTS.Scheduling.CompletedWork', F.completed), ...clearIfSet(fields, 'Microsoft.VSTS.Scheduling.RemainingWork', F.remaining)] };
    case 'Story':
      return { label: 'Ready for QA', ops: [set(F.state, 'Ready for QA')] };
    case 'Issue':
      return { label: 'Resolved', ops: [set(F.state, 'Resolved')] };
    default:
      return undefined;
  }
}

/**
 * What Done will do, from the task's type label and the report verdict — cheap
 * enough to show on every refresh (the real plan reads the live work item).
 */
export function doneLabel(typeLabel: string | undefined, verdict?: string): string | undefined {
  switch (typeLabel) {
    case 'bug':
      return verdict && HANDBACK_VERDICTS.includes(verdict) ? 'hand back to the reporter (Active)' : 'Resolved';
    case 'task':
      return 'Closed';
    case 'story':
      return 'Ready for QA';
    case 'issue':
      return 'Resolved';
    default:
      return undefined;
  }
}
