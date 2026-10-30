import { execFile } from 'child_process';
import { type Command } from 'commander';

import { loadMachineConfig } from '../../config/machineConfig';
import { mothershipDbPath } from '../../mothership/db';
import { mintLoginLink, mothershipPort } from '../../mothership/loginLink';
import { answering, hostsMothership } from '../../runner/processes';

/**
 * `lambda open`: the app in your browser, already signed in. It mints a
 * single-use 60-second login link straight into the database file, so only
 * someone who can read that file on the host can do it.
 */

type Env = Record<string, string | undefined>;

export const NOT_THE_HOST =
  'lambda open only works on the computer running Lambda. On this one, sign in with a code from Add a device.';

export const NOT_RUNNING = "Lambda isn't running. Run lambda start first.";

export interface OpenDeps {
  env: Env;
  answering: (port: number) => Promise<boolean>;
  /** Rejects when no browser could be started. */
  open: (url: string) => Promise<void>;
}

export const OPENING = 'Opening Lambda in your browser, signed in…';

/** Mint the link and open it: answers the line to print. */
export const runOpen = async (deps: OpenDeps): Promise<string> => {
  const config = loadMachineConfig(deps.env);

  if (!hostsMothership(config, deps.env)) {
    throw new Error(NOT_THE_HOST);
  }

  const port = mothershipPort(config?.mothership?.port);

  if (!(await deps.answering(port))) {
    throw new Error(NOT_RUNNING);
  }

  const url = mintLoginLink(mothershipDbPath(deps.env), { port });

  try {
    await deps.open(url);

    return OPENING;
  } catch (error) {
    // Over SSH, or with no opener installed: the link itself still works.
    return `Couldn't open a browser here (${
      error instanceof Error ? error.message : String(error)
    }). Open this link within a minute: ${url}`;
  }
};

/** The program that opens a URL in the default browser, and its arguments. */
export const browserCommand = (
  platform: NodeJS.Platform,
  url: string
): [string, string[]] => {
  if (platform === 'darwin') {
    return ['open', [url]];
  }

  // `start` is a cmd built-in, not a program execFile can run.
  if (platform === 'win32') {
    return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  }

  return ['xdg-open', [url]];
};

const openInBrowser = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const [command, args] = browserCommand(process.platform, url);
    execFile(command, args, (error) =>
      error === null ? resolve() : reject(error)
    );
  });

export const registerOpenCommand = (program: Command): void => {
  program
    .command('open')
    .description('Open Lambda in your browser, signed in')
    .action(async () => {
      // Only once it's really opening: a refusal prints just itself.
      console.log(
        await runOpen({ env: process.env, answering, open: openInBrowser })
      );
    });
};
