/**
 * `lambda planning steps|show` and (through `registerProcessCommand`)
 * `lambda building steps|show`: the project's resolved process — Lambda's
 * standard steps, patched by `.lambda/<process>/workflow.json`.
 */
import { type Command } from 'commander';
import * as path from 'path';

import { loadProjectConfig } from '../../config/projectConfig';
import {
  type ProcessName,
  formatIds,
  formatProcess,
  loadProcess,
} from '../../process/workflow-file';

const DESCRIPTIONS: Record<ProcessName, string> = {
  planning: "Show this codebase's planning process",
  building: "Show this codebase's building process",
};

export interface ProcessProject {
  root: string;
  title: string;
}

const loadProject = (): ProcessProject => {
  const project = loadProjectConfig(process.cwd());

  if (project === null) {
    throw new Error('No codebase here: run lambda init first.');
  }

  return {
    root: project.root,
    title: project.config.name ?? path.basename(project.root),
  };
};

const list = (value: string): string[] =>
  value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

interface ShowOptions {
  track?: string;
  tickets?: string[];
  epic?: string;
}

export const registerProcessCommand = (
  program: Command,
  name: ProcessName,
  project: () => ProcessProject = loadProject
): void => {
  const command = program.command(name).description(DESCRIPTIONS[name]);

  command
    .command('steps')
    .description('List every step and stage id')
    .action(() => {
      console.log(formatIds(loadProcess(project().root, name)));
    });

  const show = command
    .command('show')
    .description(
      'Print the resolved process in order, marking what this codebase changed'
    )
    .option(
      '--tickets <ids>',
      'Fill {tickets} in added steps (comma-separated)',
      list
    )
    .option('--epic <id>', 'Fill {epic} in added steps');

  if (name === 'planning') {
    show.option('--track <track>', 'idea, existing or batch', 'idea');
  }

  show.action((options: ShowOptions) => {
    const current = project();

    console.log(
      formatProcess(loadProcess(current.root, name), {
        title: current.title,
        track: options.track,
        ownCommands:
          name === 'building'
            ? loadProjectConfig(current.root)?.config.building?.ownCommands
            : undefined,
        pod:
          options.tickets === undefined && options.epic === undefined
            ? undefined
            : { tickets: options.tickets ?? [], epic: options.epic },
      })
    );
  });
};

export const registerPlanningCommand = (
  program: Command,
  project?: () => ProcessProject
): void => registerProcessCommand(program, 'planning', project);
