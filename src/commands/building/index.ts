import { type Command } from 'commander';

import { type ProcessProject, registerProcessCommand } from '../planning';

/** `lambda building steps|show`: the project's resolved building process. */
export const registerBuildingCommand = (
  program: Command,
  project?: () => ProcessProject
): void => registerProcessCommand(program, 'building', project);
