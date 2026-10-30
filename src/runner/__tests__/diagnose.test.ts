import * as fs from 'fs';
import * as path from 'path';

import { tempHome } from '../../mothership/__tests__/harness';
import { type DiagnoseDeps, diagnose, findOnPath } from '../diagnose';

/**
 * What `lambda computer <name> <action>` reads on that computer: a fixed set
 * of reads, never a command line.
 */
describe('a computer diagnosing itself', () => {
  const made: string[] = [];
  const dir = (): string => {
    const one = tempHome();
    made.splice(made.length, 0, one);

    return one;
  };

  afterEach(() => {
    made
      .splice(0)
      .forEach((one) => fs.rmSync(one, { recursive: true, force: true }));
  });

  const deps = (extra: Partial<DiagnoseDeps> = {}): DiagnoseDeps => ({
    env: {},
    computer: 'Ann’s laptop',
    folder: '/home/ann/pawnee',
    podsRoot: () => '/nowhere',
    lambdaHome: '/nowhere',
    home: '/nowhere',
    ...extra,
  });

  const tool = (folder: string, name: string): string => {
    const file = path.join(folder, name);
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });

    return file;
  };

  it('says which tools its PATH finds, so a login service missing tmux shows', () => {
    const brew = dir();
    const tmux = tool(brew, 'tmux');
    const bare = diagnose({ action: 'status' }, deps({ env: { PATH: dir() } }));
    const full = diagnose(
      { action: 'status' },
      deps({ env: { PATH: `${dir()}:${brew}` } })
    );

    expect(bare).toMatchObject({
      computer: 'Ann’s laptop',
      folder: '/home/ann/pawnee',
      tools: { tmux: null },
    });
    expect(full).toMatchObject({ tools: { tmux } });
  });

  it('finds only a runnable file, the way spawn would', () => {
    const folder = dir();
    fs.writeFileSync(path.join(folder, 'tmux'), 'not runnable', {
      mode: 0o644,
    });
    fs.mkdirSync(path.join(folder, 'git'));

    expect(findOnPath('tmux', folder)).toBeNull();
    expect(findOnPath('git', folder)).toBeNull();
  });

  it("reads a pod's pod.json and building.json as they are on disk", () => {
    const pods = dir();
    fs.mkdirSync(path.join(pods, 'build-3f2c'));
    fs.writeFileSync(
      path.join(pods, 'build-3f2c', 'pod.json'),
      JSON.stringify({ id: 'build-3f2c', status: 'paused' })
    );
    fs.writeFileSync(
      path.join(pods, 'build-3f2c', 'building.json'),
      JSON.stringify({ current: { id: 'PAWNEE-5', step: 'build' } })
    );

    expect(
      diagnose(
        { action: 'pod', podId: 'build-3f2c' },
        deps({ podsRoot: () => pods })
      )
    ).toEqual({
      podId: 'build-3f2c',
      pod: { id: 'build-3f2c', status: 'paused' },
      building: { current: { id: 'PAWNEE-5', step: 'build' } },
    });
  });

  it('refuses a pod id that could reach outside the pods folder', () => {
    expect(() =>
      diagnose({ action: 'pod', podId: '../secrets' }, deps())
    ).toThrow('Not a pod id: ../secrets');
  });

  it('reads the end of whichever runner logs it has', () => {
    const home = dir();
    const lambda = dir();
    fs.mkdirSync(path.join(home, 'Library', 'Logs'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'Library', 'Logs', 'lambda-runner.log'),
      ['one', 'two', 'spawnSync tmux ENOENT', ''].join('\n')
    );

    expect(
      diagnose(
        { action: 'log', lines: '2' },
        deps({ home, lambdaHome: lambda })
      )
    ).toEqual({
      logs: [
        {
          file: path.join(home, 'Library', 'Logs', 'lambda-runner.log'),
          lines: ['two', 'spawnSync tmux ENOENT'],
        },
      ],
    });
  });

  it('reads its checkout through git, in the codebase it is on', () => {
    const asked: string[] = [];
    const answer = diagnose(
      { action: 'git' },
      deps({
        git: (args, cwd) => {
          asked.splice(asked.length, 0, `${cwd}: git ${args.join(' ')}`);

          return args[0] ?? '';
        },
      })
    );

    expect(answer).toEqual({
      folder: '/home/ann/pawnee',
      branch: 'branch',
      status: 'status',
      last: 'log',
    });
    expect(asked).toEqual([
      '/home/ann/pawnee: git branch --show-current',
      '/home/ann/pawnee: git status --porcelain=v1 --branch',
      '/home/ann/pawnee: git log -1 --format=%h %s (%cr)',
    ]);
  });

  it('runs nothing it was not built to: an unknown action is refused', () => {
    expect(() =>
      diagnose({ action: 'exec', command: 'rm -rf ~' }, deps())
    ).toThrow('Unknown diagnose action: exec');
  });
});
