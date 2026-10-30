/**
 * The photo hook: lambda.json `commands.shot`, the project's own way to
 * photograph its app in one scenario. It is a shell template:
 *
 *   {scenario}  absolute path of the scenario file
 *   {id}        the scenario id
 *   {viewport}  desktop or phone
 *   {out}       absolute path of the PNG to write
 *
 * each shell-quoted. It runs through the shell from the checkout's root with
 * a 180-second timeout, and counts as a success only when it exits 0 and
 * `{out}` is a PNG (the signature, and an IHDR width and height above 0).
 * How the app is started and which code it shows is the hook's business.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';

import { shellQuote } from '../utils/run';
import type { Viewport } from './scenario';

export const SHOT_TIMEOUT_MS = 180_000;
/** How long after the hook exits its last output may still come in. */
const EXIT_GRACE_MS = 250;
/** How much of the hook's output a failure shows. */
export const TAIL_LINES = 20;

export const NO_PHOTO_HOOK =
  "This project has no photo hook (commands.shot in lambda.json), so Lambda can't photograph the app.";

export const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** The signature, then an IHDR chunk with a width and height above 0. */
export const isPng = (file: string): boolean => {
  try {
    const head = Buffer.alloc(24);
    const fd = fs.openSync(file, 'r');

    try {
      const read = fs.readSync(fd, head, 0, head.length, 0);

      return (
        read === head.length &&
        head.subarray(0, 8).equals(PNG_SIGNATURE) &&
        head.toString('ascii', 12, 16) === 'IHDR' &&
        head.readUInt32BE(16) > 0 &&
        head.readUInt32BE(20) > 0
      );
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
};

export interface ShotValues {
  scenario: string;
  id: string;
  viewport: Viewport;
  out: string;
}

const PLACEHOLDER = /\{(scenario|id|viewport|out)\}/g;

const isPlaceholder = (name: string): name is keyof ShotValues =>
  name === 'scenario' || name === 'id' || name === 'viewport' || name === 'out';

/** The hook's command line: each placeholder shell-quoted, in one pass. */
export const fillShotTemplate = (
  template: string,
  values: ShotValues
): string =>
  template.replace(PLACEHOLDER, (whole, name: string) =>
    isPlaceholder(name) ? shellQuote(values[name]) : whole
  );

export type HookResult =
  | { ok: true }
  | { ok: false; reason: string; tail: string[] };

export interface HookOptions {
  cwd: string;
  timeoutMs?: number;
  /** The hook's output as it comes, for whoever watches the pane. */
  showOutput?: (chunk: string) => void;
}

/** The last `count` lines of the hook's output, blank ones included. */
const tailOf = (output: string, count = TAIL_LINES): string[] => {
  const lines = output.split(/\r?\n/);
  // The newline that ends the output doesn't start another line.
  const whole = lines.at(-1) === '' ? lines.slice(0, -1) : lines;

  return whole.slice(-count);
};

/** The last line of a failed hook's output that isn't blank. */
export const lastWordsOf = (tail: string[]): string | undefined =>
  [...tail].reverse().find((line) => line.trim() !== '');

/** Ends the hook and everything it started (its own process group). */
const killGroup = (pid: number | undefined): void => {
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
};

/** Run the hook for one scenario; never throws. */
export const runPhotoHook = (
  template: string,
  values: ShotValues,
  options: HookOptions
): Promise<HookResult> =>
  new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? SHOT_TIMEOUT_MS;
    const output: { text: string } = { text: '' };
    const timedOut = { yes: false };
    // A group of its own, so a timeout ends what the shell started too.
    const child = spawn(fillShotTemplate(template, values), {
      cwd: options.cwd,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      output.text = `${output.text}${text}`.slice(-64_000);
      options.showOutput?.(text);
    };
    const timer = setTimeout(() => {
      timedOut.yes = true;
      killGroup(child.pid);
    }, timeoutMs);
    // Its own group doesn't hear Ctrl-C, so Lambda ends it on the way out,
    // then dies of the same signal.
    const onSignal = (signal: NodeJS.Signals): void => {
      killGroup(child.pid);
      release();
      process.kill(process.pid, signal);
    };
    const onExit = (): void => killGroup(child.pid);
    const release = (): void => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('exit', onExit);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('exit', onExit);
    const settle = (result: HookResult): void => {
      clearTimeout(timer);
      release();
      resolve(result);
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) =>
      settle({
        ok: false,
        reason: `The photo hook couldn't start (${error.message}).`,
        tail: tailOf(output.text),
      })
    );
    child.on('exit', (code) => {
      clearTimeout(timer);
      const finished = { yes: false };
      // Its pipes can still hold its last lines: read them until they close,
      // or for a moment if something it left running (a server for later
      // shots) keeps them open, then let them go.
      const finish = (): void => {
        if (finished.yes) {
          return;
        }

        finished.yes = true;
        clearTimeout(grace);
        child.stdout.destroy();
        child.stderr.destroy();
        settle(resultOf(code));
      };
      const grace = setTimeout(finish, EXIT_GRACE_MS);
      child.once('close', finish);
    });
    const resultOf = (code: number | null): HookResult => {
      const tail = tailOf(output.text);

      if (timedOut.yes) {
        return {
          ok: false,
          reason: `The photo hook timed out after ${Math.round(
            timeoutMs / 1000
          )} seconds.`,
          tail,
        };
      }

      if (code !== 0) {
        return {
          ok: false,
          reason: `The photo hook failed (exit ${code ?? 'signal'}).`,
          tail,
        };
      }

      return isPng(values.out)
        ? { ok: true }
        : {
            ok: false,
            reason: `The photo hook exited 0 but didn't write a PNG to ${values.out}.`,
            tail,
          };
    };
  });

/** A failed hook's last line, for one-line reports. */
export const lastLineOf = (result: HookResult): string =>
  result.ok ? '' : lastWordsOf(result.tail) ?? result.reason;
