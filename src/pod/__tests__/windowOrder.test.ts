import * as childProcess from 'child_process';

import { newWindowInOrder, respawnWindow, windowAtShell } from '../tmux';

/**
 * A building pod's windows sit first in their session, in this order:
 * manager, qa, dev. `newWindowInOrder` puts a missing one in its place, and
 * `respawnWindow` starts a program in one that's open without moving it.
 * tmux is faked at the command line: no real server is ever reached.
 */

const ORDER = ['manager', 'qa', 'dev'];
const fake: { windows: string[]; calls: string[][]; display: string } = {
  windows: [],
  calls: [],
  display: '',
};

jest.mock('child_process', () => {
  const actual: typeof childProcess = jest.requireActual('child_process');

  return {
    ...actual,
    execFileSync: (file: string, args: string[]) => {
      if (file !== 'tmux') {
        throw new Error(`${file} was not expected`);
      }

      fake.calls = [...fake.calls, args];
      const [command] = args;

      if (command === 'has-session') {
        return '';
      }

      if (command === 'list-windows') {
        return fake.windows
          .map((name, index) => `@${index + 1}\t${name}`)
          .join('\n');
      }

      return command === 'display-message' ? fake.display : '';
    },
  };
});

beforeEach(() => {
  fake.windows = [];
  fake.calls = [];
  fake.display = '';
});

/** The new-window call's placement flag and target, e.g. ['-a', '@2']. */
const placement = (): string[] => {
  const call = fake.calls.find((args) => args[0] === 'new-window') ?? [];
  const at = call.findIndex((arg) => arg === '-a' || arg === '-b');

  return at === -1 ? [] : [call[at] ?? '', call[at + 2] ?? ''];
};

const open = (window: string, windows: string[]): void => {
  fake.windows = windows;
  newWindowInOrder({
    session: 'main',
    window,
    cwd: '/tmp/pawnee',
    command: 'claude',
    order: ORDER,
  });
};

describe('newWindowInOrder', () => {
  it('puts the first agent window before everything else in the session', () => {
    open('dev', ['shell', 'server']);

    expect(placement()).toEqual(['-b', '@1']);
  });

  it('puts a window after the last of the ones before it', () => {
    open('qa', ['manager', 'dev', 'shell']);

    expect(placement()).toEqual(['-a', '@1']);
  });

  it('puts a window before the first of the ones after it', () => {
    open('manager', ['shell', 'qa', 'dev']);

    expect(placement()).toEqual(['-b', '@2']);
  });

  it('opens any other window last, like tmux does', () => {
    open('product-manager', ['manager', 'qa', 'dev']);

    expect(placement()).toEqual([]);
    expect(fake.calls.at(-1)?.[0]).toBe('new-window');
  });
});

describe('respawnWindow', () => {
  it('starts the program in the open window, keeping it where it is', () => {
    respawnWindow({
      session: 'main',
      window: 'manager',
      cwd: '/tmp/pawnee/.lambda/managers/build-c0ff',
      command: 'claude',
    });

    const call = fake.calls.at(-1) ?? [];
    expect(call.slice(0, 6)).toEqual([
      'respawn-pane',
      '-k',
      '-t',
      '=main:=manager',
      '-c',
      '/tmp/pawnee/.lambda/managers/build-c0ff',
    ]);
    expect(call.at(-1)).toBe('claude');
  });
});

describe('windowAtShell', () => {
  it.each([
    ['zsh\t0', true],
    ['/bin/bash\t0', true],
    ['2.1.312\t1', true],
    ['2.1.312\t0', false],
    ['node\t0', false],
  ])('%s → %s', (display, atShell) => {
    fake.display = display;

    expect(windowAtShell('main', 'dev')).toBe(atShell);
  });
});
