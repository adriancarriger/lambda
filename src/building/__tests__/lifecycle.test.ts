import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SETUP_DONE, machineHome } from '../../__tests__/machineHome';
import { type StartDeps, runStop } from '../../commands/start';
import { resolveTmuxSettings, tmuxTarget } from '../../commands/tmux';
import { createPodStore } from '../../pod-store';
import { usePodProject } from '../../pod/__tests__/podProject';
import { runPause, runResume } from '../../pod/lifecycle';
import { RELEASES_FILE } from '../driver';
import { runBuild, writeBuildingInstructions } from '../lifecycle';

/**
 * Building pods' tmux windows: in the pod's own `lambda-pod-<id>` session,
 * or in the codebase's `tmux.session` when lambda.json sets it, beside the
 * windows already there. tmux is a map of sessions to their windows; the
 * agents' launch and messages are faked.
 */

const sessions = new Map<string, string[]>();
/** `@lambda-pod` on a window, by `session:window`. */
const tags = new Map<string, string>();
/** Windows at a shell (nothing runs in them), by `session:window`. */
const shells = new Set<string>();
const launched: {
  list: { window: string; command: string; inPlace?: boolean }[];
} = {
  list: [],
};
/** Escape, by pane target. */
const escaped: string[] = [];
/** What reached the agents through the pod's thread. */
const sent: { target: string; text: string }[] = [];

const windowsOf = (session: string): string[] => sessions.get(session) ?? [];

/** The real `newWindowInOrder`'s placement, over a session's names. */
const placeInOrder = (
  names: string[],
  window: string,
  order: readonly string[]
): string[] => {
  const rank = order.indexOf(window);
  const lastBefore = names.reduce(
    (found, name, index) =>
      order.indexOf(name) !== -1 && order.indexOf(name) < rank ? index : found,
    -1
  );
  const firstAfter = names.findIndex((name) => order.indexOf(name) > rank);
  const at =
    lastBefore !== -1 ? lastBefore + 1 : firstAfter !== -1 ? firstAfter : 0;

  return [...names.slice(0, at), window, ...names.slice(at)];
};

jest.mock('../../pod/tmux', () => {
  const actual = jest.requireActual('../../pod/tmux');
  const opened = (args: { window: string; command: string }) => {
    launched.list = [
      ...launched.list,
      { window: args.window, command: args.command },
    ];
  };

  return {
    ...actual,
    hasSession: (session: string) => sessions.has(session),
    listWindows: (session: string) => windowsOf(session),
    hasWindow: (session: string, window: string) =>
      windowsOf(session).includes(window),
    windowCount: (session: string, window: string) =>
      windowsOf(session).filter((name) => name === window).length,
    newWindow: (args: { session: string; window: string; command: string }) => {
      sessions.set(args.session, [...windowsOf(args.session), args.window]);
      opened(args);
    },
    newWindowInOrder: (args: {
      session: string;
      window: string;
      command: string;
      order: readonly string[];
    }) => {
      sessions.set(
        args.session,
        placeInOrder(windowsOf(args.session), args.window, args.order)
      );
      opened(args);
    },
    respawnWindow: (args: {
      session: string;
      window: string;
      command: string;
    }) => {
      shells.delete(`${args.session}:${args.window}`);
      launched.list = [
        ...launched.list,
        { window: args.window, command: args.command, inPlace: true },
      ];
    },
    windowAtShell: (session: string, window: string) =>
      shells.has(`${session}:${window}`),
    sendKey: (target: string, key: string) => {
      if (key === 'Escape') {
        escaped.splice(escaped.length, 0, target);
      }
    },
    killSession: (session: string) => {
      sessions.delete(session);
    },
    killWindow: (target: string) => {
      const [session = '', window = ''] = target
        .replace(/^=/, '')
        .split(':')
        .map((part) => part.replace(/^=/, ''));
      sessions.set(
        session,
        windowsOf(session).filter((name) => name !== window)
      );
    },
    waitForAgentReady: async () => true,
    sleep: async () => undefined,
  };
});

jest.mock('../windows', () => {
  const actual = jest.requireActual('../windows');

  return {
    ...actual,
    tagPodWindow: (session: string, window: string, podId: string) => {
      tags.set(`${session}:${window}`, podId);
    },
    windowTag: (session: string, window: string) =>
      tags.get(`${session}:${window}`) ?? '',
    listPodWindows: (session: string, podId: string) =>
      actual.podWindowsOf(
        (sessions.get(session) ?? [])
          .map(
            (name: string) => `${name}\t${tags.get(`${session}:${name}`) ?? ''}`
          )
          .join('\n'),
        podId
      ),
  };
});

jest.mock('../../pod/messaging', () => ({
  ...jest.requireActual('../../pod/messaging'),
  sendMessage: async (
    _store: unknown,
    message: { target: string; text: string }
  ) => {
    sent.splice(sent.length, 0, { target: message.target, text: message.text });
  },
  deliverEntry: async () => undefined,
}));

/** `lambda stop`'s own tmux runner, over the same map. */
const fakeTmux: StartDeps['tmux'] = (args) => {
  const [command] = args;
  const target = (args[args.indexOf('-t') + 1] ?? '').replace(/^=/, '');

  if (command === 'list-sessions') {
    return [...sessions.keys()].join('\n');
  }

  if (command === 'list-windows') {
    return windowsOf(target)
      .map((name) =>
        args.some((arg) => arg.includes('@lambda-pod'))
          ? `${name}\t${tags.get(`${target}:${name}`) ?? ''}`
          : name
      )
      .join('\n');
  }

  if (command === 'kill-session') {
    sessions.delete(target);

    return '';
  }

  if (command === 'kill-window') {
    const [session = '', window = ''] = target
      .split(':')
      .map((part) => part.replace(/^=/, ''));
    sessions.set(
      session,
      windowsOf(session).filter((name) => name !== window)
    );

    return '';
  }

  return '';
};

const stopDeps = (startedFile: string): StartDeps => ({
  env: machineHome(SETUP_DONE),
  tmux: fakeTmux,
  processes: {
    isRunning: () => false,
    start: () => undefined,
    stop: () => undefined,
    service: {
      file: '',
      installed: () => false,
      install: () => undefined,
      remove: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    },
  },
  hostsMothership: false,
  linkOnHost: () => undefined,
  writeCurrent: () => undefined,
  clearCurrent: () => undefined,
  waitForMothership: async () => null,
  waitForConnected: async () => true,
  resumeAll: async () => undefined,
  runShell: async () => undefined,
  print: () => undefined,
  port: 0,
  startedFile,
});

const RUNNER = { id: 'r-leslie-mac', computer: "Leslie's Mac" };

const gitProject = (config: Record<string, unknown> = {}): string => {
  const root = usePodProject({ name: 'Pawnee Parks app', ...config });
  execFileSync('git', ['init', '-q'], { cwd: root });

  return root;
};

const build = (root: string, runner = RUNNER) =>
  runBuild({}, { projectRoot: root, runner, print: () => undefined });

const podsOf = (root: string) =>
  createPodStore(path.join(root, '.lambda', 'pods'));

beforeEach(() => {
  sessions.clear();
  tags.clear();
  shells.clear();
  escaped.splice(0, escaped.length);
  sent.splice(0, sent.length);
  launched.list = [];
  fs.rmSync(path.join(process.env.LAMBDA_HOME ?? '', 'building.json'), {
    force: true,
  });
});

describe('lambda pod build', () => {
  it('starts no pod for a read-only mirror, which could never take a ticket', async () => {
    const mirror = gitProject({
      name: 'Parks app (read-only)',
      tickets: { source: 'markdown', readOnly: true },
    });

    await expect(build(mirror)).rejects.toThrow(
      'Parks app (read-only) is read-only: it mirrors its tracker, so nothing is built from it.'
    );
    expect(podsOf(mirror).listPodIds()).toEqual([]);
    expect(sessions.size).toBe(0);
  });

  it('refuses a second building pod on the same computer', async () => {
    const bakery = gitProject({ name: 'Bakery site' });
    await build(bakery);
    const parks = gitProject();

    await expect(build(parks)).rejects.toThrow(
      "Leslie's Mac is already building Bakery site. Add another computer to build two tickets at once."
    );
    expect(podsOf(parks).listPodIds()).toEqual([]);
  });

  it('refuses the second of two starts that both passed the busy check', async () => {
    const bakery = gitProject({ name: 'Bakery site' });
    const parks = gitProject();
    const racing = { started: false };

    // The bakery's start runs to completion while the parks one is between
    // its busy check and its record.
    const parksStart = runBuild(
      {},
      {
        projectRoot: parks,
        runner: RUNNER,
        print: () => undefined,
        randomHex: () => {
          if (!racing.started) {
            racing.started = true;
            void runBuild(
              { launch: false },
              { projectRoot: bakery, runner: RUNNER, print: () => undefined }
            );
          }

          return 'a1b2';
        },
      }
    );

    await expect(parksStart).rejects.toThrow(
      "Leslie's Mac is already building Bakery site. Add another computer to build two tickets at once."
    );
    expect(podsOf(parks).listPodIds()).toEqual([]);
    expect(podsOf(bakery).listPodIds()).toHaveLength(1);
  });

  it('replaces a stale record only while holding its lock, so two starts never both take it', async () => {
    const bakery = gitProject({ name: 'Bakery site' });
    const ended = podsOf(bakery).requirePod(await build(bakery));
    podsOf(bakery).writePod({ ...ended, status: 'done' });
    // Another start is replacing the stale record right now.
    const lock = path.join(process.env.LAMBDA_HOME ?? '', 'building.json.lock');
    fs.writeFileSync(lock, '');
    const parks = gitProject();

    try {
      await expect(build(parks)).rejects.toThrow(
        'Another lambda pod build is starting on this computer'
      );
      expect(podsOf(parks).listPodIds()).toEqual([]);
    } finally {
      fs.rmSync(lock, { force: true });
    }

    await expect(build(parks)).resolves.toMatch(/^build-/);
  });

  it("leaves no pod behind when the codebase's own command would hide a locked step", async () => {
    const root = gitProject();
    fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'commands', 'check-ticket.md'),
      'Their own check-ticket.\n'
    );

    await expect(build(root)).rejects.toThrow(
      "would hide Lambda's own /check-ticket from the building pod"
    );
    expect(podsOf(root).listPodIds()).toEqual([]);
    expect(fs.readdirSync(path.join(root, '.lambda', 'managers'))).toEqual([
      '.gitignore',
    ]);
    // Nothing is building here, so a second try isn't refused as busy.
    fs.rmSync(path.join(root, '.claude', 'commands', 'check-ticket.md'));
    await expect(build(root)).resolves.toMatch(/^build-/);
    // The refused try wrote nothing the retry then takes for the codebase's.
    expect(
      execFileSync('git', ['status', '--porcelain', '--', '.claude'], {
        cwd: root,
        encoding: 'utf8',
      })
    ).toBe('');
  });

  it("keeps the codebase's own copy of a locked command named in building.ownCommands", async () => {
    const root = gitProject({ building: { ownCommands: ['check-ticket'] } });
    const file = path.join(root, '.claude', 'commands', 'check-ticket.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'Their own check-ticket.\n');

    await expect(build(root)).resolves.toMatch(/^build-/);
    expect(fs.readFileSync(file, 'utf8')).toBe('Their own check-ticket.\n');
  });

  it("adds the codebase's addendum after Lambda's manager instructions", async () => {
    const root = gitProject();
    fs.mkdirSync(path.join(root, '.lambda', 'building'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.lambda', 'building', 'manager.add.md'),
      'Water the memorial garden first.\n'
    );
    const store = podsOf(root);
    const pod = store.requirePod(await build(root));

    expect(
      fs.readFileSync(path.join(pod.managerCwd, 'CLAUDE.md'), 'utf8')
    ).toMatch(/\n\nWater the memorial garden first\.\n$/);
  });

  it('makes a paused pod with --paused, so it takes no ticket until resumed', async () => {
    const root = gitProject();
    const podId = await runBuild(
      { paused: true },
      { projectRoot: root, runner: RUNNER, print: () => undefined }
    );

    expect(podsOf(root).requirePod(podId).status).toBe('paused');
  });

  it('takes a fresh id when the first one it draws is taken', async () => {
    const root = gitProject();
    const store = podsOf(root);
    const taken = { id: 'build-aaaa' };
    store.writePod({
      ...store.requirePod(await build(root)),
      id: taken.id,
      status: 'done',
    });
    fs.rmSync(path.join(process.env.LAMBDA_HOME ?? '', 'building.json'), {
      force: true,
    });
    const draws = ['aaaa', 'bbbb'];

    const podId = await runBuild(
      {},
      {
        projectRoot: root,
        runner: RUNNER,
        print: () => undefined,
        randomHex: () => draws.shift() ?? 'zzzz',
      }
    );

    expect(podId).toBe('build-bbbb');
    expect(store.requirePod(taken.id).status).toBe('done');
  });

  it("works in the codebase's own checkout, with no worktree", async () => {
    const root = gitProject();
    const podId = await build(root);
    const pod = podsOf(root).requirePod(podId);

    expect(pod.devCwd).toBe(root);
    expect(pod.ownsWorktree).toBe(false);
    expect(pod.kind).toBe('building');
    expect(pod.runnerId).toBe(RUNNER.id);
    expect(
      execFileSync('git', ['worktree', 'list'], { cwd: root, encoding: 'utf8' })
        .trim()
        .split('\n')
    ).toHaveLength(1);
    expect(
      fs.readFileSync(
        path.join(root, '.lambda', 'managers', '.gitignore'),
        'utf8'
      )
    ).toBe('*\n');
    expect(
      fs.readFileSync(path.join(pod.managerCwd, 'CLAUDE.md'), 'utf8')
    ).toMatch(/^# Engineering manager/);
  });

  it('opens its windows in its own session without tmux.session', async () => {
    const root = gitProject();
    const podId = await build(root);
    const session = `lambda-pod-${podId}`;

    expect(windowsOf(session)).toEqual(['manager', 'qa', 'dev']);
    expect(
      tmuxTarget(
        'dev',
        resolveTmuxSettings(null, {
          POD_ID: podId,
          LAMBDA_PODS_ROOT: podsOf(root).root,
        })
      )
    ).toBe(`${session}:dev`);
  });

  it("says a window running the codebase's own program needs its agent running, since none is started in it", async () => {
    const root = gitProject({ tmux: { session: 'pawnee' } });
    sessions.set('pawnee', ['scratchPad', 'dev']);
    const printed: string[] = [];
    await runBuild(
      {},
      {
        projectRoot: root,
        runner: RUNNER,
        print: (line) => printed.splice(printed.length, 0, line),
      }
    );

    expect(printed).toContain(
      "  ⚠ No agent was started in dev: something of the project's runs there. Run Claude in it, or the Engineering manager has no dev to work with."
    );
  });

  it('leaves a window running the codebase’s own program, and opens the others in their places before it', async () => {
    const root = gitProject({ tmux: { session: 'pawnee' } });
    sessions.set('pawnee', ['scratchPad', 'web', 'dev']);
    const podId = await build(root);

    expect(windowsOf('pawnee')).toEqual([
      'scratchPad',
      'web',
      'manager',
      'qa',
      'dev',
    ]);
    expect(launched.list.map((one) => one.window)).toEqual(['manager', 'qa']);
    expect(
      tmuxTarget(
        'dev',
        resolveTmuxSettings(null, {
          POD_ID: podId,
          LAMBDA_PODS_ROOT: podsOf(root).root,
        })
      )
    ).toBe('pawnee:dev');
  });

  it('starts its agents in place in a manager, qa and dev at a shell, keeping their order', async () => {
    const root = gitProject({ tmux: { session: 'pawnee' } });
    sessions.set('pawnee', ['manager', 'qa', 'dev', 'scratchPad', 'web']);
    ['manager', 'qa', 'dev'].forEach((name) => shells.add(`pawnee:${name}`));
    const podId = await build(root);

    expect(windowsOf('pawnee')).toEqual([
      'manager',
      'qa',
      'dev',
      'scratchPad',
      'web',
    ]);
    expect(launched.list).toEqual([
      expect.objectContaining({ window: 'manager', inPlace: true }),
      expect.objectContaining({ window: 'dev', inPlace: true }),
      expect.objectContaining({ window: 'qa', inPlace: true }),
    ]);
    // The Engineering manager in `manager` is its own role.
    expect(launched.list[0]?.command).toContain(
      "POD_AGENT='engineering-manager'"
    );
    expect(
      ['manager', 'qa', 'dev'].map((name) => tags.get(`pawnee:${name}`))
    ).toEqual([podId, podId, podId]);
  });

  it('takes over the windows a building pod that ended left running', async () => {
    const root = gitProject({ tmux: { session: 'pawnee' } });
    sessions.set('pawnee', ['manager', 'qa', 'dev', 'scratchPad']);
    ['manager', 'qa', 'dev'].forEach((name) =>
      tags.set(`pawnee:${name}`, 'build-0ld0')
    );
    const podId = await build(root);

    expect(windowsOf('pawnee')).toEqual(['manager', 'qa', 'dev', 'scratchPad']);
    expect(launched.list.every((one) => one.inPlace === true)).toBe(true);
    expect(launched.list).toHaveLength(3);
    expect(tags.get('pawnee:manager')).toBe(podId);
  });
});

describe('stopping and pausing a building pod', () => {
  const explicit = async () => {
    const root = gitProject({ tmux: { session: 'pawnee' } });
    sessions.set('pawnee', ['scratchPad', 'web']);
    const podId = await build(root);
    // Opened by the pod's launcher, so tagged with its id.
    sessions.set('pawnee', [
      ...windowsOf('pawnee'),
      'product-manager',
      'ask-t1',
    ]);
    tags.set('pawnee:product-manager', podId);
    tags.set('pawnee:ask-t1', podId);
    // The agents' opening messages are the build's, not what's under test.
    sent.splice(0, sent.length);
    const started = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'started-')),
      'started.json'
    );

    return { root, podId, started };
  };

  it.each([false, true])(
    'lambda stop (all: %s) closes only its windows, keeps the session and leaves it active',
    async (all) => {
      const { root, podId, started } = await explicit();

      await runStop(root, { all }, stopDeps(started));

      expect(windowsOf('pawnee')).toEqual(['scratchPad', 'web']);
      expect(sessions.has('pawnee')).toBe(true);
      expect(podsOf(root).requirePod(podId).status).toBe('active');
    }
  );

  // A project whose services' windows share the building pod's session.
  it("lambda stop --all in a shared session leaves the codebase's service windows open", async () => {
    const root = gitProject({ tmux: { session: 'main' } });
    sessions.set('main', ['scratchPad', 'web', 'api']);
    await build(root);
    const started = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'started-')),
      'started.json'
    );

    await runStop(root, { all: true }, stopDeps(started));

    expect(windowsOf('main')).toEqual(['scratchPad', 'web', 'api']);
    expect(sessions.has('main')).toBe(true);
  });

  it('lambda stop keeps the current ticket’s claim: nothing released, so no other runner takes it', async () => {
    const { root, podId, started } = await explicit();
    podsOf(root).writeBuilding(podId, {
      runs: [
        {
          id: '3',
          title: 'Trail markers',
          step: 'test',
          attempt: 2,
          startedAt: '2026-10-23T09:30:00.000Z',
          claim: 'claimed',
        },
      ],
      upNext: [],
    });

    await runStop(root, { all: false }, stopDeps(started));

    expect(podsOf(root).readBuilding(podId).runs[0]?.claim).toBe('claimed');
    expect(
      fs.existsSync(path.join(root, '.lambda', 'pods', RELEASES_FILE))
    ).toBe(false);
  });

  it("lambda stop leaves the codebase's own windows the pod adopted, and an ended pod's names", async () => {
    const root = gitProject({ tmux: { session: 'pawnee' } });
    sessions.set('pawnee', ['scratchPad', 'dev']);
    const podId = await build(root);
    const started = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'started-')),
      'started.json'
    );
    const printed: string[] = [];

    await runStop(
      root,
      { all: false },
      {
        ...stopDeps(started),
        print: (line) => printed.splice(printed.length, 0, line),
      }
    );

    // Its own windows closed; the codebase's dev, which it adopted, stays.
    expect(windowsOf('pawnee')).toEqual(['scratchPad', 'dev']);
    expect(printed).toContain('✓ Stopped 1 Lambda');

    // Ended, its record still names the session: the codebase's own dev and
    // qa are never taken for its windows.
    const store = podsOf(root);
    store.writePod({ ...store.requirePod(podId), status: 'done' });
    sessions.set('pawnee', ['scratchPad', 'dev', 'qa']);
    printed.length = 0;

    await runStop(
      root,
      { all: false },
      {
        ...stopDeps(started),
        print: (line) => printed.splice(printed.length, 0, line),
      }
    );

    expect(windowsOf('pawnee')).toEqual(['scratchPad', 'dev', 'qa']);
    expect(printed).toEqual(['✓ Nothing was running']);
  });

  it('lambda stop counts two pods in one session once', async () => {
    const { root, podId, started } = await explicit();
    const store = podsOf(root);
    store.writePod({ ...store.requirePod(podId), id: 'build-ffff' });
    const printed: string[] = [];

    await runStop(
      root,
      { all: false },
      {
        ...stopDeps(started),
        print: (line) => printed.splice(printed.length, 0, line),
      }
    );

    expect(printed).toContain('✓ Stopped 1 Lambda');
    expect(windowsOf('pawnee')).toEqual(['scratchPad', 'web']);
  });

  const midTest = (root: string, podId: string) => {
    podsOf(root).writeBuilding(podId, {
      runs: [
        {
          id: '3',
          title: 'Trail markers',
          step: 'test',
          attempt: 2,
          startedAt: '2026-10-23T10:00:00.000Z',
          claim: 'claimed',
        },
      ],
      upNext: [],
    });
  };

  it('pauses and resumes mid-test, at the same step and attempt, its windows open throughout', async () => {
    const { root, podId } = await explicit();
    midTest(root, podId);
    process.env.LAMBDA_PODS_ROOT = podsOf(root).root;

    try {
      runPause(podId);
      expect(podsOf(root).requirePod(podId).status).toBe('paused');
      // The agents' windows stay, in their places; the Product manager's and
      // the ask fork's go.
      expect(windowsOf('pawnee')).toEqual([
        'manager',
        'qa',
        'dev',
        'scratchPad',
        'web',
      ]);
      expect(podsOf(root).readBuilding(podId).runs[0]?.claim).toBe('claimed');

      await runResume(podId);
      expect(podsOf(root).requirePod(podId).status).toBe('active');
      expect(windowsOf('pawnee')).toEqual([
        'manager',
        'qa',
        'dev',
        'scratchPad',
        'web',
      ]);
      // Nothing was started again: the agents were running all along.
      expect(launched.list).toHaveLength(3);
      expect(podsOf(root).readBuilding(podId).runs[0]).toMatchObject({
        step: 'test',
        attempt: 2,
        claim: 'claimed',
      });
      expect(podsOf(root).readBuilding(podId).pause).toBeUndefined();
    } finally {
      delete process.env.LAMBDA_PODS_ROOT;
    }
  });

  it('pausing stops only the agents mid-turn, and Resume tells the Engineering manager who it stopped', async () => {
    const { root, podId } = await explicit();
    midTest(root, podId);
    const store = podsOf(root);
    // The dev is mid-turn (a prompt after its last stop); qa and the
    // Engineering manager are idle.
    store.patchTurn(podId, 'dev', {
      startedAt: '2026-10-23T10:05:00.000Z',
      endedAt: '2026-10-23T10:01:00.000Z',
    });
    store.patchTurn(podId, 'qa', {
      startedAt: '2026-10-23T10:02:00.000Z',
      endedAt: '2026-10-23T10:03:00.000Z',
    });
    process.env.LAMBDA_PODS_ROOT = store.root;

    try {
      runPause(podId);

      expect(escaped).toEqual(['=pawnee:=dev']);
      expect(store.readBuilding(podId).pause).toMatchObject({
        interrupted: ['dev'],
        ticket: '3',
      });

      await runResume(podId);

      expect(sent).toEqual([
        {
          target: 'engineering-manager',
          text: expect.stringMatching(
            /^Resumed after a pause\. The pause stopped the dev mid-turn .* Carry on with 3 Trail markers at test, attempt 2: check the dev and qa first\.$/
          ),
        },
      ]);
    } finally {
      delete process.env.LAMBDA_PODS_ROOT;
    }
  });

  it('resuming with no ticket being built tells the Engineering manager nothing: the next pick-up does', async () => {
    const { root, podId } = await explicit();
    process.env.LAMBDA_PODS_ROOT = podsOf(root).root;

    try {
      runPause(podId);
      await runResume(podId);

      expect(escaped).toEqual([]);
      expect(sent).toEqual([]);
    } finally {
      delete process.env.LAMBDA_PODS_ROOT;
    }
  });

  it('a pod made paused starts Claude told nothing; Resume sends each agent its opening message', async () => {
    const root = gitProject({ tmux: { session: 'pawnee' } });
    sessions.set('pawnee', ['scratchPad', 'web']);
    sent.splice(0, sent.length);
    const podId = await runBuild(
      { paused: true },
      { projectRoot: root, runner: RUNNER, print: () => undefined }
    );
    process.env.LAMBDA_PODS_ROOT = podsOf(root).root;

    try {
      expect(launched.list).toHaveLength(3);
      expect(sent).toEqual([]);
      expect(podsOf(root).readBuilding(podId).unbriefed).toEqual([
        'engineering-manager',
        'dev',
        'qa',
      ]);

      await runResume(podId);

      expect(sent.map(({ target }) => target)).toEqual([
        'engineering-manager',
        'dev',
        'qa',
      ]);
      expect(sent[0]?.text).toContain('You are the ENGINEERING MANAGER');
      expect(podsOf(root).readBuilding(podId).unbriefed).toBeUndefined();
    } finally {
      delete process.env.LAMBDA_PODS_ROOT;
    }
  });

  it('pausing a pod in its own session keeps its windows open', async () => {
    const root = gitProject();
    const podId = await build(root);
    midTest(root, podId);
    process.env.LAMBDA_PODS_ROOT = podsOf(root).root;

    try {
      runPause(podId);

      expect(windowsOf(`lambda-pod-${podId}`)).toEqual([
        'manager',
        'qa',
        'dev',
      ]);
      expect(podsOf(root).readBuilding(podId).runs[0]?.claim).toBe('claimed');
    } finally {
      delete process.env.LAMBDA_PODS_ROOT;
    }
  });
});

describe("the building commands in the codebase's .claude/commands", () => {
  const commandsOf = (root: string) => path.join(root, '.claude', 'commands');
  const pod = (root: string) => {
    const managerCwd = path.join(root, '.lambda', 'managers', 'build-test');
    fs.mkdirSync(managerCwd, { recursive: true });

    return { id: 'build-test', devCwd: root, managerCwd };
  };

  it("rewrites Lambda's own earlier copy from Lambda's default, not from that copy", () => {
    const root = gitProject();
    writeBuildingInstructions(pod(root), 'Leslie Knope');
    writeBuildingInstructions(pod(root), 'Ron Swanson');

    const start = fs.readFileSync(
      path.join(commandsOf(root), 'start.md'),
      'utf8'
    );
    expect(start).toContain('Ron Swanson');
    expect(start).not.toContain('Leslie Knope');
  });

  it("keeps another pod's command files in the ignore list", () => {
    const root = gitProject();
    fs.mkdirSync(commandsOf(root), { recursive: true });
    fs.writeFileSync(path.join(commandsOf(root), 'pod-phase.md'), 'Ours.\n');
    fs.writeFileSync(
      path.join(commandsOf(root), '.gitignore'),
      '# Written by lambda pod for this worktree only.\n.gitignore\npod-phase.md\n'
    );

    writeBuildingInstructions(pod(root), 'Leslie Knope');

    const ignore = fs
      .readFileSync(path.join(commandsOf(root), '.gitignore'), 'utf8')
      .split('\n');
    expect(ignore).toContain('pod-phase.md');
    expect(ignore).toContain('start.md');
    expect(
      execFileSync('git', ['status', '--porcelain', '--', '.claude'], {
        cwd: root,
        encoding: 'utf8',
      })
    ).toBe('');
  });
});
