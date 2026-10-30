import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { required } from '../../__tests__/required';
import { statusLines } from '../../commands/join';
import { writeMachineConfig } from '../../config/machineConfig';
import { tempHome } from '../../mothership/__tests__/harness';
import { writeRunnerStatus } from '../localFiles';
import {
  createProcesses,
  isLambdaProcess,
  runnerConnected,
  scriptPath,
} from '../processes';
import { type ServiceControl } from '../service';

/**
 * A pid file outlives its process (a reboot, a crash, a killed tmux): the pid
 * then belongs to something else. Lambda trusts a pid only when that process
 * is its own script.
 */
describe('trusting a pid file', () => {
  const fixture: { home?: string; child?: ChildProcess } = {};
  const home = (): string => required(fixture.home, 'home');
  const child = (): ChildProcess => required(fixture.child, 'child');
  const env = () => ({ LAMBDA_HOME: home() });

  beforeEach(() => {
    fixture.home = tempHome();
    // Some other long-running process of the same user.
    fixture.child = spawn('sleep', ['30'], { stdio: 'ignore' });
  });

  afterEach(() => {
    child().kill();
    fs.rmSync(home(), { recursive: true, force: true });
  });

  const writePid = (name: string, pid: number) =>
    fs.writeFileSync(path.join(home(), `${name}.pid`), String(pid));

  it("doesn't count a reused pid as the runner running", () => {
    writePid('runner', required(child().pid, 'pid'));

    expect(createProcesses(env()).isRunning('runner')).toBe(false);
    expect(
      isLambdaProcess(
        'runner',
        required(child().pid, 'pid'),
        () => `node ${scriptPath('runner')}`
      )
    ).toBe(true);
  });

  it("counts another checkout's build of Lambda as running, not just this one's", () => {
    const pid = required(child().pid, 'pid');
    const other = (script: string) => () => `node ${script}`;

    expect(
      isLambdaProcess(
        'mothership',
        pid,
        other('/tmp/wt-lambda/dist/mothership.js')
      )
    ).toBe(true);
    expect(
      isLambdaProcess(
        'mothership',
        pid,
        other(
          '/srv/pawnee/node_modules/@adriancarriger/lambda/dist/mothership.js'
        )
      )
    ).toBe(true);
    expect(
      isLambdaProcess(
        'mothership',
        pid,
        other('/srv/pawnee/dist/mothership.js')
      )
    ).toBe(false);
    expect(
      isLambdaProcess(
        'runner',
        pid,
        other('/tmp/wt-lambda/dist/mothership.js')
      )
    ).toBe(false);
  });

  it("never SIGTERMs a process that isn't Lambda's", async () => {
    writePid('mothership', required(child().pid, 'pid'));
    createProcesses(env(), { tmux: () => '' }).stop('mothership');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(child().exitCode).toBeNull();
    expect(child().signalCode).toBeNull();
  });

  it('counts the runner connected only while its own process is alive', () => {
    writeRunnerStatus(
      { connected: true, at: 'now', pid: required(child().pid, 'pid') },
      env()
    );

    expect(runnerConnected(env())).toBe(false);
    expect(runnerConnected(env(), () => true)).toBe(true);

    writeMachineConfig({ runner: { id: 'rnr_3f9a', keyPath: '/k' } }, env());
    expect(statusLines(env(), () => '')[1]).toBe('Connected   no');
  });
});

/**
 * From the app, the mothership and runner run on Electron's binary. A tmux
 * server the person already runs has its own environment, so the window has
 * to be given the app's: without ELECTRON_RUN_AS_NODE the binary starts as a
 * second app, not as Node.
 */
describe('starting the mothership from the app', () => {
  const fixture: { home?: string } = {};
  const home = (): string => required(fixture.home, 'home');

  beforeEach(() => {
    fixture.home = tempHome();
  });

  afterEach(() => {
    fs.rmSync(home(), { recursive: true, force: true });
  });

  const opened = (env: Record<string, string>): string[] => {
    const calls: string[][] = [];
    createProcesses(env, {
      tmux: (args) => {
        calls.splice(calls.length, 0, args);

        return args[0] === 'has-session' ? null : '';
      },
      isLambda: () => false,
    }).start('mothership');

    return required(
      calls.find((args) => args[0] === 'new-session'),
      'new-session'
    );
  };

  it("gives the window the app's environment, not the tmux server's", () => {
    const args = opened({
      LAMBDA_HOME: home(),
      ELECTRON_RUN_AS_NODE: '1',
      PATH: '/home/ann/.lambda/bin:/Applications/Lambda.app/tools/bin',
      LAMBDA_APP_BUNDLE: '/Applications/Lambda.app',
      PLAYWRIGHT_BROWSERS_PATH: '/home/ann/.lambda/browsers',
      GIT_EXEC_PATH: '/Applications/Lambda.app/tools/libexec/git-core',
    });

    expect(args.slice(-7, -1)).toEqual([
      '-e',
      'LAMBDA_APP_BUNDLE=/Applications/Lambda.app',
      '-e',
      'PLAYWRIGHT_BROWSERS_PATH=/home/ann/.lambda/browsers',
      '-e',
      'GIT_EXEC_PATH=/Applications/Lambda.app/tools/libexec/git-core',
    ]);
  });

  it('runs only the script as Node, not the shell left in its window', () => {
    const args = opened({
      LAMBDA_HOME: home(),
      ELECTRON_RUN_AS_NODE: '1',
      LAMBDA_APP_BUNDLE: '/Applications/Lambda.app',
    });
    const command = args.at(-1) ?? '';

    expect(args).not.toContain('ELECTRON_RUN_AS_NODE=1');
    expect(command.startsWith("env ELECTRON_RUN_AS_NODE='1' ")).toBe(true);
    expect(command.endsWith('; exec $SHELL')).toBe(true);
  });

  it('adds nothing for an npm install', () => {
    expect(
      opened({ LAMBDA_HOME: home(), PATH: '/usr/bin' }).includes('-e')
    ).toBe(false);
  });
});

/**
 * A joined computer's runner is a login service. One installed before the
 * service kept PATH can't find tmux, so starting it writes it again from
 * this environment rather than loading the old definition.
 */
describe('starting a runner that is a login service', () => {
  it('writes the service again from this environment, then loads it', () => {
    const home = tempHome();
    const calls: string[] = [];
    const service: ServiceControl = {
      file: path.join(home, 'dev.lambda.runner.plist'),
      installed: () => true,
      install: (command) => {
        calls.splice(calls.length, 0, `install ${command.join(' ')}`);
      },
      remove: () => undefined,
      start: () => {
        calls.splice(calls.length, 0, 'start');
      },
      stop: () => undefined,
    };

    createProcesses(
      { LAMBDA_HOME: home },
      { service, isLambda: () => false, tmux: () => null }
    ).start('runner');
    fs.rmSync(home, { recursive: true, force: true });

    expect(calls).toEqual([
      `install ${process.execPath} ${scriptPath('runner')}`,
    ]);
  });
});
