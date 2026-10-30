import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Pod, type PodStore, createPodStore } from '../../pod-store';
import { ensurePodRunning } from '../lifecycle';
import './podProject';

/**
 * A building pod with one role's window missing, doubled or at a shell:
 * only that role is put right. The healthy windows (and an ask fork beside
 * them) are never killed mid-turn. tmux is a list of windows with ids; the
 * launch and delivery are faked. The Engineering manager's window is
 * `manager`.
 */

const POD = 'pawnee-b3c4';
const SESSION = `lambda-pod-${POD}`;

interface FakeWindow {
  id: string;
  name: string;
  tag: string;
  /** At a shell: nothing runs in it. */
  shell?: boolean;
}

interface FakeTmux {
  windows: FakeWindow[];
  nextId: number;
  killedSessions: string[];
  killedWindows: string[];
  launched: string[];
}

const tmux: FakeTmux = {
  windows: [],
  nextId: 1,
  killedSessions: [],
  killedWindows: [],
  launched: [],
};

const open = (name: string, options: { shell?: boolean } = {}): void => {
  tmux.windows = [
    ...tmux.windows,
    { id: `@${tmux.nextId}`, name, tag: '', shell: options.shell },
  ];
  tmux.nextId += 1;
};

const windowOf = (agent: string): string =>
  agent === 'engineering-manager' ? 'manager' : agent;

const namesIn = (session: string): string[] =>
  session === SESSION ? tmux.windows.map((window) => window.name) : [];

jest.mock('../tmux', () => ({
  hasSession: (session: string) => namesIn(session).length > 0,
  hasWindow: (session: string, window: string) =>
    namesIn(session).includes(window),
  listWindows: (session: string) => namesIn(session),
  windowCount: (session: string, window: string) =>
    namesIn(session).filter((name) => name === window).length,
  killSession: (session: string) => {
    tmux.killedSessions = [...tmux.killedSessions, session];
    tmux.windows = session === SESSION ? [] : tmux.windows;
  },
  killWindow: (target: string) => {
    tmux.killedWindows = [...tmux.killedWindows, target];
    tmux.windows = tmux.windows.filter((window) => window.id !== target);
  },
  windowAtShell: (session: string, window: string) =>
    session === SESSION &&
    tmux.windows.some((one) => one.name === window && one.shell === true),
  sendKey: () => undefined,
  sendToPane: async () => undefined,
  sleep: async () => undefined,
}));

jest.mock('child_process', () => {
  const actual: typeof childProcess = jest.requireActual('child_process');

  return {
    ...actual,
    execFileSync: (
      file: string,
      args: string[],
      options: childProcess.ExecFileSyncOptionsWithStringEncoding
    ) => {
      if (file !== 'tmux' || args[0] !== 'list-windows') {
        return actual.execFileSync(file, args, options);
      }

      const format = args[args.indexOf('-F') + 1] ?? '';

      return tmux.windows
        .map((window) =>
          format
            .replace('#{window_id}', window.id)
            .replace('#{window_name}', window.name)
            .replace('#{@lambda-pod}', window.tag)
        )
        .join('\n');
    },
  };
});

jest.mock('../launch', () => ({
  DEV_BOOTSTRAP: () => '',
  MANAGER_BOOTSTRAP: () => '',
  writePodSettings: () => undefined,
  // As the real one: an open window is started in place, else a new one.
  launchAgent: async (args: { agent: string }) => {
    tmux.launched = [...tmux.launched, args.agent];
    const name = windowOf(args.agent);

    if (tmux.windows.some((window) => window.name === name)) {
      tmux.windows = tmux.windows.map((window) =>
        window.name === name ? { ...window, shell: false } : window
      );
    } else {
      open(name);
    }

    return true;
  },
}));

const delivered: string[] = [];

jest.mock('../messaging', () => ({
  sendMessage: async () => undefined,
  deliverEntry: async (_store: unknown, entry: { id: string }) => {
    delivered.splice(delivered.length, 0, entry.id);
  },
}));

const roots: string[] = [];

const seed = (): { store: PodStore; pod: Pod } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-building-'));
  roots.splice(roots.length, 0, root);
  const store = createPodStore(root);
  store.writePod({
    id: POD,
    slug: 'pawnee',
    kind: 'building',
    createdAt: '2026-10-03T00:00:00.000Z',
    status: 'active',
    phase: 1,
    completedCheckpoints: [],
    worktreePath: '/tmp/pawnee',
    ownsWorktree: false,
    managerCwd: '/tmp/pawnee',
    devCwd: '/tmp/pawnee',
    agentCommand: 'claude',
    sessions: { 'engineering-manager': 'em', dev: 'd', qa: 'q' },
  });

  return { store, pod: store.requirePod(POD) };
};

beforeEach(() => {
  tmux.windows = [];
  tmux.nextId = 1;
  tmux.killedSessions = [];
  tmux.killedWindows = [];
  tmux.launched = [];
  delivered.splice(0, delivered.length);
});

afterEach(() => {
  roots
    .splice(0, roots.length)
    .forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe('ensurePodRunning, building pod', () => {
  it('starts a missing role and leaves the healthy windows running', async () => {
    const { store, pod } = seed();
    open('manager');
    open('dev');
    open('ask-ron');

    const outcome = await ensurePodRunning(store, pod);

    expect(outcome.result).toBe('started');
    expect(tmux.killedSessions).toEqual([]);
    expect(tmux.killedWindows).toEqual([]);
    expect(tmux.launched).toEqual(['qa']);
    expect(namesIn(SESSION)).toEqual(['manager', 'dev', 'ask-ron', 'qa']);
  });

  it('starts an agent in its window at a shell, in place, and leaves the running ones', async () => {
    const { store, pod } = seed();
    open('manager', { shell: true });
    open('qa');
    open('dev', { shell: true });

    const outcome = await ensurePodRunning(store, pod);

    expect(outcome.result).toBe('started');
    expect(tmux.killedWindows).toEqual([]);
    expect(tmux.launched).toEqual(['engineering-manager', 'dev']);
    expect(namesIn(SESSION)).toEqual(['manager', 'qa', 'dev']);
  });

  it('leaves a pod whose three windows run their agents alone', async () => {
    const { store, pod } = seed();
    open('manager');
    open('qa');
    open('dev');

    const outcome = await ensurePodRunning(store, pod);

    expect(outcome.result).toBe('running');
    expect(tmux.launched).toEqual([]);
  });

  it('closes only a doubled role, by window id, and starts it once', async () => {
    const { store, pod } = seed();
    open('manager');
    open('dev');
    open('dev');
    open('qa');

    const outcome = await ensurePodRunning(store, pod);

    expect(outcome.result).toBe('started');
    expect(tmux.killedSessions).toEqual([]);
    expect(tmux.killedWindows).toEqual(['@2', '@3']);
    expect(tmux.launched).toEqual(['dev']);
    expect(namesIn(SESSION).sort()).toEqual(['dev', 'manager', 'qa']);
  });

  it('re-sends what its agents never took in, an answer sent while it was paused', async () => {
    const { store, pod } = seed();
    open('dev');
    [
      { id: 'em-answer', target: 'engineering-manager' },
      { id: 'qa-answer', target: 'qa' },
    ].forEach(({ id, target }) =>
      store.appendThread({
        id,
        podId: POD,
        from: 'human',
        mode: 'async',
        text: 'Ron decides: keep the parking lot.',
        wire: `/human-async q2 [m:${id}]`,
        target,
        createdAt: new Date().toISOString(),
      })
    );

    const outcome = await ensurePodRunning(store, pod);

    expect(outcome).toEqual({
      result: 'started',
      resent: ['em-answer', 'qa-answer'],
      errors: [],
    });
    expect(delivered).toEqual(['em-answer', 'qa-answer']);
    expect(store.readSteps(POD).at(-1)?.note).toBe(
      'Re-sent 2 message(s) the agents never took in.'
    );
  });
});
