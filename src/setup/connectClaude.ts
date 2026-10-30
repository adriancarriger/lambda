import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';

import { updateMachineConfig } from './firstRun';
import { expiresOn } from './tokenExpiry';

/**
 * Connect Claude: Lambda's agents run on Claude Code with the person's own
 * Claude account. If `claude` isn't on this machine, Anthropic's own
 * installer puts it there (Claude Code is never bundled or fetched from
 * anywhere else). Then `claude setup-token` runs in a hidden pty: it opens the
 * browser sign-in and prints a token that lasts a year, which is saved to
 * `~/.lambda/config.json` (0600).
 *
 * The token is never logged, never sent to the page (it gets "connected" and
 * the expiry date) and never put on a command line. One run at a time.
 */

type Env = Record<string, string | undefined>;

/** Anthropic's installer, exactly as Anthropic publishes it. */
export const INSTALLER_COMMAND =
  'curl -fsSL https://claude.ai/install.sh | bash';

/** Wide enough that the long token never wraps across lines. */
export const PTY_COLUMNS = 500;
export const PTY_ROWS = 40;

/** The installer's lines a failed step shows. */
export const FAILED_LINES = 20;

/** Built here, so no key-shaped literal sits in the source. */
export const TOKEN_PATTERN = new RegExp(
  `${['sk', 'ant', 'oat01'].join('-')}-[A-Za-z0-9_-]+`
);

const TOKEN_PREFIX = `${['sk', 'ant', 'oat01'].join('-')}-`;

const ALL_TOKENS = new RegExp(TOKEN_PATTERN.source, 'g');

const TOKEN_AT_END = new RegExp(`${TOKEN_PATTERN.source}$`);

/** Where a token that may go on in the next read starts, or the text's end. */
const heldFrom = (text: string): number => {
  const running = TOKEN_AT_END.exec(text);

  if (running !== null) {
    return running.index;
  }

  const start = [...TOKEN_PREFIX]
    .map((_, index) => TOKEN_PREFIX.length - index)
    .find((length) => text.endsWith(TOKEN_PREFIX.slice(0, length)));

  return text.length - (start ?? 0);
};

/**
 * The pty's output with the token as "(saved)", for a terminal. A token can
 * arrive split across reads, so a read's end that could still be part of one
 * waits for the next read (or the end) before it is shown.
 */
export const createTokenRedactor = () => {
  const seen = { text: '', shown: 0 };
  const shownUpTo = (end: number): string => {
    const redacted = seen.text.slice(0, end).replace(ALL_TOKENS, '(saved)');
    const next = redacted.slice(seen.shown);
    seen.shown = redacted.length;

    return next;
  };

  return {
    add: (data: string): string => {
      seen.text += data;

      return shownUpTo(heldFrom(seen.text));
    },
    flush: (): string => shownUpTo(seen.text.length),
  };
};

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/** Terminal colours and cursor moves, which a pty is full of. */
const ANSI = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(${BEL}|${ESC}\\\\)|${ESC}[@-_]`,
  'g'
);

export const stripAnsi = (text: string): string => text.replace(ANSI, '');

/** The token in the text, or null. Only once the process is done: it may still be arriving. */
export const findToken = (text: string): string | null =>
  TOKEN_PATTERN.exec(stripAnsi(text))?.[0] ?? null;

const COMPLETE_TOKEN = new RegExp(`${TOKEN_PATTERN.source}(?=[^A-Za-z0-9_-])`);

/** The token once something has followed it, so a token split across reads isn't cut short. */
export const findCompleteToken = (text: string): string | null =>
  COMPLETE_TOKEN.exec(stripAnsi(text))?.[0] ?? null;

/** The sign-in link `setup-token` prints, for a browser on another device. */
export const findSignInUrl = (text: string): string | null =>
  /https:\/\/[^\s"'<>]+/.exec(
    stripAnsi(text).replace(TOKEN_PATTERN, '')
  )?.[0] ?? null;

/** Does `setup-token` want a code pasted back? */
export const asksForCode = (text: string): boolean =>
  /paste\s+(the\s+)?code/i.test(stripAnsi(text));

/** The last `NN%` the installer printed. */
export const lastPercent = (text: string): number | null => {
  const all = [...stripAnsi(text).matchAll(/(\d{1,3})%/g)];
  const last = all.at(-1)?.[1];

  return last === undefined ? null : Math.min(100, Number(last));
};

/** Output as lines: carriage returns (progress redraws) split too. */
export const outputLines = (text: string): string[] =>
  stripAnsi(text)
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

export interface Pty {
  onData: (listener: (data: string) => void) => void;
  onExit: (listener: (event: { exitCode: number }) => void) => void;
  write: (data: string) => void;
  kill: () => void;
}

export type SpawnPty = (
  file: string,
  args: string[],
  options: { cols: number; rows: number; cwd: string; env: Env }
) => Pty;

export type ClaudeRun =
  | { phase: 'idle' }
  | { phase: 'installing'; percent: number | null; line: string }
  | { phase: 'signing-in'; url: string | null; needsCode: boolean }
  | {
      phase: 'failed';
      step: 'install' | 'sign-in';
      message: string;
      /** The installer's last lines (never `setup-token`'s output). */
      lines: string[];
    }
  | { phase: 'done'; expiresOn: string };

const isExecutable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);

    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** Where Anthropic's installer puts `claude`. */
export const installedClaudePath = (home: string): string =>
  path.join(home, '.local', 'bin', 'claude');

/** `claude` on PATH, else where the installer puts it; null when neither. */
export const resolveClaude = (env: Env, home: string): string | null => {
  const onPath = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir !== '')
    .map((dir) => path.join(dir, 'claude'))
    .find(isExecutable);

  if (onPath !== undefined) {
    return onPath;
  }

  const installed = installedClaudePath(home);

  return isExecutable(installed) ? installed : null;
};

/** Save the token as `tokens.claude`, and mark Connect Claude done. */
export const saveClaudeToken = (
  token: string,
  createdAt: string,
  env: Env = process.env
): void => {
  updateMachineConfig(
    (config) => ({
      ...config,
      tokens: { ...config.tokens, claude: { value: token, createdAt } },
      firstRun: { projects: {}, ...config.firstRun, claude: true },
    }),
    env
  );
};

export interface ConnectorDeps {
  spawn: SpawnPty;
  home: string;
  /** The env the installer and `claude` run with. */
  env: Env;
  now?: () => number;
  /** Saves the token; the default writes `~/.lambda/config.json`. */
  save?: (token: string, createdAt: string) => void;
  /** Something changed: the page re-reads the state. */
  onChange?: () => void;
  /** In a terminal: everything the pty prints, the token redacted. */
  echo?: (data: string) => void;
  /** How long a sign-in may wait for the person; default SIGN_IN_TIMEOUT_MS. */
  signInTimeoutMs?: number;
  /** How long the installer may take; default INSTALL_TIMEOUT_MS. */
  installTimeoutMs?: number;
}

/** A sign-in nobody finishes (the tab closed) is given up after this. */
export const SIGN_IN_TIMEOUT_MS = 15 * 60 * 1000;

/** An installer that hasn't finished by now has stalled. */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export interface ClaudeConnector {
  /** `busy` while a run is going: the route answers 409. */
  start: () => 'started' | 'busy';
  /** A pasted code for `setup-token`; false when nothing is asking. */
  sendCode: (code: string) => boolean;
  /** Keystrokes from a terminal, straight to the pty. */
  input: (data: string) => void;
  state: () => ClaudeRun;
  /** Resolves when the current run ends. */
  finished: () => Promise<ClaudeRun>;
}

export const NOT_SIGNED_IN =
  "Claude didn't finish signing in. Nothing was saved.";

export const INSTALL_FAILED = "Claude Code didn't install.";

export const SAVE_FAILED =
  "Claude signed in, but Lambda couldn't save it. Nothing was saved.";

export const createClaudeConnector = (deps: ConnectorDeps): ClaudeConnector => {
  const now = deps.now ?? Date.now;
  const save =
    deps.save ??
    ((token: string, createdAt: string) =>
      saveClaudeToken(token, createdAt, deps.env));
  const run: {
    state: ClaudeRun;
    running: boolean;
    pty: Pty | null;
    waiters: ((state: ClaudeRun) => void)[];
    /** How much sign-in output there is so far. */
    seenLength: number;
    /** Where to look for a paste prompt: after the last code sent. */
    promptFrom: number;
  } = {
    state: { phase: 'idle' },
    running: false,
    pty: null,
    waiters: [],
    seenLength: 0,
    promptFrom: 0,
  };

  const set = (state: ClaudeRun): void => {
    run.state = state;
    deps.onChange?.();
  };

  const finish = (state: ClaudeRun): void => {
    run.running = false;
    run.pty = null;
    set(state);
    const waiting = run.waiters;
    run.waiters = [];
    waiting.forEach((resolve) => resolve(state));
  };

  const ptyOptions = {
    cols: PTY_COLUMNS,
    rows: PTY_ROWS,
    cwd: deps.home,
    env: deps.env,
  };

  /** A pty that couldn't start fails its step; the run ends, so a retry can start. */
  const spawnFor = (
    step: 'install' | 'sign-in',
    file: string,
    args: string[]
  ): Pty | null => {
    try {
      return deps.spawn(file, args, ptyOptions);
    } catch (error) {
      finish({
        phase: 'failed',
        step,
        message: step === 'install' ? INSTALL_FAILED : NOT_SIGNED_IN,
        lines: [
          `Couldn't start ${path.basename(file)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      });

      return null;
    }
  };

  const signIn = (claude: string): void => {
    set({ phase: 'signing-in', url: null, needsCode: false });
    const pty = spawnFor('sign-in', claude, ['setup-token']);

    if (pty === null) {
      return;
    }

    const seen: { text: string; token: string | null } = {
      text: '',
      token: null,
    };
    const redactor = createTokenRedactor();
    const echo = (text: string): void => {
      if (text !== '') {
        deps.echo?.(text);
      }
    };
    run.pty = pty;
    run.seenLength = 0;
    run.promptFrom = 0;
    // Runs in the pty's exit handler or a timer: a throw there would escape
    // into the mothership and leave the run `busy` for good. The error stays
    // out of `lines`, which reach the page: it could quote the config file.
    const saveToken = (token: string): void => {
      const createdAt = new Date(now()).toISOString();

      try {
        save(token, createdAt);
      } catch {
        finish({
          phase: 'failed',
          step: 'sign-in',
          message: SAVE_FAILED,
          lines: [],
        });

        return;
      }

      finish({ phase: 'done', expiresOn: expiresOn(createdAt) });
    };
    const giveUp = setTimeout(() => {
      pty.kill();

      // Signed in already, and setup-token just hasn't exited: keep it.
      if (seen.token !== null) {
        saveToken(seen.token);

        return;
      }

      finish({
        phase: 'failed',
        step: 'sign-in',
        message: NOT_SIGNED_IN,
        lines: [],
      });
    }, deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS);
    giveUp.unref?.();

    pty.onData((data) => {
      seen.text += data;
      run.seenLength = seen.text.length;
      echo(redactor.add(data));
      seen.token = seen.token ?? findCompleteToken(seen.text);

      if (seen.token === null && run.state.phase === 'signing-in') {
        const url = findSignInUrl(seen.text);
        // Only a prompt printed after the last code sent asks again: the
        // echo of a pasted code mustn't bring the box back.
        const needsCode = asksForCode(seen.text.slice(run.promptFrom));

        if (url !== run.state.url || needsCode !== run.state.needsCode) {
          set({ phase: 'signing-in', url, needsCode });
        }
      }
    });
    pty.onExit(() => {
      clearTimeout(giveUp);

      // Given up on already: this run is over.
      if (run.pty !== pty) {
        return;
      }

      echo(redactor.flush());
      const token = seen.token ?? findToken(seen.text);

      if (token === null) {
        finish({
          phase: 'failed',
          step: 'sign-in',
          message: NOT_SIGNED_IN,
          lines: [],
        });

        return;
      }

      saveToken(token);
    });
  };

  const install = (): void => {
    set({ phase: 'installing', percent: null, line: '' });
    const pty = spawnFor('install', '/bin/bash', ['-c', INSTALLER_COMMAND]);

    if (pty === null) {
      return;
    }

    const seen = { text: '' };
    run.pty = pty;
    const giveUp = setTimeout(() => {
      pty.kill();
      finish({
        phase: 'failed',
        step: 'install',
        message: INSTALL_FAILED,
        lines: outputLines(seen.text).slice(-FAILED_LINES),
      });
    }, deps.installTimeoutMs ?? INSTALL_TIMEOUT_MS);
    giveUp.unref?.();

    pty.onData((data) => {
      seen.text += data;
      deps.echo?.(data);
      const percent = lastPercent(seen.text);
      const line = outputLines(seen.text).at(-1) ?? '';

      // Every change reaches every open page, which reloads its state: only
      // say so when what the page shows has changed.
      if (
        run.state.phase !== 'installing' ||
        run.state.percent !== percent ||
        run.state.line !== line
      ) {
        set({ phase: 'installing', percent, line });
      }
    });
    pty.onExit(({ exitCode }) => {
      clearTimeout(giveUp);

      // Given up on already: this run is over.
      if (run.pty !== pty) {
        return;
      }

      if (exitCode !== 0) {
        finish({
          phase: 'failed',
          step: 'install',
          message: INSTALL_FAILED,
          lines: outputLines(seen.text).slice(-FAILED_LINES),
        });

        return;
      }

      signIn(
        resolveClaude(deps.env, deps.home) ?? installedClaudePath(deps.home)
      );
    });
  };

  return {
    start: () => {
      if (run.running) {
        return 'busy';
      }

      run.running = true;
      const claude = resolveClaude(deps.env, deps.home);

      if (claude === null) {
        install();
      } else {
        signIn(claude);
      }

      return 'started';
    },
    sendCode: (code) => {
      if (
        run.pty === null ||
        run.state.phase !== 'signing-in' ||
        !run.state.needsCode
      ) {
        return false;
      }

      run.pty.write(`${code.trim()}\r`);
      run.promptFrom = run.seenLength;
      set({ ...run.state, needsCode: false });

      return true;
    },
    input: (data) => run.pty?.write(data),
    state: () => run.state,
    finished: () =>
      run.running
        ? new Promise((resolve) => {
            run.waiters = [...run.waiters, resolve];
          })
        : Promise.resolve(run.state),
  };
};

/** The real pty: `@lydell/node-pty`, which ships prebuilt binaries. */
export const realSpawnPty: SpawnPty = (file, args, options) => {
  // Loaded on first use: only setup needs it, and a native module that can't
  // load then fails Connect Claude, not the whole mothership.
  const pty: typeof import('@lydell/node-pty') =
    createRequire(__filename)('@lydell/node-pty');
  const child = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: Object.fromEntries(
      Object.entries(options.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
  });

  return {
    onData: (listener) => {
      child.onData(listener);
    },
    onExit: (listener) => {
      child.onExit(({ exitCode }) => listener({ exitCode }));
    },
    write: (data) => child.write(data),
    kill: () => child.kill(),
  };
};
