import * as fs from 'fs';
import * as path from 'path';

import { MANIFEST, isPng } from '../app/server/podFile';
import { currentRun } from '../app/shared/building';
import { nowIso } from '../pod-store';
import { withFileLock } from '../pod-store/store';
import { callerPodId, openStore, resolvePodId } from '../pod/context';

/**
 * `lambda pod screenshot <file> --url <url> [--console <line>]…
 * --conclusion "<one line>" --passed|--failed`: qa records a test
 * screenshot. The PNG is copied into the pod's
 * `screenshots/<ticket>/<attempt>/`, beside that test attempt's
 * `manifest.json`; the Workflow rail shows it under Test. The pictures stay
 * on this computer: the app reads them through the runner.
 */

export const NOT_TESTING =
  "No ticket is being tested, so there's nothing to attach this screenshot to.";

/** Long enough for one copy; a dead writer's lock is taken over. */
const MANIFEST_LOCK = { timeoutMs: 10_000, staleMs: 30_000 };

/**
 * The name the copy is kept under: one the runner serves (letters, digits,
 * `.`, `_` and `-`, starting with a letter or digit), ending `.png`. A Mac's
 * "Screen Shot 2026-10-23 at 1.02 PM.png" becomes
 * `Screen-Shot-2026-10-23-at-1.02-PM.png`.
 */
const servableName = (file: string): string => {
  const base = path.basename(file);
  const stem = base
    .slice(0, base.length - path.extname(base).length)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[-.]+$/, '');

  return `${stem === '' ? 'screenshot' : stem}.png`;
};

/**
 * A name no other screenshot of the attempt has, on disk or in its
 * manifest: `pin.png`, `pin-2.png`.
 */
const freeName = (
  dir: string,
  taken: ReadonlySet<string>,
  wanted: string,
  n = 1
): string => {
  const name = n === 1 ? wanted : `${path.basename(wanted, '.png')}-${n}.png`;

  return taken.has(name) || fs.existsSync(path.join(dir, name))
    ? freeName(dir, taken, wanted, n + 1)
    : name;
};

export const runScreenshot = (
  podIdArg: string | undefined,
  file: string,
  options: {
    url?: string;
    console?: string[];
    conclusion?: string;
    passed?: boolean;
    failed?: boolean;
  }
): void => {
  const podId = resolvePodId(podIdArg ?? callerPodId());
  const store = openStore();

  if ((options.passed === true) === (options.failed === true)) {
    throw new Error(
      'Say whether it passed: exactly one of --passed or --failed.'
    );
  }

  if (options.url === undefined || options.url.trim() === '') {
    throw new Error('Give the --url the screenshot shows.');
  }

  if (options.conclusion === undefined || options.conclusion.trim() === '') {
    throw new Error('Give the --conclusion: one line on what it shows.');
  }

  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${file} isn't there.`);
  }

  if (!isPng(file)) {
    throw new Error(`${file} isn't a PNG.`);
  }

  const run = currentRun(store.readBuilding(podId));
  const attempt =
    run === null
      ? 0
      : store.readSteps(podId).filter(
          (step) =>
            step.ticket === run.id &&
            step.step === 'test' &&
            step.event === 'start' &&
            // Only this run's, as `lambda pod step` numbers them: a ticket
            // set back to Ready starts again at attempt 1.
            Date.parse(step.at) >= Date.parse(run.startedAt)
        ).length;

  if (run === null || attempt === 0) {
    throw new Error(NOT_TESTING);
  }

  const dir = store.screenshotDir(podId, run.id, attempt);
  fs.mkdirSync(dir, { recursive: true });
  const { url, conclusion } = options;
  // qa's subagents can record at once: the read, the copy and the write go
  // together, or one's manifest entry is lost while its PNG stays.
  const name = withFileLock(path.join(dir, MANIFEST), MANIFEST_LOCK, () => {
    const recorded = store.readScreenshots(podId, run.id, attempt);
    const free = freeName(
      dir,
      new Set(recorded.map((shot) => shot.file)),
      servableName(file)
    );
    fs.copyFileSync(file, path.join(dir, free));
    store.writeScreenshots(podId, run.id, attempt, [
      ...recorded,
      {
        file: free,
        ticketId: run.id,
        attempt,
        url: url.trim(),
        consoleErrors: options.console ?? [],
        conclusion: conclusion.trim(),
        passed: options.passed === true,
        at: nowIso(),
      },
    ]);

    return free;
  });
  console.log(
    `Recorded ${name} for ${run.id}, test attempt ${attempt} (${
      options.passed === true ? 'passed' : 'failed'
    }).`
  );
};
