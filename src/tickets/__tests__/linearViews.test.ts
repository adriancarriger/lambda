import { type FilterContext, translateIssueFilter } from '../linearViews';
import type { TicketState } from '../source';

/**
 * A Linear view's filter in Lambda's terms: what translates becomes chips,
 * and what doesn't (a cycle, "or" across fields, a stranger) is named, never
 * guessed at.
 */

const STATES: Record<string, TicketState> = {
  Todo: 'ready',
  started: 'building',
  Done: 'done',
};

const context: FilterContext = {
  assigneeOf: (userId) =>
    ({ 'user-leslie': "Leslie's MacBook", 'user-ann': 'Ann Perkins' }[userId] ??
    null),
  labelKey: (name) => name.toLowerCase().replace(/\s+/g, '-'),
  projectName: (projectId) =>
    ({ 'project-lot48': 'Lot 48' }[projectId] ?? null),
  stateOf: (state) => STATES[state] ?? null,
  priorityOf: (value) => (value === 1 ? 'urgent' : 'high'),
};

describe('translateIssueFilter', () => {
  it('reads labels, assignees, projects, states and priorities', () => {
    expect(
      translateIssueFilter(
        {
          and: [
            { labels: { name: { in: ['Planned', 'Lot 48'] } } },
            { assignee: { id: { eq: 'user-leslie' } } },
            { project: { id: { in: ['project-lot48'] } } },
            { state: { type: { eq: 'started' } } },
            { priority: { in: [1, 2] } },
          ],
        },
        context
      )
    ).toEqual({
      chips: [
        { field: 'label', value: 'planned' },
        { field: 'label', value: 'lot-48' },
        { field: 'assignee', value: "Leslie's MacBook" },
        { field: 'project', value: 'Lot 48' },
        { field: 'status', value: 'building' },
        { field: 'priority', value: 'urgent' },
        { field: 'priority', value: 'high' },
      ],
      dropped: [],
    });
  });

  it("names what it can't translate, once each", () => {
    expect(
      translateIssueFilter(
        {
          cycle: { number: { eq: 12 } },
          assignee: { id: { in: ['user-ron', 'user-tammy'] } },
          state: { name: { eq: 'Triage' } },
        },
        context
      )
    ).toEqual({
      chips: [],
      dropped: [
        'the cycle',
        'an assignee who is neither a computer nor you',
        'the status "Triage"',
      ],
    });
  });

  it('keeps "any of" within a field and says so across fields', () => {
    expect(
      translateIssueFilter(
        {
          or: [
            { labels: { name: { eq: 'Bug' } } },
            { project: { name: { eq: 'Harvest festival' } } },
          ],
        },
        context
      )
    ).toEqual({
      chips: [
        { field: 'label', value: 'bug' },
        { field: 'project', value: 'Harvest festival' },
      ],
      dropped: ['"any of" across labels, project (read as "all of")'],
    });
  });

  it("reads no assignee, and ignores a label's parent group", () => {
    expect(
      translateIssueFilter(
        {
          assignee: { null: true },
          labels: {
            name: { eq: 'Bug' },
            parent: { name: { eq: 'Type' } },
          },
        },
        context
      ).chips
    ).toEqual([
      { field: 'assignee', value: '' },
      { field: 'label', value: 'bug' },
    ]);
  });
});
