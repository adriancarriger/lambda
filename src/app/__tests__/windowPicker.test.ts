import type { Panes } from '../shared/types';
import { chosenOption, pickerGroups } from '../shared/windowPicker';

const labelOf = (window: string): string =>
  ({ 'engineering-manager': 'Engineering manager', dev: 'Dev', qa: 'QA' }[
    window
  ] ?? window);

const panes: Panes = {
  others: [
    { id: '@3', name: 'web', group: 'project', typable: false },
    { id: '@4', name: 'scratchPad', group: 'project', typable: true },
    { id: '@9', name: 'mothership', group: 'lambda', typable: false },
    { id: '@10', name: 'runner', group: 'lambda', typable: false },
  ],
  working: ['dev'],
};

describe("the Agents panel's window list", () => {
  it("lists the agents first, marked working or idle, then the codebase's windows, read-only but for the scratchPad", () => {
    const groups = pickerGroups({
      agents: ['engineering-manager', 'dev', 'qa'],
      labelOf,
      panes,
      showLambda: false,
    });

    expect(groups).toEqual([
      {
        label: 'Agents',
        options: [
          {
            value: 'engineering-manager',
            label: '○ Engineering manager',
            readOnly: false,
          },
          { value: 'dev', label: '● Dev', readOnly: false },
          { value: 'qa', label: '○ QA', readOnly: false },
        ],
      },
      {
        label: 'Codebase',
        options: [
          { value: '@3', label: 'web · read-only', readOnly: true },
          { value: '@4', label: 'scratchPad', readOnly: false },
        ],
      },
    ]);
  });

  it("adds Lambda's own windows only when asked", () => {
    const groups = pickerGroups({
      agents: ['dev'],
      labelOf,
      panes,
      showLambda: true,
    });

    expect(groups.map((group) => group.label)).toEqual([
      'Agents',
      'Codebase',
      'Lambda · read-only',
    ]);
  });

  it('shows the agents before the list has loaded', () => {
    expect(
      pickerGroups({ agents: ['dev'], labelOf, panes: null, showLambda: true })
    ).toEqual([
      {
        label: 'Agents',
        options: [{ value: 'dev', label: '○ Dev', readOnly: false }],
      },
    ]);
  });

  it('keeps the pick while it is there, else falls back to the agent named', () => {
    const groups = pickerGroups({
      agents: ['engineering-manager', 'dev'],
      labelOf,
      panes,
      showLambda: false,
    });

    expect(chosenOption(groups, '@4', 'dev')?.value).toBe('@4');
    // A Lambda window picked while they were shown, now hidden.
    expect(chosenOption(groups, '@9', 'dev')?.value).toBe('dev');
    expect(chosenOption(groups, null, 'engineering-manager')?.value).toBe(
      'engineering-manager'
    );
  });
});
