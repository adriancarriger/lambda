import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The runner as a login service, so it's there whenever the computer is:
 * launchd on macOS, a systemd user unit on Linux. `lambda join` installs
 * it, `lambda leave` removes it.
 */

export const LAUNCHD_LABEL = 'dev.lambda.runner';
export const SYSTEMD_UNIT = 'lambda-runner.service';
const BOOTSTRAP_TRIES = 5;
const BOOTSTRAP_WAIT_MS = 300;

type Env = Record<string, string | undefined>;

export interface ServiceControl {
  /** Where its definition lives. */
  file: string;
  installed: () => boolean;
  install: (command: string[]) => void;
  remove: () => void;
  start: () => void;
  stop: () => void;
}

export type Exec = (command: string, args: string[]) => void;

const defaultExec: Exec = (command, args) => {
  execFileSync(command, args, { stdio: 'ignore' });
};

/** Block the (synchronous) install briefly: launchd unloads in the background. */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * One systemd value: quoted when it must be, with `\`, `"` and the `%`
 * specifier character escaped, so a path with a space stays one word. In a
 * command line (`exec`) a `$` is escaped too: there systemd expands `$NAME`.
 */
const systemdQuote = (value: string, exec = false): string => {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(/\$/g, () => (exec ? '$$' : '$'));

  return /[\s"\\%]/.test(value) ? `"${escaped}"` : escaped;
};

const xmlEscape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * What the service keeps from the environment it was installed from. PATH
 * too: launchd and systemd start it with only the system folders, where
 * tmux (Homebrew's, say) isn't, and pod actions need to find it.
 */
const SERVICE_ENV = ['LAMBDA_HOME', 'PATH'] as const;

const serviceEnv = (env: Env): [string, string][] =>
  SERVICE_ENV.flatMap((name): [string, string][] => {
    const value = env[name];

    return value === undefined ? [] : [[name, value]];
  });

export const launchdPlist = (
  command: string[],
  env: Env,
  logFile: string
): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...command.map((part) => `    <string>${xmlEscape(part)}</string>`),
    '  </array>',
    ...(serviceEnv(env).length === 0
      ? []
      : [
          '  <key>EnvironmentVariables</key>',
          '  <dict>',
          ...serviceEnv(env).map(
            ([name, value]) =>
              `    <key>${name}</key><string>${xmlEscape(value)}</string>`
          ),
          '  </dict>',
        ]),
    '  <key>RunAtLoad</key><true/>',
    // Back after a crash; not after `lambda stop --all` (a clean exit).
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    `  <key>StandardOutPath</key><string>${xmlEscape(logFile)}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');

export const systemdUnit = (command: string[], env: Env): string =>
  [
    '[Unit]',
    'Description=Lambda runner',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${command.map((word) => systemdQuote(word, true)).join(' ')}`,
    ...serviceEnv(env).map(
      ([name, value]) => `Environment=${systemdQuote(`${name}=${value}`)}`
    ),
    'Restart=on-failure',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');

export const createServiceControl = (
  options: {
    env?: Env;
    platform?: NodeJS.Platform;
    home?: string;
    exec?: Exec;
    uid?: number;
    /** For tests: the pause between bootstrap tries. */
    wait?: (ms: number) => void;
  } = {}
): ServiceControl => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const exec = options.exec ?? defaultExec;
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const wait = options.wait ?? sleepSync;
  const quietly = (command: string, args: string[]) => {
    try {
      exec(command, args);
    } catch {
      // Already stopped, or never loaded: either way it isn't running.
    }
  };

  if (platform === 'darwin') {
    const file = path.join(
      home,
      'Library',
      'LaunchAgents',
      `${LAUNCHD_LABEL}.plist`
    );
    const domain = `gui/${uid}`;
    // Right after a bootout the job can still be unloading ("Input/output
    // error"): tried again a few times before it counts as a failure.
    const bootstrap = (triesLeft = BOOTSTRAP_TRIES): void => {
      try {
        exec('launchctl', ['bootstrap', domain, file]);
      } catch (error) {
        if (triesLeft <= 1) {
          throw error;
        }

        wait(BOOTSTRAP_WAIT_MS);
        bootstrap(triesLeft - 1);
      }
    };

    return {
      file,
      installed: () => fs.existsSync(file),
      install: (command) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file,
          launchdPlist(
            command,
            env,
            path.join(home, 'Library', 'Logs', 'lambda-runner.log')
          )
        );
        quietly('launchctl', ['bootout', domain, file]);
        bootstrap();
      },
      remove: () => {
        quietly('launchctl', ['bootout', domain, file]);
        fs.rmSync(file, { force: true });
      },
      // Not loaded (booted out, or after a reboot that skipped it): load it,
      // which starts it (RunAtLoad); a failure there is a real one.
      start: () => {
        try {
          exec('launchctl', ['kickstart', `${domain}/${LAUNCHD_LABEL}`]);
        } catch {
          bootstrap();
        }
      },
      stop: () =>
        quietly('launchctl', ['kill', 'SIGTERM', `${domain}/${LAUNCHD_LABEL}`]),
    };
  }

  const file = path.join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT);

  return {
    file,
    installed: () => fs.existsSync(file),
    install: (command) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, systemdUnit(command, env));
      exec('systemctl', ['--user', 'daemon-reload']);
      exec('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
    },
    remove: () => {
      quietly('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
      fs.rmSync(file, { force: true });
      quietly('systemctl', ['--user', 'daemon-reload']);
    },
    start: () => quietly('systemctl', ['--user', 'start', SYSTEMD_UNIT]),
    stop: () => quietly('systemctl', ['--user', 'stop', SYSTEMD_UNIT]),
  };
};
