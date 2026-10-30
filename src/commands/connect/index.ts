import { type Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import { Writable } from 'stream';

import { loadProjectConfig } from '../../config/projectConfig';
import { aliasOf } from '../../mothership/owner';
import {
  type ClaudeRun,
  createClaudeConnector,
  realSpawnPty,
} from '../../setup/connectClaude';
import { markProject } from '../../setup/firstRun';
import {
  type TicketsChoice,
  type TrackerLogin,
  connectTickets,
} from '../../setup/tickets';
import { renewsLine } from '../../setup/tokenExpiry';
import { youOnHost } from '../account';

/**
 * `lambda connect claude|linear|jira`: setup's Connect Claude and Tickets
 * steps, in a terminal. Claude runs the same pty code as the setup page,
 * echoing it here and passing keystrokes through; Linear and Jira check the
 * key with one read before anything is saved. Keys are read from stdin, never
 * taken as arguments, so they never land in shell history or `ps`.
 */

type Env = Record<string, string | undefined>;

const resultLine = (state: ClaudeRun): { line: string; code: number } =>
  state.phase === 'done'
    ? { line: `✓ Claude connected · ${renewsLine(state.expiresOn)}`, code: 0 }
    : {
        line:
          state.phase === 'failed'
            ? [state.message, ...state.lines].join('\n')
            : "Claude didn't connect.",
        code: 1,
      };

export const connectClaudeInTerminal = async (env: Env): Promise<number> => {
  const connector = createClaudeConnector({
    spawn: realSpawnPty,
    home: os.homedir(),
    env,
    echo: (data) => process.stdout.write(data),
  });
  const { stdin } = process;
  const onKeys = (data: Buffer) => connector.input(data.toString());

  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }

  stdin.on('data', onKeys);
  stdin.resume();
  connector.start();

  try {
    const { line, code } = resultLine(await connector.finished());
    console.log(`\n${line}`);

    return code;
  } finally {
    stdin.off('data', onKeys);

    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }

    stdin.pause();
  }
};

/** A line from stdin: asked for on a terminal, read whole from a pipe. */
export interface SecretIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  isTTY: boolean;
}

/**
 * A key typed at a terminal, never echoed: only the question is shown, so
 * the key stays out of the screen and its scrollback. Piped, it's stdin.
 */
export const readSecret = (
  question: string,
  io: SecretIo = {
    input: process.stdin,
    output: process.stdout,
    isTTY: process.stdin.isTTY === true,
  }
): Promise<string> =>
  new Promise((resolve) => {
    if (!io.isTTY) {
      const chunks: Buffer[] = [];
      io.input.on('data', (chunk: Buffer) =>
        chunks.splice(chunks.length, 0, chunk)
      );
      io.input.on('end', () =>
        resolve(Buffer.concat(chunks).toString('utf8').trim())
      );

      return;
    }

    io.output.write(question);
    const rl = readline.createInterface({
      input: io.input,
      // Everything readline would echo goes nowhere.
      output: new Writable({ write: (_chunk, _encoding, done) => done() }),
      terminal: true,
    });
    rl.question('', (answer) => {
      rl.close();
      io.output.write('\n');
      resolve(answer.trim());
    });
  });

/** A question answered on the terminal, shown as typed. */
export const askLine = (question: string): Promise<string> =>
  new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

/** An argument a shell keeps whole: quoted when it has a space. */
const shellWord = (value: string): string =>
  /\s/.test(value) ? `"${value}"` : value;

/**
 * After a key connects: a computer builds only tickets its owner reported,
 * so a login that isn't the owner's yet is asked about. Yes counts it as
 * theirs; No asks for the one that is (a build computer's own login is a
 * No). Off the computer running Lambda, or with no terminal to answer on,
 * it says the command instead.
 */
export const askWhoInTerminal = async (
  login: TrackerLogin,
  tracker: 'Linear' | 'Jira',
  options: {
    you: ReturnType<typeof youOnHost>;
    ask?: (question: string) => Promise<string>;
    print: (line: string) => void;
  }
): Promise<void> => {
  const { you, ask, print } = options;
  const shown = login.email ?? login.name;
  const command = `lambda account alias add ${shellWord(shown)}`;

  if (you === null) {
    print(
      `Lambda builds only the tickets you report. If ${shown} is you, run ${command} on the computer running Lambda.`
    );

    return;
  }

  if (you.isYou(login)) {
    return;
  }

  if (ask === undefined) {
    print(
      `Lambda builds only the tickets you report. If ${shown} is you, run ${command}`
    );

    return;
  }

  const counts = (typed: string): void => {
    const alias = aliasOf(typed);

    if (alias !== null) {
      you.claim(alias);
      print(`✓ Tickets reported by ${alias.value} are yours`);
    }
  };
  const yes = await ask(
    `Lambda builds only the tickets you report. Is ${login.name}${
      login.email === null ? '' : ` (${login.email})`
    } you? [y/N] `
  );

  if (/^y(es)?$/i.test(yes)) {
    counts(shown);

    return;
  }

  counts(await ask(`Your email in ${tracker} (Enter to skip): `));
};

/** The Tickets step for the project in `cwd`. */
export const connectTicketsInFolder = async (
  cwd: string,
  choice: TicketsChoice,
  options: {
    env: Env;
    fetch?: typeof fetch;
    print: (line: string) => void;
    /** Asks on a terminal; left out (a piped key), the command is printed. */
    ask?: (question: string) => Promise<string>;
    you?: ReturnType<typeof youOnHost>;
  }
): Promise<number> => {
  const project = loadProjectConfig(cwd);

  if (project === null) {
    throw new Error("There's no lambda.json here. Run lambda init first.");
  }

  const outcome = await connectTickets(project.root, choice, {
    env: options.env,
    fetch: options.fetch,
    markStep: false,
  });

  if (!outcome.ok) {
    options.print(outcome.error);

    return 1;
  }

  // The terminal path through setup: this project and its tickets are set up.
  markProject(
    fs.realpathSync(project.root),
    { project: true, tickets: true },
    options.env
  );

  options.print(
    outcome.connectedAs === null
      ? `✓ Tickets live in ${choice.source}`
      : `✓ Connected as ${outcome.connectedAs}`
  );

  if (outcome.login !== null && choice.source !== 'markdown') {
    await askWhoInTerminal(
      outcome.login,
      choice.source === 'linear' ? 'Linear' : 'Jira',
      {
        you: options.you === undefined ? youOnHost(options.env) : options.you,
        ask: options.ask,
        print: options.print,
      }
    );
  }

  return 0;
};

export const registerConnectCommand = (program: Command): void => {
  const connect = program
    .command('connect')
    .description('Connect Claude, Linear or Jira on this computer');

  connect
    .command('claude')
    .description("Sign in to Claude for Lambda's agents (a one-year token)")
    .action(async () => {
      process.exitCode = await connectClaudeInTerminal(process.env);
    });

  connect
    .command('linear')
    .description("Use Linear for this codebase's tickets (key read from stdin)")
    .action(async () => {
      const apiKey = await readSecret('Linear API key: ');
      process.exitCode = await connectTicketsInFolder(
        process.cwd(),
        { source: 'linear', apiKey },
        {
          env: process.env,
          print: (line) => console.log(line),
          ask: process.stdin.isTTY === true ? askLine : undefined,
        }
      );
    });

  connect
    .command('jira')
    .description(
      "Use Jira for this codebase's tickets (API token read from stdin)"
    )
    .requiredOption('--site <url>', 'Your Jira site, an https:// address')
    .requiredOption('--email <email>', 'The email you sign in to Jira with')
    .action(async (options: { site: string; email: string }) => {
      const apiToken = await readSecret('Jira API token: ');
      process.exitCode = await connectTicketsInFolder(
        process.cwd(),
        { source: 'jira', site: options.site, email: options.email, apiToken },
        {
          env: process.env,
          print: (line) => console.log(line),
          ask: process.stdin.isTTY === true ? askLine : undefined,
        }
      );
    });
};
