import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SETUP_DONE, machineHome } from '../../__tests__/machineHome';
import type { Processes } from '../../runner/processes';
import { FINISH_SETUP, type StartDeps, runStart, runStop } from '../start';
import { runUpgrade } from '../upgrade';

const fakeProcesses = () => {
  const running = new Set<string>();
  const processes: Processes = {
    isRunning: (name) => running.has(name),
    start: (name) => {
      running.add(name);
    },
    stop: (name) => {
      running.delete(name);
    },
    service: {
      file: '',
      installed: () => false,
      install: () => undefined,
      remove: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    },
  };

  return { processes, running };
};

const startDeps = (
  processes: Processes,
  overrides: Partial<StartDeps> = {}
): StartDeps & { printed: string[] } => {
  const printed: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-start-'));

  return {
    env: machineHome(SETUP_DONE),
    tmux: () => '',
    processes,
    hostsMothership: true,
    linkOnHost: () => undefined,
    writeCurrent: () => undefined,
    clearCurrent: () => undefined,
    waitForMothership: async () => null,
    waitForConnected: async () => true,
    resumeAll: async () => undefined,
    runShell: async () => undefined,
    print: (line) => printed.splice(printed.length, 0, line),
    port: 4580,
    startedFile: path.join(dir, 'started-windows.json'),
    printed,
    ...overrides,
  };
};

/** A folder with no lambda.json anywhere above it: the home folder, say. */
const noProject = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-no-project-'));

describe('lambda start before setup', () => {
  it('says to finish setup in the browser while firstRun.claude is unset, and still starts the mothership', async () => {
    const { processes, running } = fakeProcesses();
    // Project and tickets done, Claude not connected: firstRun.claude unset.
    const deps = startDeps(processes, {
      env: machineHome({
        firstRun: {
          projects: { '/home/leslie/pawnee': { project: true, tickets: true } },
        },
      }),
    });

    await runStart(noProject(), deps);

    expect(running.has('mothership')).toBe(true);
    expect(running.has('runner')).toBe(true);
    expect(deps.printed).toEqual([
      '✓ computer     connected',
      '✓ Lambda server http://127.0.0.1:4580',
      FINISH_SETUP,
    ]);
  });

  it('says nothing about setup once it is done', async () => {
    const { processes } = fakeProcesses();
    const deps = startDeps(processes, { env: machineHome(SETUP_DONE) });

    await runStart(noProject(), deps);

    expect(deps.printed).not.toContain(FINISH_SETUP);
  });

  it('still needs a project on a computer that only runs a runner', async () => {
    const { processes, running } = fakeProcesses();

    await expect(
      runStart(noProject(), startDeps(processes, { hostsMothership: false }))
    ).rejects.toThrow("There's no lambda.json here.");
    expect(running.size).toBe(0);
  });

  it('stops both with --all outside a project, as the Mac app does on Quit', async () => {
    const { processes, running } = fakeProcesses();
    const deps = startDeps(processes);
    await runStart(noProject(), deps);

    await runStop(noProject(), { all: true }, deps);

    expect(running.size).toBe(0);
    expect(deps.printed.at(-1)).toBe(
      "✓ Stopped this computer's runner and the Lambda server"
    );
  });
});

describe('lambda upgrade', () => {
  it('updates from npm for an npm install', async () => {
    const spawned: [string, string[]][] = [];

    await runUpgrade({}, async (command, args) => {
      spawned.splice(spawned.length, 0, [command, args]);

      return 0;
    });

    expect(spawned).toEqual([
      ['npm', ['i', '-g', '@adriancarriger/lambda@latest']],
    ]);
  });

  it("asks the Mac app to check for updates through the app's shim, and never runs npm", async () => {
    const spawned: [string, string[]][] = [];

    await runUpgrade(
      { LAMBDA_APP_BUNDLE: '/Applications/Lambda.app' },
      async (command, args) => {
        spawned.splice(spawned.length, 0, [command, args]);

        return 0;
      }
    );

    expect(spawned).toEqual([
      [
        'open',
        [
          '-n',
          '-a',
          '/Applications/Lambda.app',
          '--args',
          '--check-for-updates',
        ],
      ],
    ]);
  });
});
