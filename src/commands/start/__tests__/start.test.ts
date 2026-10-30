import * as fs from 'fs';
import * as path from 'path';

import { type StartDeps, runStart, runStop } from '..';
import { SETUP_DONE, machineHome } from '../../../__tests__/machineHome';
import { required } from '../../../__tests__/required';
import { tempHome } from '../../../mothership/__tests__/harness';
import { createPodStore } from '../../../pod-store';
import type { Processes } from '../../../runner/processes';

/** A tmux with sessions and windows, recording what was asked of it. */
const fakeTmux = (sessions: Record<string, string[]> = {}) => {
  const recorded: { calls: string[][] } = { calls: [] };
  const target = (value: string) => value.replace(/^=/, '').replace(/:$/, '');
  const run = (args: string[]): string | null => {
    recorded.calls = [...recorded.calls, args];
    const [command] = args;
    const flag = (name: string) => args[args.indexOf(name) + 1] ?? '';

    switch (command) {
      case 'list-windows': {
        const windows = sessions[target(flag('-t'))];

        return windows === undefined ? null : windows.join('\n');
      }
      case 'list-sessions':
        return Object.keys(sessions).join('\n');
      case 'new-session':
        sessions[flag('-s')] = [flag('-n')];

        return '';
      case 'new-window': {
        const key = target(flag('-t'));
        const windows = sessions[key];

        if (windows !== undefined) {
          sessions[key] = [...windows, flag('-n')];
        }

        return '';
      }
      case 'kill-window': {
        const [session, window] = target(flag('-t'))
          .split(':')
          .map((part) => part.replace(/^=/, ''));
        sessions[session ?? ''] = (sessions[session ?? ''] ?? []).filter(
          (name) => name !== window
        );

        return '';
      }
      case 'kill-session':
        delete sessions[target(flag('-t'))];

        return '';
      default:
        return '';
    }
  };

  return {
    run,
    get calls() {
      return recorded.calls;
    },
    sessions,
  };
};

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

describe('lambda start and lambda stop', () => {
  const fixture: { root?: string; home?: string } = {};
  const root = (): string => required(fixture.root, 'root');
  const home = (): string => required(fixture.home, 'home');

  beforeEach(() => {
    fixture.root = tempHome();
    fixture.home = tempHome();
  });

  afterEach(() => {
    fs.rmSync(root(), { recursive: true, force: true });
    fs.rmSync(home(), { recursive: true, force: true });
  });

  const writeConfig = (config: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(root(), 'lambda.json'),
      JSON.stringify({ name: 'Pawnee Parks site', ...config })
    );

  const deps = (
    tmux: ReturnType<typeof fakeTmux>,
    processes: Processes,
    overrides: Partial<StartDeps> = {}
  ): StartDeps & {
    printed: string[];
    resumed: string[];
    current: string[];
    cleared: string[];
  } => {
    const seen: {
      printed: string[];
      resumed: string[];
      current: string[];
      cleared: string[];
    } = {
      printed: [],
      resumed: [],
      current: [],
      cleared: [],
    };

    return {
      env: machineHome(SETUP_DONE),
      tmux: tmux.run,
      processes,
      hostsMothership: true,
      linkOnHost: () => undefined,
      writeCurrent: (folder) => {
        seen.current = [...seen.current, folder];
      },
      clearCurrent: (folder) => {
        seen.cleared = [...seen.cleared, folder];
      },
      waitForMothership: async () => null,
      waitForConnected: async () => true,
      resumeAll: async (folder) => {
        seen.resumed = [...seen.resumed, folder];
      },
      runShell: async () => undefined,
      print: (line) => {
        seen.printed = [...seen.printed, line];
      },
      port: 4580,
      startedFile: path.join(home(), 'started-windows.json'),
      get printed() {
        return seen.printed;
      },
      get resumed() {
        return seen.resumed;
      },
      get current() {
        return seen.current;
      },
      get cleared() {
        return seen.cleared;
      },
      ...overrides,
    };
  };

  it('opens one window per service, named after its key', async () => {
    writeConfig({
      commands: { services: { web: 'pnpm dev', api: 'pnpm api' } },
    });
    const tmux = fakeTmux();
    const { processes } = fakeProcesses();

    await runStart(root(), deps(tmux, processes));

    // And a scratchPad: the person's own shell in the project folder.
    expect(tmux.sessions.lambda).toEqual(['web', 'api', 'scratchPad']);
    expect(tmux.calls.find((args) => args[5] === 'scratchPad')).toEqual([
      'new-window',
      '-d',
      '-t',
      '=lambda:',
      '-n',
      'scratchPad',
      '-c',
      root(),
    ]);
    expect(tmux.calls.find((args) => args[0] === 'new-session')).toEqual([
      'new-session',
      '-d',
      '-s',
      'lambda',
      '-n',
      'web',
      '-c',
      root(),
      'pnpm dev',
    ]);
  });

  it("gives each window the app's bundle, whichever tmux server it lands on", async () => {
    writeConfig({
      commands: { services: { web: 'pnpm dev', api: 'pnpm api' } },
    });
    const tmux = fakeTmux();
    const { processes } = fakeProcesses();
    const app = {
      ...machineHome(SETUP_DONE),
      LAMBDA_APP_BUNDLE: '/Applications/Lambda.app',
    };

    await runStart(root(), deps(tmux, processes, { env: app }));

    const appEnv = ['-e', 'LAMBDA_APP_BUNDLE=/Applications/Lambda.app'];
    expect(
      tmux.calls
        .filter((args) => args[0] === 'new-session' || args[0] === 'new-window')
        .map((args) => args.slice(-3))
    ).toEqual([
      [...appEnv, 'pnpm dev'],
      [...appEnv, 'pnpm api'],
      // The scratchPad runs no command: the folder, then the env.
      [root(), ...appEnv],
    ]);
  });

  it('runs app.start as a web window when there are no services', async () => {
    writeConfig({
      app: { start: 'node server.mjs', url: 'http://localhost:5173' },
    });
    const tmux = fakeTmux();
    const { processes } = fakeProcesses();
    const run = deps(tmux, processes);

    await runStart(root(), run);

    expect(tmux.sessions.lambda).toEqual(['web', 'scratchPad']);
    expect(tmux.calls.find((args) => args[0] === 'new-session')?.at(-1)).toBe(
      'node server.mjs'
    );
    expect(run.printed).toEqual([
      '✓ web          http://localhost:5173',
      '✓ computer     connected',
      '✓ Lambda server http://127.0.0.1:4580',
    ]);
  });

  it('adopts an open window, and stop closes only what start opened', async () => {
    writeConfig({
      commands: { services: { web: 'pnpm dev', api: 'pnpm api' } },
    });
    // A scratchPad the project already has (its own dev setup's): adopted.
    const tmux = fakeTmux({ lambda: ['web', 'scratchPad'] });
    const { processes } = fakeProcesses();
    const run = deps(tmux, processes);

    await runStart(root(), run);

    expect(
      tmux.calls
        .filter((args) => args[0] === 'new-window')
        .map((args) => args[5])
    ).toEqual(['api']);

    await runStop(root(), { all: false }, run);

    expect(tmux.sessions.lambda).toEqual(['web', 'scratchPad']);
  });

  it('starts the runner and the mothership on the host, then resumes the pods', async () => {
    writeConfig({ app: { start: 'node server.mjs' } });
    const { processes, running } = fakeProcesses();
    const run = deps(fakeTmux(), processes);

    await runStart(root(), run);

    expect([...running].sort()).toEqual(['mothership', 'runner']);
    expect(run.current).toEqual([root()]);
    expect(run.resumed).toEqual([root()]);
  });

  it('runs only the runner on a computer that joined another', async () => {
    writeConfig({ app: { start: 'node server.mjs' } });
    const { processes, running } = fakeProcesses();

    await runStart(
      root(),
      deps(fakeTmux(), processes, { hostsMothership: false })
    );

    expect([...running]).toEqual(['runner']);
  });

  it('reports a mothership that failed to come up and stops there', async () => {
    writeConfig({ app: { start: 'node server.mjs' } });
    const { processes } = fakeProcesses();
    const line =
      "Can't listen on 127.0.0.1:4580: the port is in use. Set mothership.port in ~/.lambda/config.json.";
    const run = deps(fakeTmux(), processes, {
      waitForMothership: async () => line,
    });

    await expect(runStart(root(), run)).rejects.toThrow(line);
    expect(run.resumed).toEqual([]);
  });

  it('leaves the runner and mothership running on stop; --all stops both', async () => {
    writeConfig({ app: { start: 'node server.mjs' } });
    const { processes, running } = fakeProcesses();
    const run = deps(fakeTmux(), processes);
    await runStart(root(), run);

    await runStop(root(), { all: false }, run);

    expect([...running].sort()).toEqual(['mothership', 'runner']);

    await runStop(root(), { all: true }, run);

    expect([...running]).toEqual([]);
  });

  it("ends the codebase's pods' sessions but leaves each pod active", async () => {
    writeConfig({ app: { start: 'node server.mjs' } });
    const store = createPodStore(path.join(root(), '.lambda', 'pods'));
    store.writePod({
      id: 'dog-park',
      slug: 'dog-park',
      status: 'active',
      phase: 1,
      completedCheckpoints: [],
      createdAt: '2026-10-21T00:00:00.000Z',
      worktreePath: root(),
      ownsWorktree: false,
      managerCwd: root(),
      devCwd: root(),
      agentCommand: 'claude',
      sessions: { manager: 'm', dev: 'd' },
    });
    const tmux = fakeTmux({
      'lambda-pod-dog-park': ['manager', 'dev'],
      'lambda-pod-other': ['dev'],
    });
    const { processes } = fakeProcesses();
    const run = deps(tmux, processes);

    await runStop(root(), { all: false }, run);

    expect(Object.keys(tmux.sessions)).toEqual(['lambda-pod-other']);
    expect(store.requirePod('dog-park').status).toBe('active');
    expect(run.printed).toEqual(['✓ Stopped 1 Lambda']);
  });

  it("ends a done pod's own leftover session, never a shared one it names", async () => {
    writeConfig({ app: { start: 'node server.mjs' } });
    const store = createPodStore(path.join(root(), '.lambda', 'pods'));
    const done = (id: string, tmuxSession?: string) =>
      store.writePod({
        id,
        slug: id,
        status: 'done',
        phase: 1,
        completedCheckpoints: [],
        createdAt: '2026-10-21T00:00:00.000Z',
        worktreePath: root(),
        ownsWorktree: false,
        managerCwd: root(),
        devCwd: root(),
        agentCommand: 'claude',
        sessions: { manager: 'm', dev: 'd' },
        ...(tmuxSession === undefined ? {} : { tmuxSession }),
      });
    done('dog-park');
    done('lot-48', 'pawnee');
    const tmux = fakeTmux({
      'lambda-pod-dog-park': ['manager', 'dev'],
      pawnee: ['scratchPad', 'dev'],
    });
    const { processes } = fakeProcesses();

    await runStop(root(), { all: true }, deps(tmux, processes));

    expect(Object.keys(tmux.sessions)).toEqual(['pawnee']);
    expect(tmux.sessions.pawnee).toEqual(['scratchPad', 'dev']);
  });

  it("still stops everything when one pod's record can't be read, ending that pod's own session", async () => {
    writeConfig({ app: { start: 'node server.mjs' } });
    const store = createPodStore(path.join(root(), '.lambda', 'pods'));
    store.writePod({
      id: 'dog-park',
      slug: 'dog-park',
      status: 'active',
      phase: 1,
      completedCheckpoints: [],
      createdAt: '2026-10-21T00:00:00.000Z',
      worktreePath: root(),
      ownsWorktree: false,
      managerCwd: root(),
      devCwd: root(),
      agentCommand: 'claude',
      sessions: { manager: 'm', dev: 'd' },
    });
    const corrupt = store.file('lot-48', 'pod.json');
    fs.mkdirSync(path.dirname(corrupt), { recursive: true });
    fs.writeFileSync(corrupt, '{"id": "lot-48", ');
    const tmux = fakeTmux({
      'lambda-pod-dog-park': ['manager', 'dev'],
      'lambda-pod-lot-48': ['manager'],
      'lambda-pod-other': ['dev'],
    });
    const { processes, running } = fakeProcesses();
    const run = deps(tmux, processes);
    await runStart(root(), run);

    await runStop(root(), { all: true }, run);

    expect(Object.keys(tmux.sessions).sort()).toEqual([
      'lambda',
      'lambda-pod-other',
    ]);
    expect(run.cleared).toEqual([root()]);
    expect([...running]).toEqual([]);
    expect(run.printed).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^✗ Couldn't read pod lot-48 \(.+\): ending its session lambda-pod-lot-48$/
        ),
        '✓ Stopped web, scratchPad and 2 Lambdas',
      ])
    );
  });

  it('runs commands.stop instead of closing windows itself', async () => {
    writeConfig({
      app: { start: 'node server.mjs' },
      commands: { stop: 'docker compose down' },
    });
    const tmux = fakeTmux();
    const { processes } = fakeProcesses();
    const shell: { commands: string[] } = { commands: [] };
    const run = deps(tmux, processes, {
      runShell: async (command) => {
        shell.commands = [...shell.commands, command];
      },
    });
    await runStart(root(), run);

    await runStop(root(), { all: false }, run);

    expect(shell.commands).toEqual(['docker compose down']);
    expect(tmux.sessions.lambda).toEqual(['web', 'scratchPad']);
  });

  it('takes this computer off the project it stopped', async () => {
    writeConfig({ app: { start: 'node server.mjs' } });
    const { processes } = fakeProcesses();
    const run = deps(fakeTmux(), processes);

    await runStop(root(), { all: false }, run);

    expect(run.cleared).toEqual([root()]);
  });

  it('closes exactly the window start opened, never one whose name starts the same', async () => {
    writeConfig({ commands: { services: { web: 'pnpm dev' } } });
    const tmux = fakeTmux();
    const { processes } = fakeProcesses();
    const run = deps(tmux, processes);
    await runStart(root(), run);

    await runStop(root(), { all: false }, run);

    expect(tmux.calls.find((args) => args[0] === 'kill-window')).toEqual([
      'kill-window',
      '-t',
      '=lambda:=web',
    ]);
  });

  it("says a service tmux couldn't start, and doesn't count it as opened", async () => {
    writeConfig({
      commands: { services: { web: 'pnpm dev', api: 'pnpm api' } },
    });
    const tmux = fakeTmux();
    const refusing = (args: string[]): string | null =>
      args[0] === 'new-session' ? null : tmux.run(args);
    const { processes } = fakeProcesses();
    const run = deps(tmux, processes, { tmux: refusing });

    await runStart(root(), run);

    expect(run.printed.slice(0, 2)).toEqual([
      "✗ web          didn't start",
      "✗ api          didn't start",
    ]);
    const started = JSON.parse(
      fs.readFileSync(path.join(home(), 'started-windows.json'), 'utf8')
    );
    expect(started[root()].windows).toEqual([]);
  });
});
