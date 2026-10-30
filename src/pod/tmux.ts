import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';

import { appWindowEnv, tmuxClientEnv } from '../desktop/bundledTools';

/**
 * tmux plumbing for pods: whole windows and sessions, and messages pasted into
 * an agent's input box. `lambda tmux` (commands/tmux) sends keystrokes to one
 * pane of the build session; pods need more than that, and only ever address
 * their own `lambda-pod-<id>` session.
 */

const tmux = (args: string[], input?: string): string =>
  execFileSync('tmux', args, {
    // tmux takes a new window's PATH from this, the client's environment.
    env: tmuxClientEnv(),
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const hasSession = (session: string): boolean => {
  try {
    tmux(['has-session', '-t', `=${session}`]);

    return true;
  } catch {
    return false;
  }
};

export const listWindows = (session: string): string[] => {
  if (!hasSession(session)) {
    return [];
  }

  return tmux(['list-windows', '-t', `=${session}`, '-F', '#{window_name}'])
    .split('\n')
    .filter((name) => name !== '');
};

export const hasWindow = (session: string, window: string): boolean =>
  listWindows(session).includes(window);

/**
 * Two windows with one name make `session:name` ambiguous, and tmux refuses
 * every target into either ("can't find window") — so a doubled pod can't be
 * sent anything at all.
 */
export const windowCount = (session: string, window: string): number =>
  listWindows(session).filter((name) => name === window).length;

/** Single-quote for the shell tmux runs window commands through. */
export const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

export const newSession = (args: {
  session: string;
  window: string;
  cwd: string;
  command: string;
}): void => {
  tmux([
    'new-session',
    '-d',
    '-s',
    args.session,
    '-n',
    args.window,
    '-c',
    args.cwd,
    ...appWindowEnv(process.env),
    // Sized to read comfortably in an agent panel.
    '-x',
    '120',
    '-y',
    '45',
    args.command,
  ]);
};

export const newWindow = (args: {
  session: string;
  window: string;
  cwd: string;
  command: string;
}): void => {
  if (!hasSession(args.session)) {
    newSession(args);

    return;
  }

  tmux([
    'new-window',
    '-d',
    '-t',
    `=${args.session}:`,
    '-n',
    args.window,
    '-c',
    args.cwd,
    ...appWindowEnv(process.env),
    args.command,
  ]);
};

/**
 * Run `command` in a window that's already there, in place of whatever runs
 * in it now: the window keeps its place in the session.
 */
export const respawnWindow = (args: {
  session: string;
  window: string;
  cwd: string;
  command: string;
}): void => {
  tmux([
    'respawn-pane',
    '-k',
    '-t',
    `=${args.session}:=${args.window}`,
    '-c',
    args.cwd,
    ...appWindowEnv(process.env),
    args.command,
  ]);
};

/**
 * A new window placed by `order` (window names): after the last of the ones
 * before it that's open, else before the first of the ones after it, else
 * first in the session. A name not in `order` goes last, like any new window.
 */
export const newWindowInOrder = (args: {
  session: string;
  window: string;
  cwd: string;
  command: string;
  order: readonly string[];
}): void => {
  const rank = args.order.indexOf(args.window);

  if (!hasSession(args.session) || rank === -1) {
    newWindow(args);

    return;
  }

  // By window id: two windows may share a name, and tmux refuses that name.
  const windows = tmux([
    'list-windows',
    '-t',
    `=${args.session}`,
    '-F',
    '#{window_id}\t#{window_name}',
  ])
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [id = '', name = ''] = line.split('\t');

      return { id, rank: args.order.indexOf(name) };
    });
  const before = windows.filter((one) => one.rank !== -1 && one.rank < rank);
  const after = windows.find((one) => one.rank > rank);
  const [where, target] =
    before.length > 0
      ? ['-a', before[before.length - 1]?.id]
      : ['-b', after?.id ?? windows[0]?.id];

  if (target === undefined) {
    newWindow(args);

    return;
  }

  tmux([
    'new-window',
    '-d',
    where,
    '-t',
    target,
    '-n',
    args.window,
    '-c',
    args.cwd,
    ...appWindowEnv(process.env),
    args.command,
  ]);
};

const SHELLS = ['zsh', 'bash', 'fish', 'sh', 'dash', 'login'];

/**
 * Is the window's pane at a shell (or dead)? Then nothing of anyone's runs
 * in it: an agent may be started there. Gone or unreadable: no.
 */
export const windowAtShell = (session: string, window: string): boolean => {
  try {
    const [command = '', dead = ''] = tmux([
      'display-message',
      '-p',
      '-t',
      `=${session}:=${window}`,
      '#{pane_current_command}\t#{pane_dead}',
    ])
      .trim()
      .split('\t');

    return (
      dead === '1' ||
      SHELLS.some((shell) => command === shell || command.endsWith(`/${shell}`))
    );
  } catch {
    return false;
  }
};

export const killSession = (session: string): void => {
  if (hasSession(session)) {
    tmux(['kill-session', '-t', `=${session}`]);
  }
};

export const killWindow = (target: string): void => {
  try {
    tmux(['kill-window', '-t', target]);
  } catch {
    // Already gone — that is the state the caller wanted.
  }
};

export const capturePane = (target: string, lines = 60): string =>
  tmux(['capture-pane', '-p', '-J', '-t', target, '-S', `-${lines}`]);

export const sendKey = (target: string, key: string): void => {
  tmux(['send-keys', '-t', target, key]);
};

/**
 * Deliver a message to an agent's input box and submit it.
 *
 * The body goes in through load-buffer + bracketed paste-buffer (-p), never
 * send-keys: long send-keys messages lose their head, and without bracketed
 * paste a newline in the body would submit early. A leading slash command is
 * typed literally first so the agent's TUI recognises it as a command even when
 * the pasted body collapses to a "[Pasted text]" placeholder.
 */
export const sendToPane = async (
  target: string,
  text: string
): Promise<void> => {
  const commandMatch = /^(\/[a-z0-9:-]+)( |$)/i.exec(text);
  const head = commandMatch === null ? '' : commandMatch[0];
  const body = text.slice(head.length);

  if (head !== '') {
    tmux(['send-keys', '-t', target, '-l', head]);
    await sleep(150);
  }

  if (body !== '') {
    const buffer = `pod-${randomBytes(4).toString('hex')}`;
    tmux(['load-buffer', '-b', buffer, '-'], body);
    tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', target]);
    await sleep(Math.min(2000, 400 + Math.floor(body.length / 10)));
  }

  sendKey(target, 'Enter');
};

/** Claude Code's folder-trust prompt. */
export const isTrustPrompt = (screen: string): boolean =>
  /trust/i.test(screen) && /(folder|files)/i.test(screen);

/**
 * The key that answers the trust prompt "yes": Enter once the highlighted
 * (`❯`) option is the yes one, else Down to move to it. Never Enter on
 * whatever is highlighted: its default is "No, exit", and an Enter there
 * quits the agent.
 */
export const trustAnswerKey = (screen: string): 'Enter' | 'Down' => {
  const highlighted = screen.split('\n').find((line) => /^\s*❯/.test(line));

  return highlighted !== undefined && /\byes\b/i.test(highlighted)
    ? 'Enter'
    : 'Down';
};

/** Keys tried on the trust prompt before leaving it to the timeout. */
const TRUST_KEYS_MAX = 4;

/**
 * Wait until a freshly launched agent can take input. Lambda marks a pod's
 * folder trusted before launching (claudeTrust.ts), so Claude Code's
 * folder-trust prompt is not expected; if it shows all the same, it is
 * answered yes, so `lambda pod new` and reboot resumes run unattended.
 */
export const waitForAgentReady = async (
  target: string,
  timeoutMs = 90_000
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;

  const poll = async (trustKeys: number): Promise<boolean> => {
    if (Date.now() > deadline) {
      return false;
    }

    const screen = (() => {
      try {
        return capturePane(target, 40);
      } catch {
        return '';
      }
    })();

    if (trustKeys < TRUST_KEYS_MAX && isTrustPrompt(screen)) {
      sendKey(target, trustAnswerKey(screen));
      await sleep(trustAnswerKey(screen) === 'Enter' ? 1500 : 300);

      return poll(trustKeys + 1);
    }

    // Ready = an empty input box at the BOTTOM, held across two captures. A
    // resumed or forked session replays its history first, full of old `❯`
    // lines — matching those pasted the warm-up into a TUI still loading, and
    // it was lost.
    if (inputReady(screen) && !/trust/i.test(screen)) {
      await sleep(700);
      const again = (() => {
        try {
          return capturePane(target, 40);
        } catch {
          return '';
        }
      })();

      if (inputReady(again) && again === screen) {
        return true;
      }
    }

    await sleep(1000);

    return poll(trustKeys);
  };

  return poll(0);
};

const RULE = /─{10,}/;

/** The input box: a `❯` line between two horizontal rules, near the bottom. */
export const inputReady = (screen: string): boolean => {
  const lines = screen.replace(/\s+$/, '').split('\n');
  const tail = lines.slice(-8);
  const prompt = tail.findIndex((line) => /^\s*❯/.test(line));

  return (
    prompt > 0 &&
    RULE.test(tail[prompt - 1] ?? '') &&
    RULE.test(tail[prompt + 1] ?? '')
  );
};
