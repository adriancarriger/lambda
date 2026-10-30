import { execFileSync } from 'child_process';
import * as fs from 'fs';

import { tempHome } from '../../mothership/__tests__/harness';
import { hasSession } from '../../pod/tmux';
import { createProcesses } from '../processes';
import { realTmux } from '../runtime';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFileSync: jest.fn(() => ''),
}));

const execFileSyncMock = jest.mocked(execFileSync);

/** The env each tmux client call was given. */
const tmuxEnvs = (): (NodeJS.ProcessEnv | undefined)[] =>
  execFileSyncMock.mock.calls
    .filter(([file]) => file === 'tmux')
    .map(([, , options]) =>
      typeof options === 'object' && options !== null && 'env' in options
        ? options.env
        : undefined
    );

describe("the app's ELECTRON_RUN_AS_NODE never reaches a tmux server", () => {
  const saved = process.env.ELECTRON_RUN_AS_NODE;
  const fixture: { home: string | null } = { home: null };

  beforeEach(() => {
    execFileSyncMock.mockClear();
    process.env.ELECTRON_RUN_AS_NODE = '1';
    fixture.home = tempHome();
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE;
    } else {
      process.env.ELECTRON_RUN_AS_NODE = saved;
    }

    if (fixture.home !== null) {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  const expectStripped = (): void => {
    const envs = tmuxEnvs();

    expect(envs.length).toBeGreaterThan(0);
    envs.forEach((env) => {
      expect(env).toBeDefined();
      expect(env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(env?.PATH).toBe(process.env.PATH);
    });
  };

  it("leaves it out of a pod's tmux calls", () => {
    hasSession('lambda-pod-ann');

    expectStripped();
  });

  it('leaves it out when the app starts the mothership', () => {
    createProcesses(
      { LAMBDA_HOME: fixture.home ?? '' },
      { isLambda: () => false }
    ).start('mothership');

    expectStripped();
  });

  it("leaves it out of the runner's tmux calls", () => {
    realTmux(['has-session', '-t', '=lambda']);

    expectStripped();
  });
});
