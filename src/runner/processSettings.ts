import {
  type ProcessName,
  type ResolvedStep,
  loadProcess,
  setStepOff,
} from '../process/workflow-file';

/**
 * Settings → Process, on the runner holding the project: the resolved
 * planning (the `idea` track) and building steps, and the switch, through
 * the process loader in that project's own folder.
 */

export type StepSetting = 'on' | 'off' | 'locked';

export interface ProcessStepRow {
  id: string;
  label: string;
  setting: StepSetting;
  added: boolean;
}

export interface ProcessStageRow {
  id: string;
  label: string;
  steps: ProcessStepRow[];
}

export type ProcessSettings = Record<ProcessName, ProcessStageRow[]>;

/** Planning steps as `lambda planning show` lists them by default. */
export const PLANNING_TRACK = 'idea';
const BUILDING_TRACK = 'standard';

/** Only optional steps (and added steps with a switch) have one. */
const settingOf = (step: ResolvedStep): StepSetting | null => {
  if (step.locked === true) {
    return 'locked';
  }

  if (step.optional === true) {
    return step.off === true ? 'off' : 'on';
  }

  return null;
};

const rowsOf = (
  folder: string,
  name: ProcessName,
  track: string
): ProcessStageRow[] =>
  (loadProcess(folder, name).tracks[track] ?? []).flatMap((stage) => {
    const steps = stage.steps.flatMap((step): ProcessStepRow[] => {
      const setting = settingOf(step);

      return setting === null
        ? []
        : [
            {
              id: step.id,
              label: step.label,
              setting,
              added: step.added === true,
            },
          ];
    });

    return steps.length === 0
      ? []
      : [{ id: stage.id, label: stage.label, steps }];
  });

export const readProcessSettings = (folder: string): ProcessSettings => ({
  planning: rowsOf(folder, 'planning', PLANNING_TRACK),
  building: rowsOf(folder, 'building', BUILDING_TRACK),
});

const isProcess = (value: string): value is ProcessName =>
  value === 'planning' || value === 'building';

/**
 * Turn a step off (its id joins `off`) or on (it leaves it), through the
 * process loader. What it refuses — a locked step, one that isn't
 * optional, one that doesn't exist — is its error, passed on as it is, and
 * the file is left as it was. Answers the settings after the change.
 */
export const switchProcessStep = (
  folder: string,
  process: string,
  id: string,
  on: boolean
): ProcessSettings => {
  if (!isProcess(process)) {
    throw new Error(`"${process}" isn't planning or building.`);
  }

  setStepOff(folder, process, id, !on);

  return readProcessSettings(folder);
};
