import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadMachineConfig } from '../../config/machineConfig';
import { saveClaudeToken } from '../../setup/connectClaude';
import { resumeStep } from '../../setup/firstRun';
import { askWhoInTerminal, connectTicketsInFolder } from '../connect';
import { registerInitCommand } from '../init';

/** A project folder and a LAMBDA_HOME of its own, as this run's. */
const terminal = () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pawnee-terminal-'))
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'pawnee-parks' })
  );
  const env = { LAMBDA_HOME: path.join(root, '.lambda-home') };

  return { root, env };
};

describe('setting up from the terminal', () => {
  const saved = { cwd: process.cwd(), home: process.env.LAMBDA_HOME };

  afterEach(() => {
    process.chdir(saved.cwd);
    process.env.LAMBDA_HOME = saved.home;
  });

  it('lambda init counts as the Project and Tickets steps', async () => {
    const { root, env } = terminal();
    process.env.LAMBDA_HOME = env.LAMBDA_HOME;
    process.chdir(root);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const program = new Command();
    registerInitCommand(program);

    await program.parseAsync([
      'node',
      'lambda',
      'init',
      '--name',
      'Leslie Knope',
    ]);

    expect(loadMachineConfig(env)?.firstRun?.projects[root]).toEqual({
      project: true,
      tickets: true,
    });

    // With Claude connected in the terminal too, nothing is left for /setup.
    saveClaudeToken('token', '2026-10-19T12:00:00.000Z', env);
    expect(resumeStep(loadMachineConfig(env))).toBeNull();
  });

  it('lambda connect linear counts, in a project setup never saw', async () => {
    const { root, env } = terminal();
    fs.writeFileSync(
      path.join(root, 'lambda.json'),
      '{\n  "tickets": { "source": "markdown" }\n}\n'
    );
    const fetch = jest.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ data: { viewer: { name: 'Leslie Knope' } } })
        )
    );
    const printed: string[] = [];

    expect(
      await connectTicketsInFolder(
        root,
        { source: 'linear', apiKey: ['lin', 'api', 'pawnee'].join('_') },
        {
          env,
          fetch,
          print: (line) => printed.splice(printed.length, 0, line),
          // A computer that isn't running Lambda: it can only say the command.
          you: null,
        }
      )
    ).toBe(0);
    expect(printed).toEqual([
      '✓ Connected as Leslie Knope',
      'Lambda builds only the tickets you report. If Leslie Knope is you, run lambda account alias add "Leslie Knope" on the computer running Lambda.',
    ]);
    expect(loadMachineConfig(env)?.firstRun?.projects[root]).toEqual({
      project: true,
      tickets: true,
    });
  });
});

describe('lambda connect asks whether the key’s login is you', () => {
  const LESLIE = { name: 'Leslie Knope', email: 'leslie@pawnee.gov' };
  const setUp = (options: { isYou?: boolean; answers?: string[] } = {}) => {
    const claimed: string[] = [];
    const printed: string[] = [];
    const asked: string[] = [];
    const answers = [...(options.answers ?? [])];

    return {
      claimed,
      printed,
      asked,
      run: (ask = true) =>
        askWhoInTerminal(LESLIE, 'Linear', {
          you: {
            isYou: () => options.isYou === true,
            claim: (alias) => {
              claimed.splice(claimed.length, 0, alias.value);
            },
          },
          ask: ask
            ? async (question) => {
                asked.splice(asked.length, 0, question);

                return answers.shift() ?? '';
              }
            : undefined,
          print: (line) => printed.splice(printed.length, 0, line),
        }),
    };
  };

  it('asks nothing about a login that is already yours', async () => {
    const setup = setUp({ isYou: true, answers: ['y'] });
    await setup.run();

    expect(setup.asked).toEqual([]);
    expect(setup.claimed).toEqual([]);
  });

  it('counts the login as yours on a yes', async () => {
    const setup = setUp({ answers: ['y'] });
    await setup.run();

    expect(setup.asked).toEqual([
      'Lambda builds only the tickets you report. Is Leslie Knope (leslie@pawnee.gov) you? [y/N] ',
    ]);
    expect(setup.claimed).toEqual(['leslie@pawnee.gov']);
    expect(setup.printed).toEqual([
      '✓ Tickets reported by leslie@pawnee.gov are yours',
    ]);
  });

  it('asks for your own email on a no, as for a build computer’s login', async () => {
    const setup = setUp({ answers: ['n', 'Leslie@Pawnee.gov '] });
    await setup.run();

    expect(setup.asked[1]).toBe('Your email in Linear (Enter to skip): ');
    expect(setup.claimed).toEqual(['leslie@pawnee.gov']);
  });

  it('counts nothing when the email is skipped', async () => {
    const setup = setUp({ answers: ['', ''] });
    await setup.run();

    expect(setup.claimed).toEqual([]);
    expect(setup.printed).toEqual([]);
  });

  it('says the command when there is no terminal to answer on', async () => {
    const setup = setUp();
    await setup.run(false);

    expect(setup.printed).toEqual([
      'Lambda builds only the tickets you report. If leslie@pawnee.gov is you, run lambda account alias add leslie@pawnee.gov',
    ]);
    expect(setup.claimed).toEqual([]);
  });
});
