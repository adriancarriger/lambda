import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';

import { required } from '../../__tests__/required';
import { POD_WINDOW_FORMAT } from '../../building/windows';
import { eventually, tempHome } from '../../mothership/__tests__/harness';
import {
  NEW_POD_TIMEOUT_MS,
  type PodHost,
  type PodHostDeps,
  createPodHost,
  podActionArgs,
} from '../podHost';
import { IDLE_MS, decideSwitch } from '../projectSwitch';

/** One project folder's pod host, with `lambda` and tmux faked. */
describe('a pod host', () => {
  const fixture: {
    home?: string;
    folders: string[];
    hosts: PodHost[];
    appBundle?: string;
  } = { folders: [], hosts: [] };
  const home = (): string => required(fixture.home, 'home');

  beforeEach(() => {
    fixture.home = tempHome();
    fixture.folders = [];
    fixture.hosts = [];
    // Set in every window the Mac app opens; it would fork the real Kokoro.
    fixture.appBundle = process.env.LAMBDA_APP_BUNDLE;
    delete process.env.LAMBDA_APP_BUNDLE;
  });

  afterEach(() => {
    if (fixture.appBundle !== undefined) {
      process.env.LAMBDA_APP_BUNDLE = fixture.appBundle;
    }

    jest.useRealTimers();
    fixture.hosts.forEach((host) => host.dispose());
    [home(), ...fixture.folders].forEach((dir) =>
      fs.rmSync(dir, { recursive: true, force: true })
    );
  });

  const project = (name: string): string => {
    const folder = tempHome();
    fs.writeFileSync(
      path.join(folder, 'lambda.json'),
      JSON.stringify({ name })
    );
    fixture.folders = [...fixture.folders, folder];

    return folder;
  };

  const make = (
    folder: string,
    overrides: Partial<PodHostDeps> = {}
  ): PodHost & { asked: () => string[][] } => {
    const asked: { calls: string[][] } = { calls: [] };
    const host = createPodHost({
      folder,
      lambda: async (args) => {
        asked.calls = [...asked.calls, args];

        return '';
      },
      spawnLambda: () => spawn('true'),
      tmux: () => '',
      onChange: () => undefined,
      log: () => undefined,
      isCurrent: () => true,
      env: { LAMBDA_HOME: home() },
      ...overrides,
    });
    fixture.hosts = [...fixture.hosts, host];

    return Object.assign(host, { asked: () => asked.calls });
  };

  it("runs no watchdog for a project this computer isn't on", () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const current = make(project('Pawnee Parks site'));
    const left = make(project('Sweetums recipe app'), {
      isCurrent: () => false,
    });

    jest.advanceTimersByTime(61_000);

    const watchdogs = (host: { asked: () => string[][] }) =>
      host.asked().filter((args) => args.join(' ') === 'pod fork watchdog');
    expect(watchdogs(current)).toHaveLength(2);
    expect(watchdogs(left)).toEqual([]);
  });

  it('counts arriving on a project as activity, so the idle switch waits 5 minutes', () => {
    const landed = Date.parse('2026-10-22T18:00:00Z');
    const host = make(project('Sweetums recipe app'), { now: () => landed });
    // Resumed or just made: no turn has ended and nothing was asked yet.
    host.store.writePod({
      id: 'nougat-tracker',
      slug: 'nougat-tracker',
      status: 'active',
      phase: 1,
      completedCheckpoints: [],
      createdAt: '2026-01-01T00:00:00Z',
      worktreePath: home(),
      ownsWorktree: false,
      managerCwd: home(),
      devCwd: home(),
      agentCommand: 'claude',
      sessions: { manager: 'm', dev: 'd' },
    });

    const activity = host.snapshots().pods.map((pod) => pod.activity);
    const waiting = [{ projectId: 'pawnee', createdAt: landed - 60_000 }];

    expect(activity).toEqual([
      { midTurn: false, openRequest: false, lastActivityAt: landed },
    ]);
    expect(decideSwitch({ now: landed + 60_000, activity, waiting })).toBe(
      null
    );
    expect(decideSwitch({ now: landed + IDLE_MS, activity, waiting })).toBe(
      'pawnee'
    );
  });

  it('shares one audio budget across every project on the computer', () => {
    const month = new Date().toISOString().slice(0, 7);
    fs.writeFileSync(
      path.join(home(), 'tts-usage.json'),
      JSON.stringify({ month, characters: 1000, usd: 3.5 })
    );

    const pawnee = make(project('Pawnee Parks site'));
    const sweetums = make(project('Sweetums recipe app'));

    expect(pawnee.snapshots().tts.usd).toBe(3.5);
    expect(sweetums.snapshots().tts.usd).toBe(3.5);
  });

  it('drains a background lambda pod, and says when one fails', async () => {
    const logs: { lines: string[] } = { lines: [] };
    // More output than a pipe holds: unread, the child blocks for ever.
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.stdout.write(Buffer.alloc(1 << 20), () => { process.stderr.write('no such pod'); process.exit(3); })",
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code))
    );
    const host = make(project('Pawnee Parks site'), {
      spawnLambda: () => child,
      log: (line) => {
        logs.lines = [...logs.lines, line];
      },
    });

    await host.handle('chat/warm', 'dog-park', {});
    const code = await Promise.race([
      exited,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('blocked'), 3000)
      ),
    ]);

    expect(code).toBe(3);
    // Logged on 'close' (its pipes drained), which can come after 'exit'.
    await eventually(() =>
      logs.lines.includes('lambda pod fork failed (exit 3): no such pod')
    );
  });

  it('says so when a new pod’s project could not be written to it', async () => {
    const logs: { lines: string[] } = { lines: [] };
    const host = make(project('Pawnee Parks site'), {
      // Says it made a pod whose file isn't there.
      spawnLambda: () =>
        spawn(
          process.execPath,
          ['-e', "console.log('Created Lambda ghost-pod')"],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        ),
      log: (line) => {
        logs.lines = [...logs.lines, line];
      },
    });

    await expect(
      host.newPod({ text: 'Dog park', freeform: false, single: false }, 'prj_1')
    ).resolves.toBe('ghost-pod');
    expect(logs.lines).toEqual([
      expect.stringMatching(/^ghost-pod's codebase wasn't saved to it: /),
    ]);
  });

  it('keeps running when watching its pods fails, and says so', () => {
    const logs: { lines: string[] } = { lines: [] };
    const watcher = Object.assign(new EventEmitter(), {
      close: () => undefined,
    });
    make(project('Pawnee Parks site'), {
      watch: () => watcher,
      log: (line) => {
        logs.lines = [...logs.lines, line];
      },
    });

    // EMFILE, ENOSPC, the folder removed: an 'error' nobody hears ends the runner.
    expect(() =>
      watcher.emit('error', new Error('EMFILE: too many open files'))
    ).not.toThrow();
    expect(logs.lines).toEqual([
      "Stopped watching the pods for changes: EMFILE: too many open files. They're still read every 5 seconds.",
    ]);
  });

  /** A lambda pod new whose exit, close and output come when the test says. */
  const fakeChild = (): ChildProcess => {
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    return child;
  };
  const tick = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve));
  const intake = { text: 'Nougat tracker', freeform: false, single: false };

  it('reads a new pod’s id that arrives after its exit (exit, then output, then close)', async () => {
    const child = fakeChild();
    const host = make(project('Sweetums recipe app'), {
      spawnLambda: () => child,
    });

    const made = host.newPod(intake);
    child.emit('exit', 0, null);
    await tick();
    child.stdout?.emit('data', Buffer.from('Created Lambda nougat-tracker\n'));
    child.emit('close', 0, null);

    await expect(made).resolves.toBe('nougat-tracker');
  });

  it('settles once whichever comes first, close or exit', async () => {
    const child = fakeChild();
    const host = make(project('Sweetums recipe app'), {
      spawnLambda: () => child,
    });

    const made = host.newPod(intake);
    child.stdout?.emit('data', Buffer.from('Created Lambda nougat-tracker\n'));
    child.emit('close', 0, null);
    child.emit('exit', 0, null);

    await expect(made).resolves.toBe('nougat-tracker');
  });

  it('fails with everything it said, once its output is closed, in either order', async () => {
    // Exit first: the rest of the output can still come, until close. Close
    // first: the output is complete by then (nothing comes after a close).
    const runs: { name: string; steps: ('part' | 'exit' | 'close')[] }[] = [
      {
        name: 'exit, then the rest, then close',
        steps: ['exit', 'part', 'close'],
      },
      { name: 'all of it, close, then exit', steps: ['part', 'close', 'exit'] },
    ];
    const results = await Promise.all(
      runs.map(async ({ name, steps }) => {
        const child = fakeChild();
        const host = make(project('Sweetums recipe app'), {
          spawnLambda: () => child,
        });
        // Its outcome is read from the start: it settles mid-steps.
        const settled = host.newPod(intake).then(
          () => 'resolved',
          (error: unknown) =>
            error instanceof Error ? error.message : String(error)
        );
        child.stderr?.emit('data', Buffer.from('lambda.json: name '));

        await steps.reduce(async (previous, step) => {
          await previous;

          if (step === 'part') {
            child.stderr?.emit('data', Buffer.from('is missing\n'));

            return;
          }

          child.emit(step, 1, null);
          await tick();
        }, Promise.resolve());

        const message = await settled;

        return { name, message };
      })
    );

    expect(results).toEqual(
      runs.map(({ name }) => ({
        name,
        message: 'lambda.json: name is missing',
      }))
    );
  });

  it("refuses a new pod whose lambda couldn't start, without crashing the runner", async () => {
    const host = make(project('Pawnee Parks site'), {
      spawnLambda: () => spawn('/no/such/lambda-binary'),
    });

    await expect(
      host.newPod({ text: 'Dog park', freeform: false, single: false })
    ).rejects.toThrow(/Couldn't run lambda pod new: .*ENOENT/);
  });

  it('gives up on a new pod that never says it was created', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const child = spawn('sleep', ['30']);
    const host = make(project('Pawnee Parks site'), {
      spawnLambda: () => child,
    });

    const made = host.newPod({
      text: 'Dog park',
      freeform: false,
      single: false,
    });
    jest.advanceTimersByTime(NEW_POD_TIMEOUT_MS + 1);

    await expect(made).rejects.toThrow("lambda pod new didn't answer.");
    expect(child.killed).toBe(true);
  });
  it('gives a resume long enough to start three agents, 90 seconds each', async () => {
    const asked: { timeouts: (number | undefined)[] } = { timeouts: [] };
    const host = make(project('Pawnee Parks site'), {
      lambda: async (_args, options) => {
        asked.timeouts = [...asked.timeouts, options.timeoutMs];

        return '';
      },
    });

    await host.handle('resume', 'build-pawnee', {});

    expect(asked.timeouts).toHaveLength(1);
    expect(asked.timeouts[0]).toBeGreaterThan(3 * 90_000);
  });

  it("counts only a pod's own tagged windows in a shared project session", () => {
    const listing = { text: 'scratchPad\t\nmap-server\t\n' };
    const host = make(project('Pawnee Parks site'), {
      tmux: (args) =>
        args.includes(POD_WINDOW_FORMAT)
          ? listing.text
          : 'scratchPad\nmap-server\n',
    });
    host.store.writePod({
      id: 'build-pawnee',
      slug: 'build-pawnee',
      status: 'paused',
      phase: 1,
      completedCheckpoints: [],
      createdAt: '2026-01-01T00:00:00Z',
      worktreePath: home(),
      ownsWorktree: false,
      managerCwd: home(),
      devCwd: home(),
      agentCommand: 'claude',
      sessions: { manager: 'm', dev: 'd' },
      tmuxSession: 'pawnee',
    });
    const running = () =>
      host.snapshots().pods.map((pod) => pod.summary.running);

    expect(running()).toEqual([false]);

    listing.text = 'scratchPad\t\ndev\tbuild-pawnee\n';
    expect(running()).toEqual([true]);
  });

  it("shows the codebase's and Lambda's windows in the Agents panel, read-only but for the scratchPad, and no others", async () => {
    const targets: string[] = [];
    const host = make(project('Pawnee Parks site'), {
      tmux: (args) => {
        const target = args[args.indexOf('-t') + 1] ?? '';
        targets.splice(targets.length, 0, target);

        if (args[0] === 'list-windows' && target === '=lambda') {
          // The codebase's session: its servers, and a building pod's dev.
          return '@3\tmap-server\t\n@4\tscratchPad\t\n@5\tdev\tbuild-pawnee\n';
        }

        if (args[0] === 'list-windows' && target === '=lambda-system') {
          return '@9\tmothership\t\n@10\trunner\t\n';
        }

        if (args[0] === 'list-windows') {
          return 'manager\ndev\n';
        }

        return args[0] === 'display-message' ? '120 45' : 'the screen';
      },
    });
    host.store.writePod({
      id: 'nougat-tracker',
      slug: 'nougat-tracker',
      status: 'active',
      phase: 1,
      completedCheckpoints: [],
      createdAt: '2026-01-01T00:00:00Z',
      worktreePath: home(),
      ownsWorktree: false,
      managerCwd: home(),
      devCwd: home(),
      agentCommand: 'claude',
      sessions: { manager: 'm', dev: 'd' },
    });
    host.store.patchTurn('nougat-tracker', 'dev', {
      startedAt: '2026-10-25T17:05:00.000Z',
    });

    expect(await host.handle('panes', 'nougat-tracker', {})).toEqual({
      others: [
        { id: '@3', name: 'map-server', group: 'project', typable: false },
        { id: '@4', name: 'scratchPad', group: 'project', typable: true },
        { id: '@9', name: 'mothership', group: 'lambda', typable: false },
        { id: '@10', name: 'runner', group: 'lambda', typable: false },
      ],
      working: ['dev'],
    });

    expect(host.termRead('nougat-tracker', '@3').screen).toBe('the screen');
    expect(targets).toContain('@3');
    // A pod's window, or any other session's, is never reached by id.
    expect(() => host.termRead('nougat-tracker', '@5')).toThrow(
      "isn't one of this codebase's or Lambda's"
    );
    expect(() => host.termRead('nougat-tracker', '@99')).toThrow(
      "isn't one of this codebase's or Lambda's"
    );
    expect(() => host.termKeys('nougat-tracker', '@3', ['61'])).toThrow(
      'read-only'
    );
    expect(() => host.termKeys('nougat-tracker', '@9', ['61'])).toThrow(
      'read-only'
    );
    // The codebase's scratchPad takes typing.
    expect(host.termKeys('nougat-tracker', '@4', ['61'])).toBe('ok');
    expect(targets).toContain('@4');
  });
});

describe('pod actions as lambda pod arguments', () => {
  it('ends the options before text that could start with a dash', () => {
    expect(
      podActionArgs('rename', { podId: 'dog-park', title: '--help' })
    ).toEqual(['rename', 'dog-park', '--', '--help']);
    expect(
      podActionArgs('fork/send', {
        podId: 'dog-park',
        qid: 'q1',
        text: '-1 is fine',
      })
    ).toEqual(['fork', 'send', 'dog-park', 'q1', '--', '-1 is fine']);
  });
});
