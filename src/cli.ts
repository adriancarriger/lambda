/**
 * The lambda command line.
 *
 * Dispatch decides before commander parses: a built-in runs through
 * commander; a drop-in is loaded and registered first; a lambda.json command
 * runs through the shell; anything else goes to the project's own CLI with
 * its argv untouched, so commander never eats that CLI's flags.
 */
import { Command } from 'commander';

import { registerShipCommand } from './building/ship';
import { registerAccountCommand } from './commands/account';
import { registerAgentCommand } from './commands/agent';
import { registerAwaitCommand } from './commands/await';
import { registerBuildingCommand } from './commands/building';
import { registerComputerCommand } from './commands/computer';
import { registerConnectCommand } from './commands/connect';
import { registerDesignCommand } from './commands/design';
import { registerDoctorCommand } from './commands/doctor';
import { registerE2ECommand, runCommandTemplate } from './commands/e2e';
import { registerEventCommand } from './commands/event';
import { registerInitCommand } from './commands/init';
import { registerInternalCommand } from './commands/internal';
import {
  registerJoinCommand,
  registerLeaveCommand,
  registerStatusCommand,
} from './commands/join';
import { registerOpenCommand } from './commands/open';
import { registerPlanningCommand } from './commands/planning';
import { registerShotCommand } from './commands/shot';
import { registerStartCommand, registerStopCommand } from './commands/start';
import { registerTicketsCommand } from './commands/tickets';
import { registerTmuxCommand } from './commands/tmux';
import { registerTraceCommand } from './commands/trace';
import { registerUpgradeCommand } from './commands/upgrade';
import { loadMachineConfig } from './config/machineConfig';
import { type Project, loadProjectConfig } from './config/projectConfig';
import { forwardToProjectCli } from './dispatch/forward';
import {
  BUILT_IN_COMMANDS,
  loadDropIn,
  refusedMessage,
  resolveCommand,
  unavailableMessage,
} from './dispatch/resolve';
import { registerKnowledgeCommand, registerPodCommand } from './pod';
import { registerVerdictCommand } from './verdict';

export const VERSION = '0.2.0';

const REGISTER: Record<string, (program: Command) => void> = {
  init: registerInitCommand,
  doctor: registerDoctorCommand,
  tmux: registerTmuxCommand,
  await: registerAwaitCommand,
  agent: registerAgentCommand,
  e2e: registerE2ECommand,
  trace: (program) => registerTraceCommand(program),
  tickets: (program) => registerTicketsCommand(program),
  planning: registerPlanningCommand,
  building: registerBuildingCommand,
  pod: registerPodCommand,
  knowledge: registerKnowledgeCommand,
  start: registerStartCommand,
  stop: registerStopCommand,
  open: registerOpenCommand,
  join: registerJoinCommand,
  leave: registerLeaveCommand,
  status: registerStatusCommand,
  computer: registerComputerCommand,
  event: registerEventCommand,
  account: registerAccountCommand,
  verdict: (program) => registerVerdictCommand(program),
  ship: (program) => registerShipCommand(program),
  design: registerDesignCommand,
  shot: (program) => registerShotCommand(program),
  connect: registerConnectCommand,
  upgrade: registerUpgradeCommand,
  internal: registerInternalCommand,
};

export const HELP_TEXT = [
  'Usage: lambda <command> [options]',
  '',
  'Commands:',
  ...BUILT_IN_COMMANDS.map(
    (command) => `  ${command.name.padEnd(9)} ${command.description}`
  ),
  '',
  "Anything else runs your project's CLI (see lambda doctor).",
  '',
].join('\n');

/**
 * The program with every built-in command, except any in `omit` (a drop-in
 * takes that name instead).
 */
export const createProgram = (options: { omit?: string[] } = {}): Command => {
  const program = new Command();
  program
    .name('lambda')
    .usage('<command> [options]')
    .version(VERSION, '-V, --version');

  BUILT_IN_COMMANDS.filter(
    (command) => !(options.omit ?? []).includes(command.name)
  ).forEach((command) => REGISTER[command.name]?.(program));

  // Set after the commands are added, so their own help keeps the default.
  program.configureHelp({ formatHelp: () => HELP_TEXT });

  return program;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const exitCode = (): number => Number(process.exitCode ?? 0);

/**
 * The only first arguments lambda's own parser sees besides its commands.
 * Anything else (`help`, `-x`) goes to the project CLI untouched.
 */
const LAMBDA_FLAGS = ['--help', '--version'];

/**
 * Commands that run without the settings files, or survive bad ones: init
 * writes them, and doctor shows what's wrong with them.
 */
const READS_NO_SETTINGS = ['init', 'doctor'];

/**
 * Read and validate both settings files before dispatching. Every other
 * command fails on a bad one (`<path>: <field> <problem>`, exit 1) up front, rather
 * than partway through, whichever of them it ends up reading.
 */
const loadSettings = (
  name: string
): { project: Project | null } | { error: string } => {
  try {
    const project = loadProjectConfig(process.cwd());
    loadMachineConfig();

    return { project };
  } catch (error) {
    return READS_NO_SETTINGS.includes(name)
      ? { project: safeProject() }
      : { error: errorMessage(error) };
  }
};

/** The project, or null when its lambda.json can't be read (init, doctor). */
const safeProject = (): Project | null => {
  try {
    return loadProjectConfig(process.cwd());
  } catch {
    return null;
  }
};

const parse = async (program: Command, argv: string[]): Promise<number> => {
  await program.parseAsync(argv);

  return exitCode();
};

/**
 * Run `lambda` with a full argv (`[node, script, ...args]`) and resolve with
 * the exit code. Errors are printed to stderr.
 */
export const run = async (argv: string[] = process.argv): Promise<number> => {
  const args = argv.slice(2);
  const [name] = args;

  try {
    if (name === undefined || LAMBDA_FLAGS.includes(name)) {
      return await parse(createProgram(), argv);
    }

    const loaded = loadSettings(name);

    if ('error' in loaded) {
      console.error(loaded.error);

      return 1;
    }

    const { project } = loaded;
    const resolution = resolveCommand(name, project);

    switch (resolution.kind) {
      case 'built-in':
        return await parse(createProgram(), argv);
      case 'refused':
        // doctor is how a refused drop-in gets seen, so it still runs (and
        // lists itself as a refused drop-in); every other core name stops.
        if (name === 'doctor') {
          return await parse(createProgram(), argv);
        }

        console.error(refusedMessage(resolution.file, name));

        return 1;
      case 'unavailable':
        console.error(unavailableMessage(name));

        return 1;
      case 'drop-in': {
        if (project === null) {
          throw new Error(`No project for drop-in ${resolution.file}`);
        }

        const register = await loadDropIn(project, resolution.file);
        const program = createProgram({ omit: [name] });
        register(program);

        return await parse(program, argv);
      }
      case 'config': {
        if (project === null) {
          throw new Error(`No project for lambda.json ${resolution.key}`);
        }

        return await runCommandTemplate(
          resolution.command,
          args.slice(1),
          project.root
        );
      }
      case 'project-cli':
      case 'unknown': {
        const result = await forwardToProjectCli({
          args,
          project,
          runningBinary: argv[1],
        });

        if (result.message !== undefined) {
          console.error(result.message);
        }

        return result.code;
      }
    }
  } catch (error) {
    console.error(errorMessage(error));

    return 1;
  }
};
