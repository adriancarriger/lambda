import * as fs from 'fs';

import { tempHome } from '../../mothership/__tests__/harness';
import { createServiceControl, systemdUnit } from '../service';

describe('the runner’s systemd unit', () => {
  it('keeps a home with a space, a quote or a % as one value', () => {
    const unit = systemdUnit(
      ['/usr/bin/node', '/home/leslie/Pawnee Parks/runner.js'],
      { LAMBDA_HOME: '/home/leslie/My "100%" Lambda' }
    );

    expect(unit).toContain(
      'ExecStart=/usr/bin/node "/home/leslie/Pawnee Parks/runner.js"'
    );
    expect(unit).toContain(
      'Environment="LAMBDA_HOME=/home/leslie/My \\"100%%\\" Lambda"'
    );
  });

  it('keeps a $ in the command literal, where systemd would expand it', () => {
    const unit = systemdUnit(['/usr/bin/node', '/home/ron/$WANSON/runner.js'], {
      LAMBDA_HOME: '/home/ron/$WANSON',
    });

    expect(unit).toContain(
      'ExecStart=/usr/bin/node /home/ron/$$WANSON/runner.js'
    );
    // Environment= doesn't expand variables: a $ there is already literal.
    expect(unit).toContain('Environment=LAMBDA_HOME=/home/ron/$WANSON');
  });

  it('keeps the PATH it was installed from, so it finds tmux', () => {
    const unit = systemdUnit(['/usr/bin/node', 'runner.js'], {
      PATH: '/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin',
    });

    expect(unit).toContain(
      'Environment=PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin'
    );
  });
});

describe('the runner’s launchd job', () => {
  const homes: { list: string[] } = { list: [] };
  const home = (): string => {
    const made = tempHome();
    homes.list = [...homes.list, made];

    return made;
  };

  afterEach(() => {
    homes.list.forEach((made) =>
      fs.rmSync(made, { recursive: true, force: true })
    );
    homes.list = [];
  });

  const control = (fails: (command: string, args: string[]) => boolean) => {
    const calls: { list: string[] } = { list: [] };
    const service = createServiceControl({
      platform: 'darwin',
      home: home(),
      env: {},
      uid: 501,
      wait: () => undefined,
      exec: (command, args) => {
        calls.list = [...calls.list, `${command} ${args[0] ?? ''}`];

        if (fails(command, args)) {
          throw new Error(`${command} ${args[0] ?? ''} failed`);
        }
      },
    });

    return { service, calls };
  };

  it('tries bootstrap again while the job it just booted out is still unloading', () => {
    const tries = { bootstrap: 0 };
    const { service, calls } = control((_command, args) => {
      if (args[0] !== 'bootstrap') {
        return false;
      }

      tries.bootstrap += 1;

      return tries.bootstrap < 3;
    });

    expect(() => service.install(['/usr/bin/node', 'runner.js'])).not.toThrow();
    expect(calls.list).toEqual([
      'launchctl bootout',
      'launchctl bootstrap',
      'launchctl bootstrap',
      'launchctl bootstrap',
    ]);
  });

  it('keeps the PATH it was installed from, so it finds Homebrew’s tmux', () => {
    const made = home();
    const service = createServiceControl({
      platform: 'darwin',
      home: made,
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', LAMBDA_HOME: '/l&h' },
      uid: 501,
      wait: () => undefined,
      exec: () => undefined,
    });
    service.install(['/usr/bin/node', 'runner.js']);
    const plist = fs.readFileSync(service.file, 'utf8');

    expect(plist).toContain(
      '<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>'
    );
    expect(plist).toContain('<key>LAMBDA_HOME</key><string>/l&amp;h</string>');
  });

  it('loads the job when it was not loaded, instead of starting nothing quietly', () => {
    const { service, calls } = control(
      (_command, args) => args[0] === 'kickstart'
    );
    service.install(['/usr/bin/node', 'runner.js']);
    calls.list = [];

    service.start();

    expect(calls.list).toEqual(['launchctl kickstart', 'launchctl bootstrap']);
  });

  it('says so when the job can be neither started nor loaded', () => {
    const { service } = control(
      (_command, args) => args[0] === 'kickstart' || args[0] === 'bootstrap'
    );

    expect(() => service.start()).toThrow('launchctl bootstrap failed');
  });
});
