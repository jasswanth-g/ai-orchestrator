import { describe, expect, test } from 'bun:test';
import { doneLabel, planTransition } from '../src/ado/transitions.ts';

const state = (p: ReturnType<typeof planTransition>) => p?.ops.find((o) => o.path === '/fields/System.State')?.value;
const path = (p: ReturnType<typeof planTransition>, f: string) => p?.ops.find((o) => o.path === `/fields/${f}`);
const report = (verdict: string): any => ({ verdict, summary: 'Matches the mockup.', requirement: { note: 'AC-1 says so' }, openQuestions: ['Fixed text?'], fix: { approach: 'Use round()' }, tests: ['total 10.5'] });

describe('done', () => {
  test('Bug → Resolved (Fixed), fills Completed Work, retest note', () => {
    const p = planTransition('done', { type: 'Bug', fields: {} }, report('bug'));
    expect(p?.label).toBe('Resolved');
    expect(state(p)).toBe('Resolved');
    expect(path(p, 'Microsoft.VSTS.Common.ResolvedReason')?.value).toBe('Fixed');
    expect(path(p, 'Microsoft.VSTS.Scheduling.CompletedWork')?.value).toBe(1);
    expect(p?.comment).toContain('ready for retest');
    expect(p?.comment).toContain('total 10.5');
  });

  test('Bug with a not-a-defect verdict is handed back to the reporter', () => {
    for (const v of ['works-as-designed', 'cannot-reproduce', 'requirement-gap']) {
      const p = planTransition('done', { type: 'Bug', fields: { 'System.CreatedBy': 'Swapna K <swapna@qwipo.com>' } }, report(v));
      expect(state(p)).toBe('Active');
      expect(path(p, 'System.AssignedTo')?.value).toBe('swapna@qwipo.com');
      expect(p?.label).toBe('hand back to Swapna K (Active)');
      expect(p?.comment).toContain('Matches the mockup.');
    }
  });

  test('Task → Closed, keeps Completed Work, clears Remaining Work', () => {
    const p = planTransition('done', { type: 'Task', fields: { 'Microsoft.VSTS.Scheduling.CompletedWork': 6, 'Microsoft.VSTS.Scheduling.RemainingWork': 2 } });
    expect(state(p)).toBe('Closed');
    expect(path(p, 'Microsoft.VSTS.Scheduling.CompletedWork')).toBeUndefined();
    expect(path(p, 'Microsoft.VSTS.Scheduling.RemainingWork')).toEqual({ op: 'remove', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork' });
    const empty = planTransition('done', { type: 'Task', fields: {} });
    expect(path(empty, 'Microsoft.VSTS.Scheduling.RemainingWork')).toBeUndefined();
    expect(path(empty, 'Microsoft.VSTS.Scheduling.CompletedWork')?.value).toBe(1);
  });

  test('Story → Ready for QA, Issue → Resolved, unknown types → nothing', () => {
    expect(state(planTransition('done', { type: 'Story', fields: {} }))).toBe('Ready for QA');
    expect(state(planTransition('done', { type: 'Issue', fields: {} }))).toBe('Resolved');
    expect(planTransition('done', { type: 'Epic', fields: {} })).toBeUndefined();
  });

  test('doneLabel matches the plan without fetching the item', () => {
    expect(doneLabel('bug')).toBe('Resolved');
    expect(doneLabel('bug', 'works-as-designed')).toBe('hand back to the reporter (Active)');
    expect(doneLabel('task')).toBe('Closed');
    expect(doneLabel('story')).toBe('Ready for QA');
    expect(doneLabel(undefined)).toBeUndefined();
  });
});

describe('start (Developer agent)', () => {
  test('Bug/Task → Active with estimates; Story/Issue → In Development', () => {
    const bug = planTransition('start', { type: 'Bug', fields: {} });
    expect(state(bug)).toBe('Active');
    expect(path(bug, 'Microsoft.VSTS.Scheduling.RemainingWork')?.value).toBe(1);
    expect(path(bug, 'Microsoft.VSTS.Scheduling.OriginalEstimate')?.value).toBe(1);
    expect(state(planTransition('start', { type: 'Task', fields: { 'Microsoft.VSTS.Scheduling.RemainingWork': 3, 'Microsoft.VSTS.Scheduling.OriginalEstimate': 8 } }))).toBe('Active');
    expect(state(planTransition('start', { type: 'Story', fields: {} }))).toBe('In Development');
    expect(state(planTransition('start', { type: 'Issue', fields: {} }))).toBe('In Development');
  });
});
