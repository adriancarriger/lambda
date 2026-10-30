import { type Command } from 'commander';

import { loadMachineConfig } from '../../config/machineConfig';
import { mothershipDbPath } from '../../mothership/db';
import { mintLoginLink, mothershipPort } from '../../mothership/loginLink';
import { DIAGNOSE_ACTIONS } from '../../runner/diagnose';
import { hostsMothership } from '../../runner/processes';

/**
 * `lambda computer`: debug another computer of this Lambda from the one
 * running it (Adrian, 2026-10-28). See USAGE.
 *
 * Reads (status, pod, log, git, screen) change nothing. The rest act on a
 * pod there through the routes the app already uses: pause and resume a
 * building pod, press Esc in an agent's window, or say something to it.
 * An agent asks Adrian before any of those.
 *
 * It signs in as `lambda open` does, with a single-use login link written
 * straight into the database file, so only someone who can read that file
 * on the host can use it. The runner answers a fixed set of reads
 * (runner/diagnose.ts), never a command line.
 */

type Env = Record<string, string | undefined>;

export const NOT_THE_HOST =
  'lambda computer only works on the computer running Lambda.';

/** Acts on one of that computer's pods: they change something. */
const POD_ACTIONS = ['pause', 'resume', 'esc', 'say'] as const;

const ACTIONS = [...DIAGNOSE_ACTIONS, 'screen', ...POD_ACTIONS] as const;

export const USAGE = [
  'Usage: lambda computer [<name> <action>]',
  '',
  'Reads:',
  '  lambda computer                                  every computer',
  '  lambda computer <name> status                    its runner: PATH, the tools it finds',
  '  lambda computer <name> pod <pod id>              a pod as stored on that computer',
  '  lambda computer <name> log [lines]               the end of its runner log',
  '  lambda computer <name> git                       its checkout',
  "  lambda computer <name> screen <pod> <window>     an agent's window",
  '',
  'Changes (an agent asks first):',
  '  lambda computer <name> pause <pod>               pause a building pod',
  '  lambda computer <name> resume <pod>              resume it',
  "  lambda computer <name> esc <pod> <window>        press Esc in an agent's window",
  '  lambda computer <name> say <pod> <window> <text> type to an agent, then Enter',
  '',
  'Windows: manager, qa, dev.',
].join('\n');

const ESC = '1b';
const ENTER = '0d';

const hexOf = (text: string): string[] =>
  [...Buffer.from(text, 'utf8')].map((byte) =>
    byte.toString(16).padStart(2, '0')
  );

export interface ComputerDeps {
  env: Env;
  fetch: typeof fetch;
  /** A login link's URL, written into the database on this computer. */
  mint: (port: number) => string;
}

/** Sign in with a fresh login link: the session cookie, `name=value`. */
const signIn = async (deps: ComputerDeps, port: number): Promise<string> => {
  const answer = await deps.fetch(deps.mint(port), { redirect: 'manual' });
  const cookie = answer.headers.get('set-cookie')?.split(';')[0] ?? '';

  if (cookie === '') {
    throw new Error("Couldn't sign in to Lambda. Is it running?");
  }

  return cookie;
};

/** GET a route, or POST it JSON from the app's own origin. */
const call = async (
  deps: ComputerDeps,
  port: number,
  cookie: string,
  route: string,
  body?: Record<string, unknown>
): Promise<unknown> => {
  const origin = `http://127.0.0.1:${port}`;
  const answer = await deps.fetch(
    `${origin}${route}`,
    body === undefined
      ? { headers: { cookie } }
      : {
          method: 'POST',
          headers: { cookie, origin, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
  );
  const text = await answer.text();

  if (!answer.ok) {
    const error = (() => {
      try {
        const parsed: unknown = JSON.parse(text);

        const error = field(parsed, 'error');

        return typeof error === 'string' ? error : text;
      } catch {
        return text;
      }
    })();

    throw new Error(error);
  }

  return text === '' ? null : JSON.parse(text);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const field = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

const listLines = (answer: unknown): string => {
  const computers = field(answer, 'computers');

  return (Array.isArray(computers) ? computers : [])
    .map(
      (one) =>
        `${String(field(one, 'name'))}  ${
          field(one, 'connected') === true ? 'online' : 'offline'
        }  ${String(field(one, 'id'))}`
    )
    .join('\n');
};

const logLines = (answer: unknown): string => {
  const logs = field(answer, 'logs');

  return (Array.isArray(logs) ? logs : [])
    .map((one) => {
      const lines = field(one, 'lines');

      return [
        `== ${String(field(one, 'file'))}`,
        ...(Array.isArray(lines) ? lines.map(String) : []),
      ].join('\n');
    })
    .join('\n\n');
};

const query = (params: Record<string, string | undefined>): string =>
  new URLSearchParams(
    Object.entries(params).flatMap(([key, value]): [string, string][] =>
      value === undefined ? [] : [[key, value]]
    )
  ).toString();

/**
 * pause / resume / esc / say: the pod's id picks its computer, as in the
 * app. Answers what was done.
 */
const podAction = async (
  deps: ComputerDeps,
  port: number,
  action: string,
  [podId, window, ...words]: string[]
): Promise<string> => {
  const needsWindow = action === 'esc' || action === 'say';
  const text = words.join(' ');

  if (
    podId === undefined ||
    (needsWindow && window === undefined) ||
    (action === 'say' && text === '')
  ) {
    throw new Error(USAGE);
  }

  const cookie = await signIn(deps, port);

  if (action === 'pause' || action === 'resume') {
    await call(deps, port, cookie, `/api/${action}`, { podId });

    return `${action === 'pause' ? 'Paused' : 'Resumed'} ${podId}.`;
  }

  const keys = (hex: string[]) =>
    call(deps, port, cookie, '/api/term/keys', { podId, window, hex });

  if (action === 'esc') {
    await keys([ESC]);

    return `Pressed Esc in ${podId}'s ${String(window)}.`;
  }

  // The text, then Enter on its own: Claude's prompt reads one send as a paste.
  await keys(hexOf(text));
  await keys([ENTER]);

  return `Said to ${podId}'s ${String(window)}: ${text}`;
};

/** Run it: answers what to print. */
export const runComputer = async (
  args: string[],
  deps: ComputerDeps
): Promise<string> => {
  const config = loadMachineConfig(deps.env);

  if (!hostsMothership(config, deps.env)) {
    throw new Error(NOT_THE_HOST);
  }

  const port = mothershipPort(config?.mothership?.port);
  const [name, action, ...rest] = args;

  if (name === undefined) {
    const cookie = await signIn(deps, port);

    return listLines(await call(deps, port, cookie, '/api/computers'));
  }

  if (!ACTIONS.some((known) => known === action)) {
    throw new Error(USAGE);
  }

  if (action === 'screen') {
    const [podId, window] = rest;

    if (podId === undefined || window === undefined) {
      throw new Error(USAGE);
    }

    const cookie = await signIn(deps, port);
    const answer = await call(
      deps,
      port,
      cookie,
      `/api/term?${query({ podId, window })}`
    );

    return String(field(answer, 'screen') ?? '').trimEnd();
  }

  if (POD_ACTIONS.some((known) => known === action)) {
    return podAction(deps, port, action ?? '', rest);
  }

  if (action === 'pod' && rest[0] === undefined) {
    throw new Error(USAGE);
  }

  const cookie = await signIn(deps, port);
  const answer = await call(
    deps,
    port,
    cookie,
    `/api/computers/diagnose?${query({
      computer: name,
      action,
      podId: action === 'pod' ? rest[0] : undefined,
      lines: action === 'log' ? rest[0] : undefined,
    })}`
  );

  return action === 'log' ? logLines(answer) : JSON.stringify(answer, null, 2);
};

export const registerComputerCommand = (program: Command): void => {
  program
    .command('computer')
    .description('Debug another computer: read it, pause or talk to its pods')
    .argument('[args...]', '<name> <action> [arguments]')
    .addHelpText('after', `\n${USAGE}`)
    .action(async (args: string[]) => {
      try {
        console.log(
          await runComputer(args, {
            env: process.env,
            fetch,
            mint: (port) =>
              mintLoginLink(mothershipDbPath(process.env), { port }),
          })
        );
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
};
