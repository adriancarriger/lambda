import type { OtherWindow, Panes } from './types';

/**
 * The Agents panel's window list, as data: the pod's agents first (each
 * with a working or idle mark), then the project's own windows (read-only
 * but for its scratchPad), then, only
 * when asked for, Lambda's (the mothership and the runner).
 */

export interface PickerOption {
  /** What the terminal reads: an agent's window name, or a tmux id. */
  value: string;
  label: string;
  readOnly: boolean;
}

export interface PickerGroup {
  label: string;
  options: PickerOption[];
}

const others = (
  windows: OtherWindow[],
  group: OtherWindow['group']
): PickerOption[] =>
  windows
    .filter((window) => window.group === group)
    .map((window) => ({
      value: window.id,
      label:
        window.typable || group === 'lambda'
          ? window.name
          : `${window.name} · read-only`,
      readOnly: !window.typable,
    }));

export const pickerGroups = (input: {
  agents: string[];
  labelOf: (window: string) => string;
  panes: Panes | null;
  showLambda: boolean;
}): PickerGroup[] => {
  const working = new Set(input.panes?.working ?? []);
  const windows = input.panes?.others ?? [];

  return [
    {
      label: 'Agents',
      options: input.agents.map((agent) => ({
        value: agent,
        label: `${working.has(agent) ? '●' : '○'} ${input.labelOf(agent)}`,
        readOnly: false,
      })),
    },
    { label: 'Codebase', options: others(windows, 'project') },
    ...(input.showLambda
      ? [{ label: 'Lambda · read-only', options: others(windows, 'lambda') }]
      : []),
  ].filter((group) => group.options.length > 0);
};

/** The chosen window, if it's still there; else the first agent's. */
export const chosenOption = (
  groups: PickerGroup[],
  chosen: string | null,
  fallback: string
): PickerOption | undefined => {
  const all = groups.flatMap((group) => group.options);

  return (
    all.find((option) => option.value === chosen) ??
    all.find((option) => option.value === fallback) ??
    all[0]
  );
};
