import { type ResolvedStep, loadProcess } from '../process/workflow-file';

/**
 * Every step of a building pod's process, switched off ones included (marked
 * `off`): Lambda's standard steps (pick-up, build, self-review, check-ticket,
 * visual-check, test, design-check, ship), patched by the project's
 * `.lambda/building/workflow.json`.
 */
export const allBuildingSteps = (projectRoot: string): ResolvedStep[] =>
  Object.values(loadProcess(projectRoot, 'building').tracks)
    .flat()
    .flatMap((stage) => stage.steps);

/**
 * A building pod's steps for one ticket, in order. A step switched off is
 * left out; `check-ticket` and `ship` can't be dropped or switched off.
 */
export const buildingSteps = (projectRoot: string): ResolvedStep[] =>
  allBuildingSteps(projectRoot).filter((step) => step.off !== true);

export const buildingStepIds = (projectRoot: string): string[] =>
  buildingSteps(projectRoot).map((step) => step.id);
